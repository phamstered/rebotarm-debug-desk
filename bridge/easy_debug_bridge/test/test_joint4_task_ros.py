#!/usr/bin/env python3
"""Joint4 services against the actual Bridge, mock ROS nodes ONLY, domain 222."""
import json
import copy
import os
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import uuid
from collections import Counter

import rclpy
from rclpy.node import Node
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from rclpy.qos import qos_profile_sensor_data, ReliabilityPolicy
from controller_manager_msgs.msg import ControllerState
from controller_manager_msgs.srv import ListControllers
from std_srvs.srv import Trigger
from std_msgs.msg import Float64MultiArray
from sensor_msgs.msg import JointState
from microros_stm32h723_bridge.msg import HardwareStatus, JointCommand
from ros_test_websocket import WebSocket


def wait(check, timeout=5):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        result = check()
        if result:
            return result
        time.sleep(.04)
    raise AssertionError('condition did not become true before deadline')


class Robot(Node):
    def __init__(self):
        super().__init__('joint4_mock')
        self.calls = Counter()
        self.pose = False
        self.captured = False
        self.samples = 0
        self.fault = False
        self.controller_active = True
        self.mode = HardwareStatus.MODE_TRACK
        self.sequence = 0
        self.commands = []
        self.freeze = None
        self.pause_status = False
        self.bad_hardware_stamp = False
        self.begin_gate = None
        self.capture_gate = None
        self.lock = threading.Lock()
        self.group = ReentrantCallbackGroup()
        self.trigger_services = [self.create_service(Trigger, '/joint4_calibration_controller/' + action,
            lambda request, response, action=action: self.trigger(action, response), callback_group=self.group)
            for action in ['begin_pose', 'capture_pose', 'release_pose', 'fit', 'reset']]
        self.manager = self.create_service(ListControllers, '/controller_manager/list_controllers', self.controllers,
                                           callback_group=self.group)
        self.status = self.create_publisher(Float64MultiArray, '/joint4_calibration_controller/status', 10)
        self.joints = self.create_publisher(JointState, '/stm32/joint_states', qos_profile_sensor_data)
        self.hardware = self.create_publisher(HardwareStatus, '/stm32/status', qos_profile_sensor_data)
        self.command = self.create_subscription(JointCommand, '/stm32/joint_commands', self.disable,
                                                qos_profile_sensor_data, callback_group=self.group)
        self.timer = self.create_timer(.05, self.publish)

    def controllers(self, request, response):
        response.controller = [ControllerState(name='joint4_calibration_controller',
            type='microros_stm32h723_bridge/Joint4CalibrationController',
            state='active' if self.controller_active else 'inactive')]
        return response

    def trigger(self, action, response):
        with self.lock:
            self.calls[action] += 1
            gate = self.begin_gate if action == 'begin_pose' else self.capture_gate if action == 'capture_pose' else None
        if gate is not None:
            assert gate.wait(12), 'test failed to release the delayed service'
        with self.lock:
            response.success = True
            if action == 'begin_pose':
                self.pose = True
                self.captured = False
                self.fault = False
            elif action == 'release_pose':
                self.pose = False
                self.captured = False
                self.fault = False
            elif action == 'capture_pose':
                assert self.pose and not self.captured
                self.captured = True
                self.samples += 1
            elif action == 'reset':
                self.samples = 0
            response.message = 'samples=%d; q4=0.4; model=1.2; required=1.4; payload_sensitivity=0.3' % self.samples
        return response

    def disable(self, msg):
        assert msg.mode == 3
        assert all(v == 0 for values in [msg.position, msg.velocity, msg.kp, msg.kd, msg.effort] for v in values)
        with self.lock:
            self.commands.append(msg)
            self.mode = msg.mode
            self.sequence = msg.sequence

    def publish(self):
        with self.lock:
            stamp = self.freeze or self.get_clock().now().to_msg()
            joint = JointState()
            joint.header.stamp = stamp
            joint.name = ['joint%d' % i for i in range(1, 7)]
            joint.position = [.4] * 6
            joint.velocity = [0.] * 6
            self.joints.publish(joint)
            hw = HardwareStatus()
            hw.header.stamp = copy.deepcopy(stamp)
            if self.bad_hardware_stamp:
                hw.header.stamp.sec -= 1
                hw.header.stamp.nanosec += 1000000000
            hw.mode = self.mode
            hw.active_joint_mask = 63
            hw.last_command_sequence = self.sequence
            self.hardware.publish(hw)
            if not self.pause_status:
                state = Float64MultiArray()
                state.data = [.4, 0., 1.2, .2 if self.pose else 0., 1.4, .3, .4, 2. if self.pose else 0.,
                              float(self.samples), float(self.pose), float(self.fault), float(self.captured)]
                self.status.publish(state)


def send_without_wait(client, op, **fields):
    data = json.dumps(dict(op=op, request_id=str(uuid.uuid4()), **fields)).encode()
    mask = os.urandom(4)
    header = bytes([129, 128 | len(data)]) if len(data) < 126 else bytes([129, 254]) + struct.pack('!H', len(data))
    client.socket.sendall(header + mask + bytes(x ^ mask[i % 4] for i, x in enumerate(data)))


def main(binary):
    assert os.environ.get('ROS_DOMAIN_ID') == '222'
    assert os.environ.get('ROS_LOCALHOST_ONLY') == '1'
    rclpy.init()
    robot = Robot()
    executor = MultiThreadedExecutor(num_threads=4)
    executor.add_node(robot)
    thread = threading.Thread(target=executor.spin, daemon=True)
    thread.start()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    with open('/tmp/260-joint4-ros-bridge.log', 'w') as log:
        process = subprocess.Popen([binary, '--ros-args', '-p', 'port:=%d' % port], stdout=log, stderr=log)
        clients = []
        try:
            def connect():
                try:
                    client = WebSocket(port)
                    clients.append(client)
                    return client
                except (OSError, RuntimeError):
                    return None
            client = wait(connect, 8)
            observer = wait(connect)
            hello = client.request('hello')
            assert hello['joint4_task_supported'] is True
            wait(lambda: client.request('controllers_info', refresh=True).get('fresh'))
            wait(lambda: client.request('clock_sync_info').get('state') == 'synchronized')
            # Verify the actual test publisher QoS; production controller is not active in this test.
            infos = wait(lambda: robot.get_publishers_info_by_topic('/joint4_calibration_controller/status'))
            assert any(info.qos_profile.reliability == ReliabilityPolicy.RELIABLE for info in infos)

            def start(action='begin_pose', socket_=None):
                socket_ = socket_ or client
                id_ = 'joint4-' + uuid.uuid4().hex
                reply = socket_.request('joint4_start', command_id=id_, action=action, confirmation='SUPPORTED')
                assert reply.get('accepted') is True and reply.get('success') is True, reply
                return id_

            def state(id_, socket_=None):
                return (socket_ or observer).request('joint4_task_status', command_id=id_)

            def terminal(id_, evidence, timeout=5):
                result = wait(lambda: (s if (s := state(id_)).get('terminal') else None), timeout)
                assert result['result']['evidence'] == evidence, result
                assert result['busy'] is False and result['known'] is True
                return result

            def cancel(id_):
                assert client.request('joint4_cancel', command_id=id_)['accepted'] is True

            # Validation and controller failure must call no Trigger.
            before = sum(robot.calls.values())
            bad = client.request('joint4_start', command_id='no-confirm', action='begin_pose')
            assert bad['op'] == 'error' and sum(robot.calls.values()) == before
            robot.controller_active = False
            wait(lambda: any(c['state'] == 'inactive' for c in client.request('controllers_info', refresh=True).get('controllers', [])))
            bad = client.request('joint4_start', command_id='inactive', action='begin_pose', confirmation='SUPPORTED')
            assert bad['accepted'] is False and bad['evidence'] == 'not_called', bad
            terminal('inactive', 'not_called')
            assert sum(robot.calls.values()) == before
            robot.controller_active = True
            wait(lambda: any(c['state'] == 'active' for c in client.request('controllers_info', refresh=True).get('controllers', [])))

            robot.bad_hardware_stamp = True
            time.sleep(.15)
            bad = client.request('joint4_start', command_id='bad-hardware-stamp', action='begin_pose', confirmation='SUPPORTED')
            assert bad['accepted'] is False and bad['evidence'] == 'not_called', bad
            assert sum(robot.calls.values()) == before
            robot.bad_hardware_stamp = False
            robot.fault = True  # supported Begin may recover the controller's old fault latch
            time.sleep(.15)
            id_ = start()
            count = robot.calls['begin_pose']
            assert client.request('joint4_start', command_id=id_, action='begin_pose', confirmation='SUPPORTED')['accepted']
            assert robot.calls['begin_pose'] == count
            assert state(id_)['busy'] and not state(id_)['terminal']
            assert observer.request('joint4_heartbeat', command_id=id_)['renewed'] is False
            assert observer.request('joint4_cancel', command_id=id_)['accepted'] is False
            assert client.request('position_move', command_id='conflict', target=[0.] * 6)['op'] == 'error'
            if hello.get('trajectory_task_supported'):
                rejected = observer.request('trajectory_command', command_id='conflict-direct')
                assert rejected['accepted'] is False and rejected['evidence'] == 'not_published', rejected
                assert observer.request('trajectory_task_status', command_id='conflict-direct')['terminal'] is True
            time.sleep(.15)  # allow the new controller status to follow Begin's response
            capture = client.request('joint4_capture', command_id=id_, operation_id='capture-1', confirmation='HANDS_CLEAR')
            assert capture['success'], capture
            duplicate = client.request('joint4_capture', command_id=id_, operation_id='capture-1', confirmation='HANDS_CLEAR')
            assert duplicate['message'] == capture['message'] and robot.calls['capture_pose'] == 1
            assert client.request('joint4_capture', command_id=id_, operation_id='capture-2', confirmation='HANDS_CLEAR')['op'] == 'error'
            cancel(id_)
            terminal(id_, 'pose_released')
            assert robot.mode == 1 and not robot.commands  # Release does not claim DISABLE.

            # Root rejected during an existing hold is retained without disturbing that hold.
            id_ = start()
            rejected = observer.request('joint4_start', command_id='busy-root', action='begin_pose', confirmation='SUPPORTED')
            assert rejected['accepted'] is False and rejected['evidence'] == 'not_called'
            terminal('busy-root', 'not_called')
            assert state(id_)['busy']
            cancel(id_)
            terminal(id_, 'pose_released')

            # A canceled delayed Begin must finish before Release can be sent.
            robot.begin_gate = threading.Event()
            before = robot.calls.copy()
            id_ = 'delayed-begin'
            send_without_wait(client, 'joint4_start', command_id=id_, action='begin_pose', confirmation='SUPPORTED')
            wait(lambda: robot.calls['begin_pose'] == before['begin_pose'] + 1)
            cancel(id_)
            time.sleep(.25)
            assert robot.calls['release_pose'] == before['release_pose']
            assert state(id_)['busy']
            robot.begin_gate.set()
            terminal(id_, 'pose_released')
            robot.begin_gate = None
            assert robot.calls['release_pose'] == before['release_pose'] + 1 and not robot.pose

            # Nor may release overtake an in-flight Capture.
            id_ = start()
            time.sleep(.15)
            robot.capture_gate = threading.Event()
            before = robot.calls.copy()
            send_without_wait(client, 'joint4_capture', command_id=id_, operation_id='delayed-sample', confirmation='HANDS_CLEAR')
            wait(lambda: robot.calls['capture_pose'] == before['capture_pose'] + 1)
            cancel(id_)
            time.sleep(.25)
            assert robot.calls['release_pose'] == before['release_pose']
            robot.capture_gate.set()
            terminal(id_, 'pose_released')
            robot.capture_gate = None

            # No completion from a service ACK plus stale headerless status or replayed source stamps.
            id_ = start()
            time.sleep(.15)
            robot.pause_status = True
            cancel(id_)
            time.sleep(.4)
            assert not state(id_)['terminal']  # fresh raw feedback alone is insufficient
            robot.freeze = robot.get_clock().now().to_msg()
            robot.pause_status = False
            time.sleep(.4)
            assert not state(id_)['terminal']  # new status alone is also insufficient
            robot.freeze = None
            terminal(id_, 'pose_released')

            # Explicit DISABLE waits for a new sequence, release, and independent stopped feedback.
            id_ = start()
            robot.freeze = robot.get_clock().now().to_msg()
            assert client.request('joint_command', mode=3)['op'] == 'joint_command_ack'
            time.sleep(.3)
            assert not state(id_)['terminal']
            robot.freeze = None
            terminal(id_, 'output_disabled')
            assert robot.commands and robot.mode == 3
            robot.mode = 1
            time.sleep(.3)

            # Repeated read-only queries cannot renew the lease.
            id_ = start()
            terminal(id_, 'pose_released', timeout=8)

            lost = wait(connect)
            id_ = start(socket_=lost)
            lost.socket.close()
            terminal(id_, 'pose_released')
            assert not state('never-seen')['terminal']

            robot.samples = 4
            time.sleep(.15)
            id_ = start('fit')
            terminal(id_, 'service_verified')
            id_ = start('reset')
            terminal(id_, 'service_verified')
            assert robot.samples == 0
            assert process.poll() is None
            print('PASS: Joint4 real Bridge with mock services, serialized late replies, deduplication, '
                  'lease/disconnect, stale feedback, separate Release/DISABLE proof, fit/reset')
        finally:
            for gate in [robot.begin_gate, robot.capture_gate]:
                if gate is not None:
                    gate.set()
            for client in clients:
                client.socket.close()
            process.send_signal(signal.SIGINT)
            try:
                process.wait(8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(5)
            executor.shutdown(timeout_sec=3)
            robot.destroy_node()
            rclpy.shutdown()
            thread.join(3)


if __name__ == '__main__':
    main(sys.argv[1])
