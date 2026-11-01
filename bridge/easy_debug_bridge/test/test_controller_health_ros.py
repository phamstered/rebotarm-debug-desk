#!/usr/bin/env python3
"""Real Bridge vs delayed mock controller service, isolated ROS domain only."""
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid

import rclpy
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from controller_manager_msgs.srv import ListControllers
from test_gripper_motion_ros import MockRobot, WebSocket, wait_for, GRIPPER


class HealthRobot(MockRobot):
    def __init__(self):
        self.delay = 0.
        self.active = True
        self.calls = []
        self.active_calls = 0
        self.lock = threading.Lock()
        super().__init__()
        self.destroy_service(self.service)
        self.health_group = ReentrantCallbackGroup()
        self.restore_service()

    def restore_service(self):
        self.service = self.create_service(ListControllers, '/controller_manager/list_controllers',
                                           self.controllers, callback_group=self.health_group)

    def controllers(self, request, response):
        with self.lock:
            self.calls.append(time.monotonic())
            self.active_calls += 1
            delay, active = self.delay, self.active
        try:
            time.sleep(delay)
            response = super().controllers(request, response)
            for c in response.controller:
                c.state = 'active' if active else 'inactive'
            return response
        finally:
            with self.lock:
                self.active_calls -= 1


def main(binary):
    assert os.environ.get('ROS_DOMAIN_ID') == '214', 'Isolated ROS_DOMAIN_ID=214 required'
    rclpy.init()
    robot = HealthRobot()
    executor = MultiThreadedExecutor(num_threads=6)
    executor.add_node(robot)
    thread = threading.Thread(target=executor.spin, daemon=True)
    thread.start()
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1', 0))
        port = reserve.getsockname()[1]
    with tempfile.TemporaryFile(mode='w+') as log:
        process = subprocess.Popen([binary, '--ros-args', '-p', 'port:=%d' % port,
                                    '-p', 'status_topic:=/stm32/status'], stdout=log, stderr=log)
        ws = None
        try:
            def connect():
                try:
                    return WebSocket(port)
                except OSError:
                    return None
            ws = wait_for(connect)
            info = lambda: ws.request('position_motion_info')
            def ready():
                return wait_for(lambda: info()['available'] and info()['gripper_available'], timeout=20)
            def move():
                return ws.request('position_move', command_id=str(uuid.uuid4()), confirmation='ARMED',
                                  joint_targets={GRIPPER: .03}, motion_duration_s=6.)
            ready()
            # Slow-but-valid service responses do not expire live feedback or flood logs.
            robot.delay = 1.3
            begin, count = time.monotonic(), len(robot.calls)
            while time.monotonic() - begin < 6:
                status = info()
                assert status['available'] and status['gripper_available'], status
                time.sleep(.1)
            assert len(robot.calls) - count <= 3, robot.calls
            slow = [e for e in info()['motion_logs'] if '响应较慢' in e['message']]
            assert len(slow) == 1, slow
            robot.delay = 0.
            wait_for(lambda: any('响应耗时已恢复正常' in e['message'] for e in info()['motion_logs']))

            # A late active result must not overwrite a newer inactive result.
            robot.delay = 3.6
            wait_for(lambda: '超时' in info()['message'])
            assert move().get('accepted') is False
            robot.active = False
            robot.delay = 0.
            wait_for(lambda: '未激活' in info()['message'])
            until = time.monotonic() + 1.5
            while time.monotonic() < until:
                status = info()
                assert not status['available'] and not status['gripper_available'], status
                time.sleep(.1)
            robot.active = True
            ready()

            # Persistent timeouts back off and produce one controller warning, no health duplicate.
            audit = info()
            cursor = audit['motion_log_cursor']
            count = len(robot.calls)
            robot.delay = 3.6
            until = time.monotonic() + 11
            failed = False
            while time.monotonic() < until:
                status = info()
                failed = failed or '超时' in status['message']
                if failed:
                    assert not status['available'] and not status['gripper_available'], status
                time.sleep(.1)
            starts = robot.calls[count:]
            assert 2 <= len(starts) <= 3, starts
            assert starts[1] - starts[0] >= 2.9, starts
            if len(starts) == 3:
                assert starts[2] - starts[1] >= 3.9, starts
            warnings = [e for e in info()['motion_logs'] if e['seq'] > cursor and '超时' in e['message']]
            assert len(warnings) == 1 and warnings[0]['phase'] == 'controller', warnings
            robot.delay = 0.
            ready()

            # Loss of controller evidence still cancels an admitted motion before execution.
            robot.hold_plan = True
            before = len(robot.executions)
            assert move().get('accepted') is not False
            wait_for(lambda: info()['busy'])
            robot.delay = 3.6
            def canceled():
                status = info()
                event = ws.events.get(ws.command_id, {})
                return not status['busy'] and event.get('motion_phase') == 'canceled'
            wait_for(canceled)
            assert len(robot.executions) == before
            robot.hold_plan = False
            robot.delay = 0.
            ready()

            # Let every obsolete delayed callback finish sending its response.
            # Destroy in the quiet interval after a new fast response, before the
            # next query, so rclpy never sends through a destroyed service handle.
            def quiescent():
                with robot.lock:
                    return robot.active_calls == 0 and time.monotonic() - robot.calls[-1] < .3
            wait_for(quiescent)
            time.sleep(.15)
            robot.destroy_service(robot.service)
            wait_for(lambda: '服务不可用' in info()['message'])
            assert move().get('accepted') is False
            robot.restore_service()
            ready()
            # Unchanged one-second telemetry gate, even after controller recovery.
            robot.pause = True
            wait_for(lambda: not info()['available'])
            assert move().get('accepted') is False
            print('PASS: slow response cadence, timeout backoff/deduplication, late response isolation, '
                  'inactive and service loss gates, recovery, in-motion cancellation, telemetry expiry')
        except Exception:
            log.seek(0)
            print(log.read()[-18000:], file=sys.stderr)
            raise
        finally:
            robot.hold_plan = False
            if ws:
                ws.socket.close()
            process.send_signal(signal.SIGINT)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            executor.shutdown(timeout_sec=6)
            thread.join(timeout=2)
            robot.destroy_node()
            rclpy.shutdown()


if __name__ == '__main__':
    main(sys.argv[1])
