#!/usr/bin/env python3
"""Real ROS service/status adapter with an isolated faulted MCU, never hardware."""
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from ros_test_websocket import WebSocket, wait_for


def peer(scenario):
    import rclpy
    from rclpy.node import Node
    from rclpy.qos import QoSProfile, ReliabilityPolicy
    from sensor_msgs.msg import JointState
    from microros_stm32h723_bridge.msg import HardwareStatus, JointCommand, JointCommandV2, MotorControlStatus
    from microros_stm32h723_bridge.srv import MotorControl
    rclpy.init()
    node = Node('recovery_test_peer')
    qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.BEST_EFFORT)
    prefix = '/recovery_test/'
    status_pub = node.create_publisher(MotorControlStatus, prefix + 'motor_control_status', qos)
    hardware_pub = node.create_publisher(HardwareStatus, prefix + 'status', qos)
    joints_pub = node.create_publisher(JointState, prefix + 'joint_states', qos)
    state = MotorControlStatus()
    state.protocol_version = 3
    state.boot_id = 42
    state.control_epoch = 1
    state.mode = 3
    state.fault_code = 7
    state.control_modes = [1, 1, 2, 1, 1, 1, 1]
    state.verified_joint_mask = 127
    state.pos_vel_supported_mask = 127
    state.position_min = [-3.] * 7
    state.position_max = [3.] * 7
    state.velocity_limit_max = [1.] * 7
    state.last_command_sequence = 1
    due = None

    def stop(msg):
        nonlocal due
        assert msg.mode == 3, 'Recovery must never enable or send old targets'
        state.last_command_sequence = msg.sequence
        state.mode = 3
        state.enabled_joint_mask = 0
        state.lease_id = 0
        if state.switching:
            state.switching = False
            state.operation_state = 4
            state.control_epoch += 1
            due = None

    def forbidden(_):
        raise AssertionError('Recovery published a motion command')

    def service(req, response):
        nonlocal due
        assert req.action == 5 and req.control_mode == 0 and req.lease_id == 0
        assert req.boot_id == 42 and req.expected_control_epoch == state.control_epoch
        assert req.active_joint_mask == 4 and req.disable_sequence == state.last_command_sequence
        assert state.fault_code == 7 and not state.enabled_joint_mask
        state.operation_id = req.operation_id
        state.operation_state = 1
        state.switching = True
        state.owner_source_id = req.source_id
        state.selected_joint_mask = 4
        due = time.monotonic() + .25
        response.accepted = True
        response.operation_id = req.operation_id
        response.control_epoch = state.control_epoch
        return response

    def update():
        nonlocal due
        if due and time.monotonic() >= due and scenario != 'timeout':
            state.switching = False
            state.operation_state = 2 if scenario == 'success' else 3
            state.error_code = 0 if scenario == 'success' else 8
            state.fault_code = 0 if scenario == 'success' else 7
            state.disabled_verified = scenario == 'success'
            state.control_epoch += 1
            state.owner_source_id = 0
            state.selected_joint_mask = 0
            due = None
        stamp = node.get_clock().now().to_msg()
        state.header.stamp = stamp
        status_pub.publish(state)
        hardware = HardwareStatus()
        hardware.header.stamp = stamp
        hardware.mode = 3
        hardware.fault_code = state.fault_code
        hardware.active_joint_mask = 127
        hardware.last_command_sequence = state.last_command_sequence
        hardware_pub.publish(hardware)
        joints = JointState()
        joints.header.stamp = stamp
        joints.name = ['joint%d' % i for i in range(1, 8)]
        joints.position = [0.] * 7
        joints.velocity = [0.] * 7
        joints.effort = [0.] * 7
        joints_pub.publish(joints)

    node.create_subscription(JointCommand, prefix + 'joint_commands', stop, qos)
    node.create_subscription(JointCommandV2, prefix + 'joint_commands_v2', forbidden, qos)
    node.create_service(MotorControl, prefix + 'motor_control', service)
    node.create_timer(.02, update)
    rclpy.spin(node)


def scenario(binary, name):
    processes = []
    client = None
    with socket.socket() as endpoint:
        endpoint.bind(('127.0.0.1', 0))
        port = endpoint.getsockname()[1]
    with open('/tmp/motor-recovery-' + name + '.log', 'w') as log:
        try:
            processes.append(subprocess.Popen([binary, '--ros-args', '-p', f'port:={port}',
                '-p', 'command_topic:=/recovery_test/joint_commands', '-p', 'status_topic:=/recovery_test/status',
                '-p', 'joint_state_topic:=/recovery_test/joint_states'], stdout=log, stderr=log))
            def connect():
                try:
                    return WebSocket(port)
                except (OSError, RuntimeError):
                    return None
            client = wait_for(connect)
            client.socket.settimeout(12)
            assert client.request('hello')['motor_control_supported']
            processes.append(subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--peer', name], stdout=log, stderr=log))
            caps = lambda: client.request('motor_capabilities')['motor_control']
            current = wait_for(lambda: (s if (s := caps())['fresh'] else None))
            assert current['protocol_version'] == 3 and current['fault_code'] == 7
            fields = dict(boot_id=current['boot_id'], control_epoch=current['control_epoch'], active_joint_mask=4, confirmation='ARMED')
            assert client.request('motor_recover_fault', **fields)['op'] == 'error'
            assert client.request('motor_set_control_mode', **fields, control_mode='POS_VEL', support_confirmation='SUPPORTED')['op'] == 'error'
            # Set the same fault-related STOP barrier that occurs after a live fault.
            assert client.request('joint_command', mode=3)['op'] == 'joint_command_ack'
            result = client.request('motor_recover_fault', **fields, support_confirmation='SUPPORTED')
            if name == 'success':
                assert result['op'] == 'motor_recover_fault_result' and result['terminal'], result
                recovered = result['motor_control']
                assert recovered['disabled_verified'] and recovered['fault_code'] == 0
                assert recovered['control_epoch'] > current['control_epoch']
                assert recovered['mode'] == 3 and recovered['lease_id'] == 0 and recovered['enabled_joint_mask'] == 0
                assert recovered['owner_source_id'] == '0' and recovered['selected_joint_mask'] == 0
                assert client.request('motor_recover_fault', **fields, support_confirmation='SUPPORTED')['op'] == 'error'
            else:
                assert result['op'] == 'error', result
                assert caps()['fault_code'] == 7
            time.sleep(.2)
            assert all(p.poll() is None for p in processes), 'Mock detected forbidden motion'
        finally:
            if client:
                client.socket.close()
            for process in reversed(processes):
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=3)


if __name__ == '__main__':
    assert os.environ.get('ROS_DOMAIN_ID') == '227'
    assert os.environ.get('ROS_LOCALHOST_ONLY') == '1'
    if sys.argv[1] == '--peer':
        peer(sys.argv[2])
    else:
        for name in ('success', 'fault_remains', 'timeout'):
            scenario(sys.argv[1], name)
