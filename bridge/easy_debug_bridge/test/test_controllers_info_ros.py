#!/usr/bin/env python3
"""Persistent controller query contract, isolated domain 218, no motion goals."""
import base64
import json
import os
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid


def wait_for(fn, timeout=15):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        value = fn()
        if value:
            return value
        time.sleep(.04)
    raise AssertionError('condition timed out')


class Client:
    def __init__(self, port):
        self.socket = socket.create_connection(('127.0.0.1', port), timeout=6)
        key = base64.b64encode(os.urandom(16)).decode()
        self.socket.sendall(('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                             'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\n\r\n' % key).encode())
        reply = b''
        while not reply.endswith(b'\r\n\r\n'):
            reply += self.read(1)
        assert b'101 Switching Protocols' in reply

    def read(self, count):
        data = b''
        while len(data) < count:
            part = self.socket.recv(count-len(data))
            if not part:
                raise RuntimeError('EOF')
            data += part
        return data

    def receive(self):
        payload = b''
        while True:
            first, second = self.read(2)
            size = second & 127
            if size == 126:
                size = struct.unpack('!H', self.read(2))[0]
            elif size == 127:
                size = struct.unpack('!Q', self.read(8))[0]
            assert first & 15 in (0, 1) and not second & 128
            payload += self.read(size)
            if first & 128:
                return json.loads(payload)

    def send(self, op='controllers_info', request_id=None, **fields):
        request_id = request_id or str(uuid.uuid4())
        data = json.dumps(dict(op=op, request_id=request_id, **fields)).encode()
        mask = os.urandom(4)
        header = bytes([129, 128 | len(data)]) if len(data) < 126 else bytes([129, 254]) + struct.pack('!H', len(data))
        self.socket.sendall(header + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(data)))
        return request_id

    def request(self, op='controllers_info', **fields):
        request_id = self.send(op, **fields)
        while True:
            reply = self.receive()
            if reply.get('request_id') == request_id or (op == 'hello' and reply.get('op') == 'hello'):
                return reply


def main(binary, mode=''):
    assert os.environ.get('ROS_DOMAIN_ID') == '218'
    robot = executor = thread = None
    if mode != '--unsupported':
        import rclpy
        from rclpy.node import Node
        from rclpy.executors import MultiThreadedExecutor
        from rclpy.callback_groups import ReentrantCallbackGroup
        from controller_manager_msgs.srv import ListControllers
        from controller_manager_msgs.msg import ControllerState

        class Robot(Node):
            def __init__(self):
                super().__init__('controllers_fixture')
                self.delay, self.active, self.empty = .8, True, False
                self.calls, self.active_calls = [], 0
                self.lock = threading.Lock()
                self.group = ReentrantCallbackGroup()
                self.restore()

            def restore(self):
                self.service = self.create_service(ListControllers, '/controller_manager/list_controllers', self.query, callback_group=self.group)

            def query(self, _, response):
                with self.lock:
                    self.calls.append(time.monotonic()); self.active_calls += 1
                    delay, active, empty = self.delay, self.active, self.empty
                try:
                    time.sleep(delay)
                    if not empty:
                        response.controller.append(ControllerState(name='arm_trajectory_controller',
                            type='joint_trajectory_controller/JointTrajectoryController', state='active' if active else 'inactive'))
                    return response
                finally:
                    with self.lock:
                        self.active_calls -= 1

        rclpy.init()
        robot = Robot(); executor = MultiThreadedExecutor(num_threads=6); executor.add_node(robot)
        thread = threading.Thread(target=executor.spin, daemon=True); thread.start()

    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1', 0)); port = reserve.getsockname()[1]
    clients = []
    with tempfile.TemporaryFile(mode='w+') as log:
        process = subprocess.Popen([binary, '--ros-args', '-p', 'port:=%d' % port], stdout=log, stderr=log)
        try:
            def connect():
                try:
                    return Client(port)
                except OSError:
                    return None
            ws = wait_for(connect); clients.append(ws)
            hello = ws.request('hello')
            assert hello['controllers_info_supported'] is (mode != '--unsupported'), hello
            for refresh in [False, True]:
                ws.send(request_id='x' * 129, refresh=refresh)
                invalid = ws.receive()
                assert invalid['op'] == 'controllers_info' and invalid['request_id'] == '' and invalid['query_state'] == 'error', invalid
                assert invalid['fresh'] is False and invalid['request_wait_ms'] == 0
            if mode == '--unsupported':
                for refresh in [False, True]:
                    reply = ws.request(refresh=refresh)
                    assert reply['op'] == 'controllers_info' and reply['supported'] is False and reply['query_state'] == 'unsupported', reply
                    assert not reply['fresh'] and not reply['available'] and not reply['has_snapshot'] and reply['snapshot_sequence'] == 0
                    assert 'snapshot_age_ms' not in reply and 'snapshot_time_ms' not in reply and reply['request_wait_ms'] == 0
                print('PASS: no-CM build advertises unsupported and always answers the op')
                return

            pending = wait_for(lambda: (lambda s: s if s['query_pending'] and not s['has_snapshot'] else False)(ws.request()))
            assert pending['snapshot_sequence'] == 0 and not pending['fresh'] and 'snapshot_age_ms' not in pending
            count = len(robot.calls)
            wait_for(lambda: len(robot.calls) == 1)
            count = len(robot.calls)
            for _ in range(10):
                ws.request(refresh=False)
            assert len(robot.calls) == count, 'Cache-only reads issued extra RPCs'
            assert ws.request()['query_pending'], 'Fixture must still have the pre-arrival request in flight'

            # These force requests arrive during an existing active query. They
            # must drain it, then coalesce a genuinely new inactive query.
            robot.active = False
            b = Client(port); c = Client(port); clients.extend([b, c])
            results = []
            def force(client):
                results.append(client.request(refresh=True))
            t1 = threading.Thread(target=force, args=(b,)); t2 = threading.Thread(target=force, args=(c,))
            t1.start(); t2.start(); t1.join(5); t2.join(5)
            assert len(results) == 2, results
            assert results[0]['snapshot_sequence'] == results[1]['snapshot_sequence'] == 2, results
            for result in results:
                assert result['fresh'] and result['available'] and result['controllers'][0]['state'] == 'inactive', result
                assert result['request_wait_ms'] > 500 and result['snapshot_age_ms'] < 300, result
            assert len(robot.calls) == count + 1, robot.calls
            robot.delay = 0.; robot.empty = True
            empty = ws.request(refresh=True)
            assert empty['fresh'] and empty['has_snapshot'] and empty['controllers'] == []
            robot.empty = False
            last = ws.request(refresh=True)
            assert last['controllers'][0]['state'] == 'inactive' and last['fresh']
            if mode == '--no-moveit':
                motion = ws.request('position_motion_info')
                assert not motion['available'] and '未编译' in motion['message'], motion

            # A timeout retains rows but immediately invalidates them for both
            # public availability and the shared Motion health source.
            robot.delay = 3.4
            timed = ws.request(refresh=True)
            assert timed['query_state'] == 'timeout' and not timed['fresh'] and not timed['available'], timed
            assert timed['controllers'] == last['controllers'] and timed['snapshot_sequence'] == last['snapshot_sequence']
            count = len(robot.calls)
            backoff = ws.request(refresh=True)
            assert not backoff['fresh'] and backoff['retry_after_ms'] > 0 and len(robot.calls) == count
            robot.delay = 0.; robot.active = True
            wait_for(lambda: (lambda s: s if s['fresh'] and s['controllers'][0]['state'] == 'active' else False)(ws.request()))
            time.sleep(.7)
            assert ws.request()['controllers'][0]['state'] == 'active', 'Late inactive response polluted cache'

            # Bound one owner's waiter flood; disconnect releases its interests.
            robot.delay = .5
            wait_for(lambda: ws.request()['query_pending'])
            flood = Client(port); clients.append(flood)
            ids = [flood.send(refresh=True) for _ in range(9)]
            rejected = flood.receive()
            assert rejected['request_id'] in ids and rejected['query_state'] == 'error' and '过多' in rejected['message'], rejected
            flood.socket.close()
            robot.delay = 0.
            assert ws.request(refresh=True)['fresh']

            # Service loss keeps the last successful rows and explicit reason.
            wait_for(lambda: robot.active_calls == 0 and time.monotonic() - robot.calls[-1] < .3)
            time.sleep(.15) # Allow rclpy to send the returned response before destroying its service handle.
            robot.destroy_service(robot.service)
            lost = wait_for(lambda: (lambda s: s if s['query_state'] == 'unavailable' else False)(ws.request()))
            assert not lost['fresh'] and lost['has_snapshot'] and lost['controllers']
            robot.restore()
            wait_for(lambda: ws.request()['fresh'])
            print('PASS: cold pending/cache dedup, after-arrival force barrier and multi-session dedup, request_wait, empty/inactive, timeout/backoff/late isolation, bounded waiters/disconnect, service loss/recovery')
        finally:
            for client in clients:
                client.socket.close()
            process.send_signal(signal.SIGINT)
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait()
            if executor:
                executor.shutdown(timeout_sec=5); thread.join(timeout=5); robot.destroy_node(); rclpy.shutdown()


if __name__ == '__main__':
    main(*sys.argv[1:])
