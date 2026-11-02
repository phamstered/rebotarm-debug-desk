#!/usr/bin/env python3
"""Isolated mocked MoveIt + camera integration. Never controls real hardware."""
import base64
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid

import rclpy
from rclpy.executors import MultiThreadedExecutor
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Image
from test_position_group_ros import GroupRobot, Client, wait_for


class CameraRobot(GroupRobot):
    def __init__(self):
        super().__init__()
        self.camera_mode = 'valid'
        self.camera = self.create_publisher(Image, '/motion205/camera', qos_profile_sensor_data)
        self.camera_timer = self.create_timer(.04, self.publish_camera)

    def publish_camera(self):
        if self.camera_mode == 'none':
            return
        image = Image()
        image.header.stamp = self.get_clock().now().to_msg()
        image.header.frame_id = 'calibration_camera'
        if self.camera_mode == 'stale':
            image.header.stamp.sec -= 2
        image.width = 2
        image.height = 1
        image.step = 6
        image.encoding = 'rgb8' if self.camera_mode != 'invalid' else '16UC1'
        image.data = bytes([255, 0, 0, 0, 255, 0])
        self.camera.publish(image)


def main(binary):
    assert os.environ.get('ROS_DOMAIN_ID') == '219', 'Isolated ROS_DOMAIN_ID=219 required'
    rclpy.init()
    robot = CameraRobot()
    executor = MultiThreadedExecutor(num_threads=6)
    executor.add_node(robot)
    thread = threading.Thread(target=executor.spin, daemon=True)
    thread.start()
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1', 0))
        port = reserve.getsockname()[1]
    directory = Path(tempfile.mkdtemp(prefix='motion205-capture-'))
    process = None
    client = None
    try:
        with (directory / 'bridge.log').open('w') as log:
            env = dict(os.environ, HOME=str(directory))
            process = subprocess.Popen([binary, '--ros-args', '-p', f'port:={port}'], env=env, stdout=log, stderr=log)
            def connect():
                try:
                    return Client(port)
                except OSError:
                    return None
            client = wait_for(connect)
            def info():
                return client.request('position_motion_info')
            ready = wait_for(lambda: (lambda x: x if x.get('gripper_available') else None)(info()))
            assert ready.get('motion_capture_supported') is True, ready
            def spec(timeout=2):
                return dict(group_id='capture-test', label='标定采集', preparation_duration_s=2., steps=[
                    dict(id='pose-a', label='A', positions=[.05, 0., 0., 0., 0., 0.], motion_duration_s=0., hold_duration_s=0.,
                         captures=[dict(id='capture-a', label='拍照 A', type='camera_capture', topic='/motion205/camera', timeout_s=timeout)]),
                    dict(id='pose-b', label='B', positions=[.1, 0., 0., 0., 0., 0.], motion_duration_s=3., hold_duration_s=0.)])
            def start(value=None, command=None):
                return client.request('position_group_start', command_id=command or str(uuid.uuid4()), confirmation='ARMED', **(value or spec()))
            def event(phase=None, terminal=False):
                state = info()
                value = client.events.get(client.command_id, {})
                if phase and value.get('motion_phase') != phase:
                    return False
                if terminal and state.get('busy'):
                    return False
                return value
            def capturing():
                value = event()
                return value if '等待有效图像' in value.get('message', '') else False

            # Unknown or unsafe Actions reject the whole group before planning.
            for mutate in [lambda c: c.update(type='shell'), lambda c: c.update(id='../escape'),
                           lambda c: c.update(topic='/bad//image'), lambda c: c.update(timeout_s=0.)]:
                value = spec()
                mutate(value['steps'][0]['captures'][0])
                assert start(value)['accepted'] is False
            assert not robot.groups

            assert start()['accepted'] is True
            result = wait_for(lambda: event('succeeded', True))
            capture = result['capture_result']
            path = Path(capture['path'])
            assert path.is_relative_to(directory)
            assert path.read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
            assert base64.b64decode(capture['thumbnail']).startswith(b'\x89PNG')
            metadata = json.loads(path.with_name('pose.json').read_text())
            assert metadata['action_id'] == 'capture-a' and metadata['frame_id'] == 'calibration_camera'
            assert len(metadata['joint_names']) == len(metadata['positions']) == len(metadata['velocities']) == 6
            assert abs(metadata['image_stamp'] - metadata['joint_stamp']) <= .1
            assert len(robot.executions) == 2

            # Missing, stale and malformed images cannot dispatch pose B.
            for mode in ['none', 'stale', 'invalid']:
                robot.camera_mode = mode
                before = len(robot.executions)
                assert start(spec(.6))['accepted'] is True
                failed = wait_for(lambda: event('failed', True))
                assert '拍照' in failed['message'], failed
                assert len(robot.executions) == before + 1
                assert 'capture_result' not in failed

            # Existing results are never overwritten; failed saves block progression.
            robot.camera_mode = 'valid'
            command = str(uuid.uuid4())
            existing = directory / '.local/share/robot-console/captures' / command / 'capture-a'
            existing.mkdir(parents=True)
            (existing / 'sentinel').write_text('keep')
            before = len(robot.executions)
            assert start(command=command)['accepted'] is True
            failed = wait_for(lambda: event('failed', True))
            assert '拒绝覆盖' in failed['message'], failed
            assert (existing / 'sentinel').read_text() == 'keep'
            assert len(robot.executions) == before + 1

            # A pre-existing staging directory is not owned by this attempt.
            command = str(uuid.uuid4())
            pending = directory / '.local/share/robot-console/captures' / command / 'capture-a.pending'
            pending.mkdir(parents=True)
            (pending / 'sentinel').write_text('keep pending')
            before = len(robot.executions)
            assert start(command=command)['accepted'] is True
            failed = wait_for(lambda: event('failed', True))
            assert '拒绝覆盖' in failed['message'], failed
            assert (pending / 'sentinel').read_text() == 'keep pending'
            assert len(robot.executions) == before + 1

            robot.camera_mode = 'none'
            before = len(robot.executions)
            assert start(spec(5))['accepted'] is True
            wait_for(capturing)
            client.request('position_cancel', command_id=client.command_id)
            wait_for(lambda: event('canceled', True))
            robot.camera_mode = 'valid'
            until = time.monotonic() + .4
            while time.monotonic() < until:
                assert info()['busy'] is False
                time.sleep(.04)
            assert len(robot.executions) == before + 1
            print(json.dumps(dict(ok=True, capture=str(path), executions=len(robot.executions))))
    finally:
        if client:
            client.socket.close()
        if process:
            process.terminate()
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        executor.shutdown(timeout_sec=5)
        robot.destroy_node()
        rclpy.shutdown()
        thread.join(timeout=5)
        shutil.rmtree(directory)


if __name__ == '__main__':
    main(sys.argv[1])
