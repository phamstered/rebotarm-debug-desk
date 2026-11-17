#!/usr/bin/env python3
"""Actual Bridge + installed stack's isolated MCU peer, never a hardware topic."""
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from ros_test_websocket import WebSocket


def wait(check, timeout=6):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(.02)
    raise AssertionError('timed out waiting for isolated Motor state')


def main(binary):
    assert os.environ.get('ROS_DOMAIN_ID') == '227'
    assert os.environ.get('ROS_LOCALHOST_ONLY') == '1'
    processes, clients = [], []
    with socket.socket() as endpoint:
        endpoint.bind(('127.0.0.1', 0))
        port = endpoint.getsockname()[1]
    with open('/tmp/motor-v2-bridge-ros.log', 'w') as log:
        processes.append(subprocess.Popen([binary, '--ros-args', '-p', f'port:={port}',
            '-p', 'command_topic:=/posvel_test/joint_commands', '-p', 'status_topic:=/posvel_test/status',
            '-p', 'joint_state_topic:=/posvel_test/joint_states'], stdout=log, stderr=log))
        try:
            def connect():
                try:
                    client = WebSocket(port)
                    client.socket.settimeout(12)
                    clients.append(client)
                    return client
                except (OSError, RuntimeError):
                    return None
            client = wait(connect)
            observer = wait(connect)
            hello = client.request('hello')
            caps = lambda socket_=client: socket_.request('motor_capabilities')['motor_control']
            assert not caps()['supported']  # No running firmware is not POS capability.
            if not hello.get('motor_control_supported'):
                reply = client.request('motor_set_control_mode', control_mode='POS_VEL')
                assert reply['op'] == 'error', reply
                return
            from ament_index_python.packages import get_package_prefix
            peer = Path(get_package_prefix('microros_stm32h723_bridge')) / 'lib/microros_stm32h723_bridge/mock_motor_control_v2.py'
            assert peer.is_file(), 'new V2 overlay must install its isolated MCU simulator'
            processes.append(subprocess.Popen([sys.executable, str(peer)], stdout=log, stderr=log))
            state = wait(lambda: (s if (s := caps())['fresh'] else None))
            assert state['supported'] and state['protocol_version'] == 2
            assert state['source_id'] != caps(observer)['source_id']

            def stop(socket_=client):
                ack = socket_.request('joint_command', mode=3, kp='ignored', position='ignored')
                assert ack['op'] == 'joint_command_ack' and ack['mode'] == 3, ack
                return wait(lambda: (s if (s := caps(socket_))['disabled_verified'] and not s['enabled_joint_mask']
                    and not s['lease_id'] and s['last_command_sequence'] == ack['sequence'] else None))

            def configure(mode, mask=1):
                s = caps()
                reply = client.request('motor_set_control_mode', control_mode=mode, boot_id=s['boot_id'],
                    control_epoch=s['control_epoch'], active_joint_mask=mask, confirmation='ARMED', support_confirmation='SUPPORTED')
                return reply

            stop()
            # New fields on the frozen legacy endpoint must not silently send MIT.
            reply = client.request('joint_command', mode=1, control_mode='POS_VEL', confirmation='ARMED')
            assert reply['op'] == 'error', reply
            assert configure('POS_VEL', 64)['op'] == 'error'  # unqualified joint7
            prior = caps()
            configured = configure('POS_VEL')
            assert configured['op'] == 'motor_set_control_mode_result' and configured['terminal'], configured
            state = configured['motor_control']
            assert state['control_modes'][0] == 'POS_VEL' and state['control_epoch'] != prior['control_epoch']
            assert state['disabled_verified'] and state['owner_source_id'] == state['source_id'] and state['lease_id'] == 0
            assert client.request('joint_command', mode=1, position=0., confirmation='ARMED')['op'] == 'error'
            assert observer.request('motor_control_lease', lease_action='acquire', control_mode='POS_VEL',
                boot_id=state['boot_id'], control_epoch=state['control_epoch'], active_joint_mask=1, confirmation='ARMED')['op'] == 'error'
            lease = client.request('motor_control_lease', lease_action='acquire', control_mode='POS_VEL',
                boot_id=state['boot_id'], control_epoch=state['control_epoch'], active_joint_mask=1, confirmation='ARMED')
            assert lease['op'] == 'motor_control_lease_ack', lease
            lease_id = lease['motor_control']['lease_id']
            assert lease_id > 0 and lease['motor_control']['disabled_verified']
            frame = dict(boot_id=state['boot_id'], control_epoch=state['control_epoch'], lease_id=lease_id,
                control_mode='POS_VEL', mode=1, active_joint_mask=1, position=[.1, 0., 0., 0., 0., 0., 0.],
                pos_vel={'velocity_limit': [.2, 0., 0., 0., 0., 0., 0.]}, confirmation='ARMED')
            time.sleep(.2)  # a bounded, output-off startup window tolerates service/status RTT
            sequences = []
            for _ in range(6):
                ack = client.request('motor_command_v2', **frame)
                assert ack['op'] == 'motor_command_v2_ack', ack
                sequences.append(ack['sequence'])
                time.sleep(.04)
            state = caps()
            assert state['enabled_joint_mask'] == 1 and state['mode'] == 1, state
            assert len(set(sequences)) == len(sequences)
            stopped = stop(observer)  # global stop from a different socket always works
            assert client.request('motor_command_v2', **frame)['op'] == 'error'  # stale lease cannot revive
            restored = configure('MIT', 127)
            assert restored['op'] == 'motor_set_control_mode_result', restored
            assert restored['motor_control']['owner_source_id'] == '0'
            assert restored['motor_control']['control_modes'] == ['MIT'] * 7
            # Fresh capability loss remains V2-aware; it never falls back to legacy.
            processes[-1].terminate(); processes[-1].wait(timeout=5)
            wait(lambda: not caps()['fresh'])
            assert caps()['supported'] is True
            assert client.request('joint_command', mode=1, position=0., confirmation='ARMED')['op'] == 'error'
        finally:
            for client in clients:
                client.socket.close()
            for process in reversed(processes):
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=8)
                    except subprocess.TimeoutExpired:
                        process.kill(); process.wait(timeout=3)


if __name__ == '__main__':
    main(sys.argv[1])
