#!/usr/bin/env python3
"""Synthetic tabletop RGBD through the real worker; isolated domain 215 only."""
import array
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time

import rclpy
from rclpy.executors import MultiThreadedExecutor
from geometry_msgs.msg import TransformStamped
from sensor_msgs.msg import Image, CameraInfo
from test_clock_sync_ros import ClockRobot, BinaryWebSocket
from test_gripper_motion_ros import wait_for

class TableRobot(ClockRobot):
    def __init__(self):
        self.with_objects = True
        self.images_enabled = True
        super().__init__()
        self.raw_enabled = True
        self.camera_enabled = True

    def publish_camera(self):
        if not self.camera_enabled or not self.images_enabled:
            return
        stamp = self.get_clock().now().to_msg()
        tf = TransformStamped()
        tf.header.stamp = stamp
        tf.header.frame_id, tf.child_frame_id = 'base_link', 'table_test_optical'
        tf.transform.translation.z = .5
        tf.transform.rotation.x, tf.transform.rotation.w = 1., 0.  # Optical Z points down.
        self.dynamic_tf.sendTransform(tf)
        w, h = 160, 120
        depth_values = array.array('H', [650]) * (w*h)
        if self.with_objects:
            for left in (38, 100):
                for y in range(50, 66):
                    for x in range(left, left+16):
                        depth_values[y*w+x] = 580
        rgb = Image()
        rgb.header.frame_id, rgb.header.stamp = 'table_test_optical', stamp
        rgb.width, rgb.height, rgb.step, rgb.encoding = w, h, w*3, 'rgb8'
        rgb.data = array.array('B', [100, 180, 220])*(w*h)
        depth = Image()
        depth.header = rgb.header
        depth.width, depth.height, depth.step, depth.encoding = w, h, w*2, '16UC1'
        depth.data = array.array('B', depth_values.tobytes())
        info = CameraInfo()
        info.header = rgb.header
        info.width, info.height, info.k = w, h, [160.,0.,80.,0.,160.,60.,0.,0.,1.]
        self.info.publish(info);self.rgb.publish(rgb);self.depth.publish(depth)

def main(binary):
    assert os.environ.get('ROS_DOMAIN_ID') == '215'
    rclpy.init(); robot = TableRobot()
    executor = MultiThreadedExecutor(num_threads=4);executor.add_node(robot)
    thread = threading.Thread(target=executor.spin, daemon=True);thread.start()
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1', 0));port = reserve.getsockname()[1]
    with tempfile.TemporaryFile(mode='w+') as log:
        process = subprocess.Popen([binary,'--ros-args','-p',f'port:={port}','-p','status_topic:=/stm32/status'],stdout=log,stderr=log)
        ws = None
        try:
            def connect():
                try: return BinaryWebSocket(port)
                except OSError: return None
            ws = wait_for(connect)
            wait_for(lambda: ws.request('clock_sync_info')['state']=='synchronized')
            params = dict(subscription_id='objects-a',rgb_topic='/clock_test/rgb',depth_topic='/clock_test/depth',
                          camera_info_topic='/clock_test/info',target_frame='base_link',max_width=160,max_height=120,max_fps=10.)
            # Rejection must leave the prior valid subscription intact.
            assert ws.request('subscribe_rgbd',**params)['op']=='subscribed_rgbd'
            assert ws.request('subscribe_rgbd',**params,detect_objects=2)['op']=='error'
            reply = ws.request('subscribe_rgbd',**params,detect_objects=True)
            if reply['op']=='error':
                assert 'PCL' in reply.get('error',reply.get('message','')),reply
                print('PASS: unsupported detection rejected, legacy RGBD accepted');return
            assert reply['op']=='subscribed_rgbd',reply
            def capture(status, duration=2.):
                ws.rgbd.clear();end=time.monotonic()+duration
                while time.monotonic()<end:
                    assert ws.request('clock_sync_info')['state']=='synchronized'
                    time.sleep(.025)
                return [m for m in ws.rgbd if m.get('objects',{}).get('status')==status]
            def wait_detection(token):
                def ready():
                    ws.request('clock_sync_info')
                    return any(m.get('subscription_id') == token and m.get('objects', {}).get('status') == 'ok' for m in ws.rgbd)
                wait_for(ready)
            # DDS discovery/TF warm-up is not part of the steady-stream rate measurement.
            wait_detection('objects-a')
            frames=capture('ok',3.)
            assert len(frames)>=8,(len(frames),[(m.get("objects"),m.get("pose")) for m in ws.rgbd[-2:]],ws.tf_errors[-2:])
            ids=None
            for frame in frames:
                assert frame['subscription_id']=='objects-a' and frame['frame_age_ms']<500,frame
                boxes=frame['objects']['items'];assert len(boxes)==2,boxes
                assert all(abs(b['center'][2]+.08)<.003 for b in boxes),boxes
                current=sorted(b['id'] for b in boxes)
                if ids is not None: assert ids==current,(ids,current)
                ids=current
            seq=[m['objects']['frame_seq'] for m in frames];assert seq==sorted(set(seq))
            print('Detection frames in 3s:',len(frames),'source age max ms:',max(m['frame_age_ms'] for m in frames))
            robot.with_objects=False
            empty=capture('empty');assert empty and all(not m['objects']['items'] for m in empty)
            ws.tf_errors.clear();robot.images_enabled=False
            capture('ok',.8)
            assert ws.tf_errors,'Missing explicit stream failure'
            robot.images_enabled=True;robot.with_objects=True
            params['subscription_id']='objects-b'
            assert ws.request('subscribe_rgbd',**params,detect_objects=True)['op']=='subscribed_rgbd'
            wait_detection('objects-b')
            frames=capture('ok');assert frames and all(m['subscription_id']=='objects-b' for m in frames)
            assert ws.request('unsubscribe_rgbd')['op']=='unsubscribed_rgbd'
            print('PASS: same-frame tabletop boxes, IDs, empty scene, stream outage and new subscription isolation')
        except Exception:
            log.seek(0);print(log.read()[-18000:],file=sys.stderr);raise
        finally:
            if ws: ws.socket.close()
            process.send_signal(signal.SIGINT)
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired: process.kill();process.wait()
            executor.shutdown(timeout_sec=6);thread.join(timeout=2);robot.destroy_node();rclpy.shutdown()

if __name__=='__main__': main(sys.argv[1])
