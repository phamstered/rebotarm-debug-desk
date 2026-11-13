#!/usr/bin/env python3
"""Gravity action lifecycle on an isolated ROS domain, no real actuators."""
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
import rclpy
from rclpy.node import Node
from rclpy.action import ActionServer, CancelResponse, GoalResponse
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from rclpy.qos import qos_profile_sensor_data
from microros_stm32h723_bridge.action import GravityIdentification
from microros_stm32h723_bridge.msg import HardwareStatus, JointCommand
from sensor_msgs.msg import JointState
from test_gripper_motion_ros import WebSocket, wait_for
from test_image_topic import send_json


class Robot(Node):
    def __init__(self):
        super().__init__('gravity_task_fixture')
        self.group = ReentrantCallbackGroup()
        self.entered = threading.Event()
        self.returned = threading.Event()
        self.finish = False
        self.freeze = False
        self.mode = 1
        self.speed = .1
        self.cancels = 0
        self.commands = []
        self.accept_commands = False
        self.sequence = 0
        self.command_sub = self.create_subscription(JointCommand, '/gravity260/commands', self.command, qos_profile_sensor_data, callback_group=self.group)
        self.stamp = self.get_clock().now().to_msg()
        self.action = ActionServer(self, GravityIdentification, '/StartGravityID',
            execute_callback=self.execute, goal_callback=self.goal,
            cancel_callback=self.cancel, callback_group=self.group)
        self.status = self.create_publisher(HardwareStatus, '/gravity260/status', qos_profile_sensor_data)
        self.joints = self.create_publisher(JointState, '/gravity260/joints', qos_profile_sensor_data)
        self.timer = self.create_timer(.02, self.publish, callback_group=self.group)

    def goal(self, _):
        self.entered.set()
        time.sleep(.5)  # Exercise cancellation/reservation before acceptance.
        return GoalResponse.ACCEPT

    def cancel(self, _):
        self.cancels += 1
        return CancelResponse.ACCEPT

    def execute(self, handle):
        deadline = time.monotonic() + 20
        while not handle.is_cancel_requested and not self.finish and time.monotonic() < deadline:
            time.sleep(.02)
        result = GravityIdentification.Result()
        result.success = not handle.is_cancel_requested
        result.message = 'isolated action returned'
        if handle.is_cancel_requested:
            handle.canceled()
        else:
            handle.succeed()
        self.returned.set()
        return result

    def command(self, message):
        self.commands.append(message)
        if self.accept_commands:
            self.mode = message.mode
            self.sequence = message.sequence

    def publish(self):
        if not self.freeze:
            self.stamp = self.get_clock().now().to_msg()
        status = HardwareStatus()
        status.header.stamp = self.stamp
        status.mode = self.mode
        status.last_command_sequence = self.sequence
        self.status.publish(status)
        joints = JointState()
        joints.header.stamp = self.stamp
        joints.name = ['joint%d' % i for i in range(1, 7)]
        joints.position = [0.] * 6
        joints.velocity = [self.speed] * 6
        joints.effort = [0.] * 6
        self.joints.publish(joints)


def main(binary):
    assert os.environ.get('ROS_DOMAIN_ID') == '220', 'Requires isolated domain 220'
    assert os.environ.get('ROS_LOCALHOST_ONLY') == '1', 'Requires localhost ROS'
    rclpy.init()
    robot = Robot()
    executor = MultiThreadedExecutor(num_threads=4)
    executor.add_node(robot)
    thread = threading.Thread(target=executor.spin, daemon=True)
    thread.start()
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1', 0))
        port = reserve.getsockname()[1]
    directory = Path(tempfile.mkdtemp(prefix='gravity260-'))
    clients = []
    process = None
    try:
        with (directory / 'bridge.log').open('w') as log:
            process = subprocess.Popen([binary, '--ros-args', '-p', 'port:=%d' % port,
                '-p', 'command_topic:=/gravity260/commands', '-p', 'status_topic:=/gravity260/status', '-p', 'joint_state_topic:=/gravity260/joints'],
                stdout=log, stderr=log)
            def connect():
                try:
                    return WebSocket(port)
                except OSError:
                    return None
            owner = wait_for(connect)
            observer = WebSocket(port)
            clients.extend([owner, observer])
            send_json(observer.socket, {'op': 'hello'})
            assert observer.receive()['gravity_task_supported']
            time.sleep(.5)
            replies = []
            pending = threading.Thread(target=lambda: replies.append(owner.request(
                'gravity_id_send_goal', command_id='first', confirmation='ARMED')))
            pending.start()
            assert robot.entered.wait(3)
            assert observer.request('gravity_id_send_goal', command_id='conflict', confirmation='ARMED')['op'] == 'error'
            assert observer.request('gravity_id_heartbeat', command_id='first')['renewed'] is False
            # Cancel while the ROS goal handle has not yet arrived.
            assert observer.request('gravity_id_cancel', command_id='first')['accepted'] is True
            pending.join(5)
            assert not pending.is_alive() and replies[0]['accepted'], replies
            assert robot.returned.wait(5)
            query = lambda: observer.request('gravity_id_task_status', command_id='first')
            wait_for(lambda: query()['status'] == 'awaiting_stop')
            assert query()['terminal'] is False
            robot.freeze = True
            robot.mode = 0
            robot.speed = 0.
            time.sleep(.8)
            assert query()['terminal'] is False, 'replayed source stamps cannot prove stop'
            robot.freeze = False
            final = wait_for(lambda: (lambda v: v if v['terminal'] else None)(query()))
            assert final['result']['command_id'] == 'first'
            assert final['result']['task_phase'] == 'canceled'
            assert observer.request('gravity_id_task_status', command_id='unknown')['known'] is False
            assert observer.request('gravity_id_send_goal', command_id='first', confirmation='ARMED')['op'] == 'error'
            # The owner may stay connected, but read-only queries never renew.
            robot.returned.clear()
            robot.mode = 1
            robot.speed = .1
            assert owner.request('gravity_id_send_goal', command_id='lease', confirmation='ARMED')['accepted']
            deadline = time.monotonic() + 8
            while not robot.returned.is_set() and time.monotonic() < deadline:
                observer.request('gravity_id_task_status', command_id='lease')
                time.sleep(.1)
            assert robot.returned.is_set(), 'read-only observer incorrectly renewed lease'
            robot.mode = 0
            robot.speed = 0.
            wait_for(lambda: observer.request('gravity_id_task_status', command_id='lease')['terminal'])
            assert robot.cancels >= 2
            # DISABLE must not be released by the orchestrator's later HOLD.
            robot.returned.clear()
            robot.mode = 1
            robot.speed = .1
            assert owner.request('gravity_id_send_goal', command_id='disable', confirmation='ARMED')['accepted']
            assert observer.request('joint_command', mode=3)['op'] == 'joint_command_ack'
            assert robot.returned.wait(5)
            robot.mode = 0
            robot.speed = 0.
            time.sleep(.5)
            assert observer.request('gravity_id_task_status', command_id='disable')['terminal'] is False
            robot.accept_commands = True
            wait_for(lambda: observer.request('gravity_id_task_status', command_id='disable')['terminal'])
            assert robot.mode == 3 and len(robot.commands) >= 6
            sequences = [cmd.sequence for cmd in robot.commands]
            assert len(set(sequences)) == len(sequences), sequences
            assert all(cmd.mode == 3 and all(value == 0 for field in [cmd.position, cmd.velocity, cmd.kp, cmd.kd, cmd.effort] for value in field) for cmd in robot.commands)

            print('Gravity lifecycle ROS tests passed:', directory)
    finally:
        robot.finish = True
        for client in clients:
            client.socket.close()
        if process:
            process.terminate()
            try:
                process.wait(5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        executor.shutdown()
        robot.destroy_node()
        rclpy.shutdown()
        thread.join(3)


if __name__ == '__main__':
    main(sys.argv[1])
