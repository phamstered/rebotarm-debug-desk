#!/usr/bin/env python3
"""Selected RGB target survives total depth outage. Synthetic publishers, domain 226 only."""
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

class RgbRobot(ClockRobot):
    def __init__(self):
        self.depth_enabled=True;self.hidden=False;self.camera_x=0.;self.tf_delay=0.;self.pending_tf=[]
        super().__init__();self.raw_enabled=True;self.camera_enabled=True
    def publish_camera(self):
        if not self.camera_enabled:return
        stamp=self.get_clock().now().to_msg()
        tf=TransformStamped();tf.header.stamp=stamp
        tf.header.frame_id,tf.child_frame_id='base_link','rgb_target_optical'
        tf.transform.translation.x=self.camera_x;tf.transform.translation.z=.4
        tf.transform.rotation.x=1.;tf.transform.rotation.w=0.
        self.pending_tf.append((time.monotonic()+self.tf_delay,tf))
        while self.pending_tf and self.pending_tf[0][0]<=time.monotonic():
            self.dynamic_tf.sendTransform(self.pending_tf.pop(0)[1])
        w,h=320,240
        pixels=array.array('B',[30])*(w*h*3);depths=array.array('H',[400])*(w*h)
        for n,cx in enumerate((-.05,.08)):
            center=int(160+(cx-self.camera_x)*300/.35);half=30 if n==0 else int(.025*300/.35)
            for y in range(120-half,121+half):
                for x in range(center-half,center+half+1):
                    if n==0 and abs(x-center)+abs(y-120)>30:continue
                    depths[y*w+x]=350
                    if not(self.hidden and n==0):pixels[(y*w+x)*3:(y*w+x)*3+3]=array.array('B',[20,220,20])
        rgb=Image();rgb.header.frame_id='rgb_target_optical';rgb.header.stamp=stamp
        rgb.width,rgb.height,rgb.step,rgb.encoding=w,h,w*3,'rgb8';rgb.data=pixels
        depth=Image();depth.header=rgb.header;depth.width,depth.height,depth.step,depth.encoding=w,h,w*2,'16UC1'
        depth.data=array.array('B',depths.tobytes())
        info=CameraInfo();info.header=rgb.header;info.width,info.height=w,h;info.k=[300.,0.,160.,0.,300.,120.,0.,0.,1.]
        self.info.publish(info);self.rgb.publish(rgb)
        if self.depth_enabled:self.depth.publish(depth)

def main(binary):
    assert os.environ.get('ROS_DOMAIN_ID')=='226','Isolated domain required'
    rclpy.init();robot=RgbRobot();executor=MultiThreadedExecutor(num_threads=4);executor.add_node(robot)
    thread=threading.Thread(target=executor.spin,daemon=True);thread.start()
    with socket.socket() as reserve:reserve.bind(('127.0.0.1',0));port=reserve.getsockname()[1]
    with tempfile.TemporaryFile(mode='w+') as log:
        process=subprocess.Popen([binary,'--ros-args','-p',f'port:={port}','-p','status_topic:=/stm32/status'],stdout=log,stderr=log)
        ws=other=None
        try:
            def connect():
                try:return BinaryWebSocket(port)
                except OSError:return None
            ws=wait_for(connect)
            wait_for(lambda:ws.request('clock_sync_info')['state']=='synchronized')
            params=dict(subscription_id='rgb-target-a',rgb_topic='/clock_test/rgb',depth_topic='/clock_test/depth',camera_info_topic='/clock_test/info',target_frame='base_link',max_width=320,max_height=240,max_fps=10.,detect_objects=True)
            assert ws.request('subscribe_rgbd',**params)['op']=='subscribed_rgbd'
            def boxes():
                ws.request('clock_sync_info')
                good=[m for m in ws.rgbd if m.get('subscription_id')==params['subscription_id'] and m.get('objects',{}).get('status')=='ok']
                return good[-1]['objects']['items'] if good else None
            objects=wait_for(boxes);obj=min(objects,key=lambda b:b['center'][0])['id']
            preview=ws.request('visual_pick_preview',subscription_id=params['subscription_id'],object_id=obj)
            assert preview['op']=='visual_pick_preview',preview
            target=preview['tracking']['target_id']
            assert preview['tracking']['mode']=='confirming',preview
            def tracked(mode):
                ws.request('clock_sync_info')
                matches=[m for m in ws.targets if m['tracking']['target_id']==target and m['tracking']['mode']==mode]
                return matches[-1] if matches else None
            first=wait_for(lambda:tracked('rgbd'));assert first['tracking']['identity_valid']
            # Images arrive ahead of their capture-time TF. The tracker must
            # retry a fixed pending frame instead of chasing each newest image.
            robot.tf_delay=.08
            robot.depth_enabled=False;robot.camera_x=.002
            rgb=wait_for(lambda:tracked('rgb'))
            assert rgb['tracking']['identity_valid'] and not rgb['tracking']['metric_ready'],rgb
            assert rgb['tracking']['object_id']==obj and rgb['tracking']['sequence']>first['tracking']['sequence']
            # Keep RGB running beyond the entire depth cloud's freshness budget.
            time.sleep(.7);ws.targets.clear();rgb=wait_for(lambda:tracked('rgb'))
            assert rgb['tracking']['age_ms']<500,rgb
            preview=ws.request('visual_pick_preview',subscription_id=params['subscription_id'],object_id=obj)
            assert preview['tracking']['target_id']==target and not preview['execution_ready'],preview
            other=BinaryWebSocket(port)
            assert other.request('visual_target_release',subscription_id=params['subscription_id'],target_id=target)['op']=='error'
            assert ws.request('visual_target_release',subscription_id=params['subscription_id'],target_id='old')['op']=='error'
            robot.hidden=True
            uncertain=wait_for(lambda:tracked('uncertain'));assert not uncertain['tracking']['identity_valid']
            robot.hidden=False;time.sleep(.7)
            preview=ws.request('visual_pick_preview',subscription_id=params['subscription_id'],object_id=obj)
            assert preview['tracking']['mode']=='uncertain' and preview['tracking']['target_id']==target,preview
            assert preview['tracking']['message']==uncertain['tracking']['message'],preview
            assert ws.request('visual_target_release',subscription_id=params['subscription_id'],target_id=target)['op']=='visual_target_released'
            robot.depth_enabled=True;time.sleep(.6);objects=wait_for(boxes);obj=min(objects,key=lambda b:b['center'][0])['id']
            preview=ws.request('visual_pick_preview',subscription_id=params['subscription_id'],object_id=obj)
            assert preview['tracking']['target_id']!=target,preview
            target=preview['tracking']['target_id']
            wait_for(lambda:tracked('rgbd'))
            # A bounded retry must not relax expiry when TF stops arriving.
            robot.tf_delay=2.
            lost=wait_for(lambda:tracked('uncertain'))
            assert not lost['tracking']['identity_valid'] and not lost['tracking']['metric_ready'],lost
            assert ws.request('visual_pick_status')['busy'] is False
            assert not robot.groups and not robot.executions,'No production or simulated motion should be requested'
            print('PASS: real binary RGB handoff with depth absent, UUID/lease isolation, loss latch, release and reselection')
        except Exception:
            log.seek(0);print(log.read()[-16000:],file=sys.stderr);raise
        finally:
            for client in (ws,other):
                if client:client.socket.close()
            process.send_signal(signal.SIGINT)
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait()
            executor.shutdown(timeout_sec=6);thread.join(timeout=2);robot.destroy_node();rclpy.shutdown()
if __name__=='__main__':main(sys.argv[1])
