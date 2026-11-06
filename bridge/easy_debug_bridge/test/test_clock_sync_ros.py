#!/usr/bin/env python3
"""Clock and RGBD recovery through a real Bridge; all robot/TF/image sources are mocks."""
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

import rclpy
from geometry_msgs.msg import TransformStamped
from rclpy.executors import MultiThreadedExecutor
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Image, CameraInfo
from std_msgs.msg import UInt32MultiArray
from tf2_ros import TransformBroadcaster, StaticTransformBroadcaster
from test_gripper_motion_ros import MockRobot, WebSocket, wait_for, GRIPPER


class BinaryWebSocket(WebSocket):
    def __init__(self, port):
        self.rgbd = []
        self.targets = []
        self.tf_errors = []
        super().__init__(port)

    def receive(self):
        payload, opcode = b'', None
        while True:
            first, second = self.read(2)
            kind = first & 15
            if opcode is None:
                opcode = kind
                assert opcode in (1, 2), first
            else:
                assert kind == 0, first
            length = second & 127
            if length == 126:
                length = struct.unpack('!H', self.read(2))[0]
            elif length == 127:
                length = struct.unpack('!Q', self.read(8))[0]
            assert not second & 128
            payload += self.read(length)
            if first & 128:
                break
        if opcode == 2:
            assert payload[:4] in (b'RCD1', b'RCT1'), payload[:8]
            size = struct.unpack('!I', payload[4:8])[0]
            message = json.loads(payload[8:8+size])
            assert message['data_length'] == len(payload)-8-size
            if payload[:4] == b'RCT1':
                assert message['op'] == 'visual_target_frame'
                self.targets.append(message)
            else:
                self.rgbd.append(message)
        else:
            message = json.loads(payload)
        if message.get('op') == 'position_motion':
            self.events[message['command_id']] = message
        if message.get('op') == 'rgbd_frame' and not message.get('tf_ok'):
            self.tf_errors.append(message)
        return message


class SourcePublisher:
    def __init__(self, publisher, robot):
        self.publisher, self.robot = publisher, robot

    def publish(self, message):
        if not self.robot.raw_enabled:
            return
        if self.robot.zero_stamp:
            message.header.stamp.sec = 0
            message.header.stamp.nanosec = 0
        else:
            stamp = self.robot.get_clock().now().nanoseconds + int(self.robot.raw_offset * 1e9)
            message.header.stamp.sec = stamp // 10**9
            message.header.stamp.nanosec = stamp % 10**9
        self.publisher.publish(message)


class ClockRobot(MockRobot):
    def __init__(self):
        self.raw_enabled = False
        self.raw_offset = 0.
        self.zero_stamp = False
        self.diag_enabled = True
        self.diag_version = 1
        self.sync_state = 1
        self.sync_epoch = 1
        self.camera_enabled = False
        self.tf_future = True
        super().__init__()
        self.joints_pub = SourcePublisher(self.joints_pub, self)
        self.diagnostics = self.create_publisher(UInt32MultiArray, '/stm32/microros_diagnostics', qos_profile_sensor_data)
        self.diag_timer = self.create_timer(.2, self.publish_diagnostics)
        self.rgb = self.create_publisher(Image, '/clock_test/rgb', qos_profile_sensor_data)
        self.depth = self.create_publisher(Image, '/clock_test/depth', qos_profile_sensor_data)
        self.info = self.create_publisher(CameraInfo, '/clock_test/info', qos_profile_sensor_data)
        self.dynamic_tf = TransformBroadcaster(self)
        self.static_tf = StaticTransformBroadcaster(self)
        mount = TransformStamped()
        mount.header.stamp = self.get_clock().now().to_msg()
        mount.header.frame_id = 'clock_mount'
        mount.child_frame_id = 'clock_optical'
        mount.transform.translation.x = .1
        mount.transform.rotation.w = 1.
        self.static_tf.sendTransform(mount)  # Send once; every new listener must reacquire latched TF.
        self.camera_timer = self.create_timer(.05, self.publish_camera)

    def publish_diagnostics(self):
        if not self.diag_enabled:
            return
        data = [0] * (16 if self.diag_version == 1 else 24)
        data[0], data[1] = self.diag_version, 1
        if self.diag_version == 2:
            data[16], data[17], data[19], data[20], data[22] = self.sync_state, 0, 0, 2, self.sync_epoch
        self.diagnostics.publish(UInt32MultiArray(data=data))

    def publish_camera(self):
        tf = TransformStamped()
        stamp = self.get_clock().now().nanoseconds + (15*10**9 if self.tf_future else 0)
        tf.header.stamp.sec, tf.header.stamp.nanosec = divmod(stamp, 10**9)
        tf.header.frame_id, tf.child_frame_id = 'base_link', 'clock_mount'
        tf.transform.translation.x = .25 if self.tf_future else .4
        tf.transform.rotation.w = 1.
        self.dynamic_tf.sendTransform(tf)
        if not self.camera_enabled:
            return
        stamp = self.get_clock().now().to_msg()
        rgb = Image()
        rgb.header.frame_id, rgb.header.stamp = 'clock_optical', stamp
        rgb.width, rgb.height, rgb.step, rgb.encoding = 2, 2, 6, 'rgb8'
        rgb.data = [255, 0, 0] * 4
        depth = Image()
        depth.header.frame_id, depth.header.stamp = 'clock_optical', stamp
        depth.width, depth.height, depth.step, depth.encoding = 2, 2, 4, '16UC1'
        depth.data = [232, 3] * 4
        info = CameraInfo()
        info.header.frame_id, info.header.stamp = 'clock_optical', stamp
        info.width, info.height, info.k = 2, 2, [1., 0., .5, 0., 1., .5, 0., 0., 1.]
        self.info.publish(info)
        self.rgb.publish(rgb)
        self.depth.publish(depth)


def main(binary):
    assert os.environ.get('ROS_DOMAIN_ID') == '215', 'Isolated ROS_DOMAIN_ID=215 required'
    rclpy.init()
    robot = ClockRobot()
    executor = MultiThreadedExecutor(num_threads=4)
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
                    return BinaryWebSocket(port)
                except OSError:
                    return None
            ws = wait_for(connect)
            clock = lambda: ws.request('clock_sync_info')
            motion = lambda: ws.request('position_motion_info')
            def aligned():
                return wait_for(lambda: (lambda s: s if s['state'] == 'synchronized' else None)(clock()))
            def move():
                return ws.request('position_move', command_id=str(uuid.uuid4()), confirmation='ARMED',
                                  joint_targets={GRIPPER: .03}, motion_duration_s=6.)
            assert clock()['state'] == 'waiting'
            robot.raw_enabled = True
            first = aligned()
            assert abs(first['source_offset_ms']) < 50 and not first['firmware']['supported'], first
            wait_for(lambda: motion()['gripper_available'])
            robot.raw_offset = 15.
            wait_for(lambda: clock()['state'] == 'unsynchronized')
            assert move().get('accepted') is False
            robot.raw_offset = 0.
            recovered = aligned()
            assert recovered['generation'] > first['generation'], recovered
            robot.zero_stamp = True
            wait_for(lambda: clock()['state'] == 'unsynchronized')
            assert move().get('accepted') is False
            robot.zero_stamp = False
            started = time.monotonic()
            aligned()
            assert time.monotonic() - started >= .15, 'Recovery must require 200ms convergence'
            robot.raw_enabled = False
            wait_for(lambda: clock()['state'] == 'stale')
            robot.raw_enabled = True
            aligned()
            robot.diag_version = 2
            v2 = wait_for(lambda: (lambda s: s if s.get('firmware', {}).get('supported') and s['state'] == 'synchronized' else None)(clock()))
            assert v2['firmware']['synchronized'] and v2['firmware']['last_sync_duration_ms'] == 2
            robot.sync_state = 2
            wait_for(lambda: clock()['state'] == 'unsynchronized')
            assert move().get('accepted') is False
            robot.sync_state = 1
            robot.sync_epoch += 1
            aligned()
            robot.diag_enabled = False
            wait_for(lambda: '诊断已过期' in clock()['message'])
            assert move().get('accepted') is False
            robot.diag_enabled = True
            robot.sync_epoch += 1
            aligned()
            wait_for(lambda: motion()['gripper_available'])
            # An admitted plan is canceled when time loses validity. Its stopping
            # lock survives the Action cancellation until trustworthy feedback returns.
            robot.hold_plan = True
            before = len(robot.executions)
            assert move().get('accepted') is not False
            wait_for(lambda: motion()['busy'])
            robot.raw_offset = 15.
            wait_for(lambda: clock()['state'] == 'unsynchronized')
            until = time.monotonic() + .7
            while time.monotonic() < until:
                assert motion()['busy'], 'Untrusted stop feedback cannot release the motion lock'
                time.sleep(.05)
            assert len(robot.executions) == before
            robot.raw_offset = 0.
            robot.hold_plan = False
            aligned()
            wait_for(lambda: not motion()['busy'])
            assert ws.events[ws.command_id]['motion_phase'] == 'canceled'
            assert len(robot.executions) == before

            # Poison the active TF history with future samples while raw source
            # time is healthy. Then reproduce the bad MCU time and recover both.
            ws.request('subscribe_rgbd', rgb_topic='/clock_test/rgb', depth_topic='/clock_test/depth',
                       camera_info_topic='/clock_test/info', target_frame='base_link',
                       max_width=320, max_height=240, max_fps=12.)
            robot.camera_enabled = True
            def future_history_error():
                clock()
                return any('extrapolation into the past' in error.get('tf_error', '')
                           for error in ws.tf_errors)
            wait_for(future_history_error)
            assert not ws.rgbd, 'Future TF history cannot yield an aligned image pose'
            robot.raw_offset = 15.
            wait_for(lambda: clock()['state'] == 'unsynchronized')
            robot.raw_offset = 0.
            robot.tf_future = False
            started = time.monotonic()
            def correct_frame():
                clock()  # Drain binary and text frames on this same WebSocket.
                return next((frame for frame in ws.rgbd if frame['tf_ok'] and
                             abs(frame['pose']['translation']['x']-.5) < 1e-6), None)
            frame = wait_for(correct_frame, timeout=4)
            assert time.monotonic()-started < 4, 'Recovery must discard old future TF history'
            assert frame['source_frame'] == 'clock_optical' and frame['target_frame'] == 'base_link'
            assert frame['rgb']['width'] == 2 and frame['depth']['height'] == 2
            assert process.poll() is None, 'Bridge must recover without restart'
            print('PASS: source clock waiting/aligned/future/zero/stale/recovery; firmware v1/v2/stale/epoch; '
                  'motion rejection and cancellation lock; RCD1 TF future-history recovery and static reacquisition')
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
