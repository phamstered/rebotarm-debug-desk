#!/usr/bin/env python3
"""Real Bridge RGBD workers with delayed TF and independent clients; domain 216 only."""
import array
import collections
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time

import rclpy
from geometry_msgs.msg import TransformStamped
from rclpy.executors import MultiThreadedExecutor
from rclpy.utilities import get_rmw_implementation_identifier
from sensor_msgs.msg import Image, CameraInfo
from test_clock_sync_ros import ClockRobot, BinaryWebSocket
from test_gripper_motion_ros import wait_for


class StreamRobot(ClockRobot):
    def __init__(self):
        self.tf_delay = .08
        self.tf_enabled = True
        self.depth_enabled = True
        self.images_enabled = True
        self.delayed = collections.deque()
        self.last_image = 0.
        self.width, self.height = 2, 2
        self.data_size = None
        self.rgb_data = self.depth_data = None
        super().__init__()
        self.tf_origin_ns = self.get_clock().now().nanoseconds
        self.raw_enabled = True
        self.camera_enabled = True
        self.tf_future = False
        self.destroy_timer(self.camera_timer)
        self.camera_timer = self.create_timer(.01, self.publish_camera)

    def publish_camera(self):
        mono = time.monotonic()
        if not self.tf_enabled:
            self.delayed.clear()
        while self.delayed and self.delayed[0][0] <= mono:
            _, tf = self.delayed.popleft()
            if self.tf_enabled:
                self.dynamic_tf.sendTransform(tf)
        if mono-self.last_image < .05:
            return
        self.last_image = mono
        stamp = self.get_clock().now().to_msg()
        tf = TransformStamped()
        tf.header.stamp = stamp
        tf.header.frame_id, tf.child_frame_id = 'base_link', 'clock_mount'
        stamp_ns = stamp.sec*10**9+stamp.nanosec
        tf.transform.translation.x = .4 + .1*(stamp_ns-self.tf_origin_ns)/1e9
        tf.transform.rotation.w = 1.
        if self.tf_enabled:
            self.delayed.append((mono+self.tf_delay, tf))
        if not self.images_enabled:
            return
        w, h = self.width, self.height
        if self.data_size != (w, h):
            self.rgb_data = array.array('B', [255, 0, 0])*(w*h)
            self.depth_data = array.array('B', [232, 3])*(w*h)
            self.data_size = w, h
        rgb = Image()
        rgb.header.frame_id, rgb.header.stamp = 'clock_optical', stamp
        rgb.width, rgb.height, rgb.step, rgb.encoding = w, h, w*3, 'rgb8'
        rgb.data = self.rgb_data
        depth = Image()
        depth.header.frame_id, depth.header.stamp = 'clock_optical', stamp
        depth.width, depth.height, depth.step, depth.encoding = w, h, w*2, '16UC1'
        depth.data = self.depth_data
        info = CameraInfo()
        info.header.frame_id, info.header.stamp = 'clock_optical', stamp
        info.width, info.height, info.k = w, h, [1.,0.,.5,0.,1.,.5,0.,0.,1.]
        self.info.publish(info)
        self.rgb.publish(rgb)
        if self.depth_enabled:
            self.depth.publish(depth)


def main(binary):
    assert os.environ.get('ROS_DOMAIN_ID') == '216', 'Isolated ROS_DOMAIN_ID=216 required'
    rclpy.init()
    robot = StreamRobot()
    executor = MultiThreadedExecutor(num_threads=4)
    executor.add_node(robot)
    thread = threading.Thread(target=executor.spin, daemon=True)
    thread.start()
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1', 0))
        port = reserve.getsockname()[1]
    with tempfile.TemporaryFile(mode='w+') as log:
        process = subprocess.Popen([binary, '--ros-args', '-p', 'port:=%d'%port,
                                    '-p', 'status_topic:=/stm32/status'], stdout=log, stderr=log)
        clients = []
        try:
            def connect():
                try:
                    client = BinaryWebSocket(port)
                    clients.append(client)
                    return client
                except OSError:
                    return None
            ws = wait_for(connect)
            wait_for(lambda: ws.request('clock_sync_info')['state'] == 'synchronized')
            def subscribe(client, token, width=2, height=2):
                reply = client.request('subscribe_rgbd', subscription_id=token,
                    rgb_topic='/clock_test/rgb', depth_topic='/clock_test/depth',
                    camera_info_topic='/clock_test/info', target_frame='base_link',
                    max_width=width, max_height=height, max_fps=12.)
                assert reply['op'] == 'subscribed_rgbd' and reply['subscription_id'] == token, reply
                return reply
            def drain(client, duration):
                end = time.monotonic()+duration
                while time.monotonic()<end:
                    status = client.request('clock_sync_info')
                    assert status['state'] == 'synchronized', status
                    time.sleep(.025)
            def frames(client, duration=2.):
                client.rgbd.clear();client.tf_errors.clear()
                drain(client, duration)
                return list(client.rgbd), list(client.tf_errors)
            def check_unique(items):
                stamps = [(m['rgb']['header']['stamp']['sec'], m['rgb']['header']['stamp']['nanosec']) for m in items]
                assert len(stamps) == len(set(stamps)), 'A consumed RGBD pair must never be repeated'
                for message in items:
                    stamp = message['rgb']['header']['stamp']
                    stamp_ns = stamp['sec']*10**9+stamp['nanosec']
                    expected_x = .5 + .1*(stamp_ns-robot.tf_origin_ns)/1e9
                    assert message['tf_ok'] and abs(message['pose']['translation']['x']-expected_x)<1e-5, message

            subscribe(ws, 'first')
            # Independent executors on one Context still share a Fast DDS
            # participant. Image ingress must use a separate Context/participant.
            def rgbd_endpoints(topic):
                return [endpoint for endpoint in robot.get_subscriptions_info_by_topic(topic)
                        if endpoint.node_name == 'easy_debug_rgbd_receiver']
            endpoints = []
            for topic in ('/clock_test/rgb', '/clock_test/depth', '/clock_test/info'):
                matched = wait_for(lambda topic=topic: rgbd_endpoints(topic))
                assert len(matched) == 1, (topic, matched)
                endpoints.extend(matched)
            if get_rmw_implementation_identifier().startswith('rmw_fastrtps'):
                def control_endpoint():
                    return [endpoint for endpoint in robot.get_publishers_info_by_topic('/stm32/joint_commands')
                            if endpoint.node_name == 'easy_debug_bridge']
                control = wait_for(control_endpoint)
                assert len(control) == 1, control
                control_prefix = bytes(control[0].endpoint_gid[:12])
                image_prefixes = [bytes(endpoint.endpoint_gid[:12]) for endpoint in endpoints]
                assert len(control_prefix) == 12 and any(control_prefix), control_prefix
                assert all(len(prefix) == 12 and any(prefix) for prefix in image_prefixes), image_prefixes
                assert len(set(image_prefixes)) == 1, image_prefixes
                assert all(prefix != control_prefix for prefix in image_prefixes), (
                    'RGBD ingress shares the control DDS participant', control_prefix, image_prefixes)
            wait_for(lambda: (ws.request('clock_sync_info'), bool(ws.rgbd))[1])
            for delay in (.08, .12):
                robot.tf_delay = delay
                good, errors = frames(ws, 2.)
                assert len(good) >= 8, (delay, len(good), errors)
                assert not errors, errors
                check_unique(good)
            # A second reader must receive its own frames and token.
            second = wait_for(connect)
            subscribe(second, 'parallel')
            good, errors = frames(second, 1.5)
            assert len(good) >= 6 and not errors, (len(good), errors)
            assert all(m['subscription_id']=='parallel' for m in good)

            for component in ('tf_enabled', 'depth_enabled'):
                ws.tf_errors.clear()
                setattr(robot, component, False)
                started = time.monotonic()
                wait_for(lambda: (ws.request('clock_sync_info'), bool(ws.tf_errors))[1], timeout=3)
                assert time.monotonic()-started >= .35, 'Transient gaps must respect the stale grace period'
                good, errors = frames(ws, .65)
                assert not good, 'An incomplete stream must not display old cloud data'
                # One status transition, rather than one repeated failure per callback.
                assert len(errors) <= 1, errors
                setattr(robot, component, True)
                wait_for(lambda: (ws.request('clock_sync_info'), bool(ws.rgbd))[1], timeout=3)
                good, errors = frames(ws, 1.)
                assert len(good) >= 3 and not errors, (component, len(good), errors)

            # Unsubscribe + resubscribe excludes every prior token after the ACK.
            ws.request('unsubscribe_rgbd')
            ws.rgbd.clear();ws.tf_errors.clear()
            drain(ws, .25)
            assert not ws.rgbd and not ws.tf_errors
            subscribe(ws, 'replacement')
            good, errors = frames(ws, 1.)
            assert good and not errors
            assert all(m['subscription_id']=='replacement' for m in good)
            # Also replace directly while an old pending TF pair may exist.
            subscribe(ws, 'newest')
            good, errors = frames(ws, 1.)
            assert good and all(m['subscription_id']=='newest' for m in good)

            # Stop reading a large-frame client. Its bounded write must not lock
            # another client's worker or the receive/clock callback group.
            slow = wait_for(connect)
            slow.socket.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
            subscribe(slow, 'slow', 640, 480)
            robot.width, robot.height = 640, 480
            good, errors = frames(ws, 4.)
            assert len(good) >= 12 and not errors, (len(good), errors)
            check_unique(good)
            assert process.poll() is None
            print('PASS: 80/120ms delayed TF under continuous input; TF/depth outage grace and recovery; '
                  'unique pairs, independent clients, unsubscribe/resubscribe tokens, slow-reader isolation')
        except Exception:
            print('Bridge process returncode:', process.poll(), file=sys.stderr)
            log.seek(0)
            print(log.read()[-22000:], file=sys.stderr)
            raise
        finally:
            for client in clients:
                client.socket.close()
            process.send_signal(signal.SIGINT)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill();process.wait()
            executor.shutdown(timeout_sec=6)
            thread.join(timeout=2)
            robot.destroy_node();rclpy.shutdown()


if __name__ == '__main__':
    main(sys.argv[1])
