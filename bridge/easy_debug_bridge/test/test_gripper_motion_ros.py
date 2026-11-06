#!/usr/bin/env python3
"""Isolated Bridge/MoveIt contract smoke. Run only with ROS_DOMAIN_ID=213.

All ROS publishers, controllers and Actions below are mocks. No motor commands
are sent. Pass the freshly built bridge_node binary as the only argument.
"""
import base64
import json
import math
import os
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import uuid

import rclpy
from rclpy.action import ActionServer, CancelResponse
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from controller_manager_msgs.msg import ControllerState
from controller_manager_msgs.srv import ListControllers
from control_msgs.msg import JointTrajectoryControllerState
from microros_stm32h723_bridge.msg import HardwareStatus
from moveit_msgs.action import ExecuteTrajectory, MoveGroup
from sensor_msgs.msg import JointState
from trajectory_msgs.msg import JointTrajectoryPoint

ARM = ['joint%d' % i for i in range(1, 7)]
GRIPPER = 'gripper_finger_left_joint'
SCALE, OFFSET = -.008612826752, .004282757541


class WebSocket:
    """Small RFC6455 text client, using stdlib only for isolated ROS tests."""
    def __init__(self, port):
        self.events = {}
        self.command_id = None
        self.socket = socket.create_connection(('127.0.0.1', port), timeout=3)
        key = base64.b64encode(os.urandom(16)).decode()
        self.socket.sendall(('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n'
                            'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n'
                            'Sec-WebSocket-Key: %s\r\n\r\n' % key).encode())
        response = b''
        while not response.endswith(b'\r\n\r\n'):
            chunk = self.socket.recv(1)
            if not chunk:
                self.socket.close()
                raise RuntimeError('WebSocket closed during handshake')
            response += chunk
        assert b'101 Switching Protocols' in response, response

    def read(self, count):
        value = b''
        while len(value) < count:
            chunk = self.socket.recv(count - len(value))
            if not chunk:
                raise RuntimeError('WebSocket closed')
            value += chunk
        return value

    def receive(self):
        # Beast fragments larger motion-log replies across continuation frames.
        payload = b''
        while True:
            first, second = self.read(2)
            length = second & 127
            if length == 126:
                length = struct.unpack('!H', self.read(2))[0]
            elif length == 127:
                length = struct.unpack('!Q', self.read(8))[0]
            assert not second & 128, 'Server frames must not be masked'
            assert first & 15 in (0, 1), first
            payload += self.read(length)
            if first & 128:
                break
        message = json.loads(payload)
        if message.get('op') == 'position_motion':
            self.events[message['command_id']] = message
        return message

    def request(self, op, **fields):
        request_id = str(uuid.uuid4())
        if op == 'position_move':
            self.command_id = fields['command_id']
        data = json.dumps(dict(op=op, request_id=request_id, **fields)).encode()
        mask = os.urandom(4)
        header = bytes([129, 128 | len(data)]) if len(data) < 126 else bytes([129, 254]) + struct.pack('!H', len(data))
        self.socket.sendall(header + mask + bytes(x ^ mask[i % 4] for i, x in enumerate(data)))
        while True:
            reply = self.receive()
            if reply.get('request_id') == request_id:
                return reply


class MockRobot(Node):
    def __init__(self):
        super().__init__('move_group')
        urdf = '<robot name="test"><link name="base_link"/>'
        for i, joint in enumerate(ARM, 1):
            parent = 'base_link' if i == 1 else 'link%d' % (i-1)
            axis = ['0 0 1', '0 1 0', '0 1 0', '1 0 0', '0 1 0', '0 0 1'][i-1]
            urdf += ('<link name="link%d"/><joint name="%s" type="revolute"><parent link="%s"/>'
                     '<child link="link%d"/><origin xyz="0 0 0.05"/><axis xyz="%s"/>'
                     '<limit lower="-1" upper="1"/></joint>') % (i, joint, parent, i, axis)
        urdf += ('<link name="gripper_link"/><joint name="tool_mount" type="fixed"><parent link="link6"/>'
                 '<child link="gripper_link"/><origin xyz="0.02 0 0.1" rpy="0 0 0.3"/></joint>'
                 '<link name="finger"/><joint name="%s" type="prismatic"><parent link="gripper_link"/>'
                 '<child link="finger"/><limit lower="0" upper="0.0715"/></joint></robot>') % GRIPPER
        srdf = '<robot name="test"><group name="arm">' + ''.join('<joint name="%s"/>' % j for j in ARM)
        srdf += '</group><group_state name="home" group="arm">' + ''.join('<joint name="%s" value="0"/>' % j for j in ARM)
        srdf += '</group_state><group name="gripper"><joint name="%s"/></group>' % GRIPPER
        srdf += '<group name="arm_with_gripper">' + ''.join('<joint name="%s"/>' % j for j in ARM + [GRIPPER]) + '</group></robot>'
        params = {'robot_description': urdf, 'robot_description_semantic': srdf,
                  'moveit_manage_controllers': False,
                  'moveit_controller_manager': 'moveit_simple_controller_manager/MoveItSimpleControllerManager',
                  'trajectory_execution.allowed_start_tolerance': .01,
                  'moveit_simple_controller_manager.controller_names': ['arm_trajectory_controller', 'gripper_trajectory_controller'],
                  'debug_desk.gripper_position_scale': SCALE, 'debug_desk.gripper_position_offset': OFFSET,
                  'debug_desk.gripper_lower': 0., 'debug_desk.gripper_upper': .05}
        for name, joints in [('arm_trajectory_controller', ARM), ('gripper_trajectory_controller', [GRIPPER])]:
            for key, value in dict(joints=joints, type='FollowJointTrajectory', action_ns='follow_joint_trajectory').items():
                params['moveit_simple_controller_manager.%s.%s' % (name, key)] = value
        for joint in ARM + [GRIPPER]:
            for key, value in dict(max_velocity=.02 if joint == GRIPPER else 1.,
                                   max_acceleration=.04 if joint == GRIPPER else 1.,
                                   has_velocity_limits=True, has_acceleration_limits=True).items():
                params['robot_description_planning.joint_limits.%s.%s' % (joint, key)] = value
        for key, value in params.items():
            self.declare_parameter(key, value)
        self.positions = dict(zip(ARM + [GRIPPER], [0.] * 6 + [.025]))
        self.groups, self.executions = [], []
        self.mismatch = False
        self.raw_arm_offset = 0.
        self.raw_gripper_offset = 0.
        self.broadcaster_enabled = True
        self.broadcaster_positions = None
        self.broadcaster_names = None
        self.broadcaster_stamp_offset = 0.
        self.broadcaster_frozen_stamp = None
        self.pause = False
        self.hold_plan = False
        self.invalid_pose_plan = False
        self.pose_measurement_bias = False
        self.arm_pub = self.create_publisher(JointTrajectoryControllerState, '/arm_trajectory_controller/controller_state', qos_profile_sensor_data)
        self.gripper_pub = self.create_publisher(JointTrajectoryControllerState, '/gripper_trajectory_controller/controller_state', qos_profile_sensor_data)
        self.broadcaster_pub = self.create_publisher(JointState, '/joint_states', qos_profile_sensor_data)
        self.joints_pub = self.create_publisher(JointState, '/stm32/joint_states', qos_profile_sensor_data)
        self.hardware_pub = self.create_publisher(HardwareStatus, '/stm32/status', qos_profile_sensor_data)
        self.service = self.create_service(ListControllers, '/controller_manager/list_controllers', self.controllers)
        # Reentrant callbacks allow feedback and cancellation while mock planning is held.
        from rclpy.callback_groups import ReentrantCallbackGroup
        group = ReentrantCallbackGroup()
        self.move = ActionServer(self, MoveGroup, '/move_action', execute_callback=self.plan,
                                 cancel_callback=lambda _: CancelResponse.ACCEPT, callback_group=group)
        self.execute = ActionServer(self, ExecuteTrajectory, '/execute_trajectory', execute_callback=self.run,
                                    cancel_callback=lambda _: CancelResponse.ACCEPT, callback_group=group)
        self.timer = self.create_timer(.05, self.publish)

    def controllers(self, _, response):
        for name, joints in [('arm_trajectory_controller', ARM), ('gripper_trajectory_controller', [GRIPPER])]:
            c = ControllerState(name=name, state='active', type='joint_trajectory_controller/JointTrajectoryController')
            c.claimed_interfaces = [j + '/' + interface for j in joints for interface in ['position', 'velocity']]
            response.controller.append(c)
        return response

    def publish(self):
        if self.pause:
            return
        stamp = self.get_clock().now().to_msg()
        joints = JointState()
        joints.header.stamp = stamp
        joints.name = ARM + [GRIPPER]
        joints.position = [self.positions[j] for j in ARM] + [(self.positions[GRIPPER] - OFFSET) / SCALE]
        joints.position[0] += self.raw_arm_offset
        joints.position[-1] += self.raw_gripper_offset / SCALE
        joints.velocity = [0.] * 7
        joints.effort = [0.] * 7
        self.joints_pub.publish(joints)
        if self.broadcaster_enabled:
            broadcast = JointState()
            source_ns = self.get_clock().now().nanoseconds + int(self.broadcaster_stamp_offset * 1e9)
            broadcast.header.stamp.sec = source_ns // 10**9
            broadcast.header.stamp.nanosec = source_ns % 10**9
            if self.broadcaster_frozen_stamp is not None:
                broadcast.header.stamp = self.broadcaster_frozen_stamp
            # Reverse names to exercise name-based matching; gripper is already metres.
            broadcast.name = self.broadcaster_names if self.broadcaster_names is not None else list(reversed(ARM + [GRIPPER]))
            broadcast.position = self.broadcaster_positions if self.broadcaster_positions is not None else [self.positions[j] for j in broadcast.name]
            broadcast.velocity = [0.] * len(broadcast.name)
            broadcast.effort = [0.] * len(broadcast.name)
            self.broadcaster_pub.publish(broadcast)
        for publisher, names in [(self.arm_pub, ARM), (self.gripper_pub, [GRIPPER])]:
            state = JointTrajectoryControllerState()
            state.header.stamp = stamp
            state.joint_names = names
            state.actual.positions = [self.positions[j] + (.005 if j == GRIPPER and self.mismatch else 0) for j in names]
            state.actual.velocities = [0.] * len(names)
            publisher.publish(state)
        hardware = HardwareStatus()
        hardware.mode = HardwareStatus.MODE_TRACK
        hardware.active_joint_mask = 127
        hardware.fault_code = 0
        self.hardware_pub.publish(hardware)

    def plan(self, handle):
        request = handle.request.request
        self.groups.append(request.group_name)
        while self.hold_plan and not handle.is_cancel_requested:
            time.sleep(.02)
        result = MoveGroup.Result()
        if handle.is_cancel_requested:
            handle.canceled()
            result.error_code.val = -7
            return result
        names = [GRIPPER] if request.group_name == 'gripper' else ARM + ([GRIPPER] if request.group_name == 'arm_with_gripper' else [])
        constraints = request.goal_constraints[0]
        targets = {c.joint_name: c.position for c in constraints.joint_constraints}
        if constraints.position_constraints:
            assert handle.request.planning_options.plan_only
            position = constraints.position_constraints[0]
            orientation = constraints.orientation_constraints[0]
            assert position.link_name == orientation.link_name == 'link6'
            assert position.header.frame_id == orientation.header.frame_id == 'base_link'
            assert orientation.parameterization == orientation.ROTATION_VECTOR
            center = position.constraint_region.primitive_poses[0].position
            assert abs(center.x) < 1e-8 and abs(center.y) < 1e-8 and abs(center.z-.3) < 1e-8
            q = orientation.orientation
            yaw = 2*math.atan2(q.z, q.w)
            assert abs(q.x) < 1e-8 and abs(q.y) < 1e-8
            targets.update({j: 0. for j in ARM})
            targets['joint1'] = yaw + (.2 if self.invalid_pose_plan else 0.)
        result.planned_trajectory.joint_trajectory.joint_names = list(reversed(names))  # Exercise name-based reordering.
        for alpha, sec in [(0., 0), (.5, 3), (1., 6)]:
            point = JointTrajectoryPoint()
            point.positions = [(1-alpha)*self.positions[j] + alpha*targets[j] for j in reversed(names)]
            point.velocities = [0.] * len(names)
            point.accelerations = [0.] * len(names)
            point.time_from_start.sec = sec
            result.planned_trajectory.joint_trajectory.points.append(point)
        result.error_code.val = 1
        # Legacy arm-only requests execute through MoveGroup itself.
        if not handle.request.planning_options.plan_only:
            self.positions.update(targets)
        handle.succeed()
        return result

    def run(self, handle):
        trajectory = handle.request.trajectory.joint_trajectory
        self.executions.append(trajectory)
        self.positions.update(zip(trajectory.joint_names, trajectory.points[-1].positions))
        if self.pose_measurement_bias:
            self.positions['joint1'] += .015
            self.positions['joint6'] += .015
        result = ExecuteTrajectory.Result()
        result.error_code.val = 1
        handle.succeed()
        return result


def wait_for(fn, timeout=15):
    until = time.monotonic() + timeout
    last = None
    while time.monotonic() < until:
        last = fn()
        if last:
            return last
        time.sleep(.1)
    raise AssertionError('Timed out: %r' % last)


def main(binary):
    assert os.environ.get('ROS_DOMAIN_ID') == '213', 'Must use isolated ROS_DOMAIN_ID=213'
    rclpy.init()
    robot = MockRobot()
    executor = MultiThreadedExecutor(num_threads=4)
    executor.add_node(robot)
    thread = threading.Thread(target=executor.spin, daemon=True)
    thread.start()
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1', 0))
        port = reserve.getsockname()[1]
    with open('/tmp/joint7-bridge-smoke.log', 'w') as log:
        process = subprocess.Popen([binary, '--ros-args', '-p', 'port:=%d' % port], stdout=log, stderr=log)
        try:
            def connect():
                try:
                    return WebSocket(port)
                except OSError:
                    return None
            ws = wait_for(connect)
            info = lambda: ws.request('position_motion_info')
            ready = wait_for(lambda: (lambda i: i if i.get('gripper_available') else None)(info()))
            assert ready['gripper_supported'] and ready['gripper_feedback_fresh'], ready
            assert abs(ready['gripper_position'] - .025) < 1e-8, ready
            def move(**fields):
                return ws.request('position_move', command_id=str(uuid.uuid4()), confirmation='ARMED', **fields)
            for targets in [{GRIPPER: .06}, {GRIPPER: -.01}, {'joint7': 0.}]:
                reply = move(joint_targets=targets, motion_duration_s=5.)
                assert reply.get('accepted') is False, reply
            assert not robot.groups
            # Raw MCU input can lead/lag the controller snapshot. It remains the
            # clock/limits/stop source, but it is not the consistency comparator.
            robot.raw_arm_offset = .1
            robot.raw_gripper_offset = .005
            time.sleep(.2)
            assert info()['available'] and info()['gripper_available'], info()
            robot.raw_arm_offset = robot.raw_gripper_offset = 0.
            for label, names, values in [
                ('arm-mismatch', None, [.025, 0., 0., 0., 0., 0., .03]),
                ('gripper-mismatch', None, [.030, 0., 0., 0., 0., 0., 0.]),
                ('missing-joint', ARM[1:] + [GRIPPER], [0.] * 5 + [.025]),
                ('duplicate', ['joint1'] * 7, [0.] * 7),
                ('nonfinite', None, [.025, 0., 0., 0., 0., 0., float('nan')]),
                ('short-array', None, [0.]),
            ]:
                robot.broadcaster_names, robot.broadcaster_positions = names, values
                bad = wait_for(lambda: (lambda i: i if not i['gripper_available'] and 'Broadcaster' in (i['message'] + i['gripper_message']) else None)(info()))
                assert move(joint_targets={GRIPPER: .03})['accepted'] is False, (label, bad)
                robot.broadcaster_names = robot.broadcaster_positions = None
                wait_for(lambda: info()['gripper_available'])
            for offset in [-2., 2.]:
                robot.broadcaster_stamp_offset = offset
                wait_for(lambda: not info()['available'])
                assert move(joint_targets={'joint1': .1})['accepted'] is False
                robot.broadcaster_stamp_offset = 0.
                wait_for(lambda: info()['gripper_available'])
            robot.broadcaster_enabled = False
            wait_for(lambda: 'Broadcaster' in info()['message'])
            assert move(joint_targets={'joint1': .1})['accepted'] is False
            robot.broadcaster_enabled = True
            wait_for(lambda: info()['gripper_available'])
            robot.broadcaster_frozen_stamp = robot.get_clock().now().to_msg()
            wait_for(lambda: 'Broadcaster' in info()['message'])
            robot.broadcaster_frozen_stamp = None
            wait_for(lambda: info()['gripper_available'])
            assert not robot.groups, 'invalid Broadcaster feedback must never admit a motion'
            robot.mismatch = True
            wait_for(lambda: not info()['gripper_available'])
            assert move(joint_targets={GRIPPER: .03})['accepted'] is False
            robot.mismatch = False
            wait_for(lambda: info()['gripper_available'])
            def completed(expected='succeeded'):
                state = info()
                event = ws.events.get(ws.command_id, {})
                phase = event.get('motion_phase')
                if state['busy'] or phase not in ('succeeded', 'failed', 'canceled'):
                    return False
                assert phase == expected, event
                return True
            robot.hold_plan = True
            reply = move(joint_targets={GRIPPER: .03}, motion_duration_s=6.)
            assert reply.get('accepted') is not False, reply
            wait_for(lambda: info()['busy'])
            robot.broadcaster_positions = [.025, 0., 0., 0., 0., 0., .03]
            wait_for(lambda: completed('canceled'))
            assert not robot.executions
            robot.hold_plan = False
            robot.broadcaster_positions = None
            wait_for(lambda: info()['gripper_available'])
            reply = move(joint_targets={'joint1': .1, GRIPPER: .035}, motion_duration_s=6.)
            assert reply.get('accepted') is not False, reply
            wait_for(completed)
            assert robot.groups[-1] == 'arm_with_gripper', robot.groups
            assert abs(robot.positions[GRIPPER] - .035) < 1e-9
            assert robot.executions[-1].points[-1].time_from_start.sec == 6
            assert len(robot.executions[-1].joint_names) == 7
            reply = move(joint_targets={GRIPPER: .03}, motion_duration_s=6.)
            assert reply.get('accepted') is not False, reply
            wait_for(completed)
            assert robot.groups[-1] == 'gripper'
            assert robot.executions[-1].joint_names == [GRIPPER]
            held = robot.positions[GRIPPER]
            reply = move(home=True)
            assert reply.get('accepted') is not False, reply
            wait_for(completed)
            assert robot.groups[-1] == 'arm' and robot.positions[GRIPPER] == held
            def pose(yaw):
                return dict(frame_id='base_link', tcp_link='gripper_link',
                            position=[.02*math.cos(yaw), .02*math.sin(yaw), .4],
                            orientation=[0., 0., math.sin((yaw+.3)/2), math.cos((yaw+.3)/2)])
            assert info()['tcp_pose_supported'] is True
            before = len(robot.groups)
            for invalid in [dict(pose(.2), frame_id='map'), dict(pose(.2), tcp_link='finger'),
                            dict(pose(.2), orientation=[0.,0.,0.,0.]),
                            dict(pose(.2), orientation=[0.,0.,0.,2.]),
                            dict(pose(.2), position=[0.,0.])]:
                assert move(tcp_pose=invalid)['accepted'] is False
            assert move(tcp_pose=pose(.2), home=False)['accepted'] is False
            for malformed_gripper in [None, 'oops', {}]:
                assert move(tcp_pose=pose(.2), gripper_position=malformed_gripper)['accepted'] is False
            assert len(robot.groups) == before
            reply = move(tcp_pose=pose(.2), motion_duration_s=6.)
            assert reply.get('accepted') is not False, reply
            wait_for(completed)
            assert robot.groups[-1] == 'arm'
            assert abs(robot.positions['joint1']-.2) < 1e-8
            reply = move(tcp_pose=pose(.1), gripper_position=.025, motion_duration_s=6.)
            assert reply.get('accepted') is not False, reply
            wait_for(completed)
            assert robot.groups[-1] == 'arm_with_gripper' and abs(robot.positions[GRIPPER]-.025)<1e-8
            held = robot.positions[GRIPPER]
            # A planner's success flag cannot override a wrong TCP orientation.
            robot.invalid_pose_plan = True
            before = len(robot.executions)
            reply = move(tcp_pose=pose(.2), motion_duration_s=6.)
            assert reply.get('accepted') is not False, reply
            wait_for(lambda: completed('failed'))
            assert len(robot.executions) == before
            robot.invalid_pose_plan = False
            # Per-joint errors <0.02rad can still exceed the orientation tolerance.
            robot.pose_measurement_bias = True
            reply = move(tcp_pose=pose(.2), motion_duration_s=6.)
            assert reply.get('accepted') is not False, reply
            wait_for(lambda: completed('failed'))
            robot.pose_measurement_bias = False
            for held_goal in [dict(joint_targets={GRIPPER: .02}), dict(tcp_pose=pose(.1), gripper_position=.02)]:
                robot.hold_plan = True
                command_id = str(uuid.uuid4())
                reply = ws.request('position_move', command_id=command_id, confirmation='ARMED', motion_duration_s=6., **held_goal)
                assert reply.get('accepted') is not False, reply
                wait_for(lambda: info()['busy'])
                before = len(robot.executions)
                ws.request('position_cancel', command_id=command_id)
                wait_for(lambda: completed('canceled'))
                assert len(robot.executions) == before and robot.positions[GRIPPER] == held
                robot.hold_plan = False
            robot.pause = True
            wait_for(lambda: not info()['available'])
            assert move(joint_targets={GRIPPER: .02})['accepted'] is False
            print('PASS: calibrated snapshot, limits/aliases, mismatch/staleness, 7-axis and gripper-only execution, HOME hold, cancel-before-execute, full TCP pose constraints/offsets and orientation failures')
            ws.socket.close()
        finally:
            # Release a held callback even when a cancellation assertion fails,
            # so executor teardown cannot wait forever for its worker thread.
            robot.hold_plan = False
            process.send_signal(signal.SIGINT)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            executor.shutdown(timeout_sec=5)
            robot.destroy_node()
            rclpy.shutdown()


if __name__ == '__main__':
    main(sys.argv[1])
