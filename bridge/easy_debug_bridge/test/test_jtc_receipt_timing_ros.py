#!/usr/bin/env python3
"""Real JTC receipt timing with GenericSystem ONLY; isolated domain 224.

An aged nonzero header reproduces first-segment compression. A zero header
preserves the intended interval, and controller elapsed time identifies the
consumed trajectory rather than the previous stationary reference.
"""
import os, tempfile, subprocess, threading, time, json
from pathlib import Path
assert os.environ['ROS_DOMAIN_ID']=='224'
assert os.environ['ROS_LOCALHOST_ONLY']=='1'
import rclpy
from rclpy.node import Node
from rclpy.executors import SingleThreadedExecutor
from trajectory_msgs.msg import JointTrajectory, JointTrajectoryPoint
from control_msgs.msg import JointTrajectoryControllerState
from builtin_interfaces.msg import Duration

urdf='''<robot name="delay_probe"><link name="base"/><link name="tip"/><joint name="probe_joint" type="prismatic"><parent link="base"/><child link="tip"/><axis xyz="1 0 0"/><limit lower="-1" upper="1" effort="1" velocity="1"/></joint><ros2_control name="probe_fake" type="system"><hardware><plugin>mock_components/GenericSystem</plugin></hardware><joint name="probe_joint"><command_interface name="position"/><command_interface name="velocity"/><state_interface name="position"><param name="initial_value">0.0</param></state_interface><state_interface name="velocity"/></joint></ros2_control></robot>'''
rclpy.init(); node=Node('isolated_delay_probe')
executor=SingleThreadedExecutor(); executor.add_node(node)
states=[]
sub=node.create_subscription(JointTrajectoryControllerState,'/probe_controller/controller_state',lambda m:states.append(m),100)
pub=node.create_publisher(JointTrajectory,'/probe_controller/joint_trajectory',10)
thread=threading.Thread(target=executor.spin,daemon=True); thread.start()
process=None
with tempfile.TemporaryDirectory(prefix='260-jtc-delay-') as tmp:
    import yaml
    config={'controller_manager':{'ros__parameters':{'update_rate':200,'robot_description':urdf,'probe_controller':{'type':'joint_trajectory_controller/JointTrajectoryController'}}},'probe_controller':{'ros__parameters':{'joints':['probe_joint'],'command_interfaces':['position','velocity'],'state_interfaces':['position','velocity'],'state_publish_rate':200.0,'open_loop_control':False,'allow_partial_joints_goal':False}}}
    path=Path(tmp)/'controllers.yaml'; path.write_text(yaml.safe_dump(config))
    log=open(Path(tmp)/'controller.log','w+')
    try:
        process=subprocess.Popen(['/opt/ros/humble/lib/controller_manager/ros2_control_node','--ros-args','--params-file',str(path)],stdout=log,stderr=log)
        spawn=subprocess.run(['/opt/ros/humble/lib/controller_manager/spawner','probe_controller','--controller-manager-timeout','20'],capture_output=True,text=True,timeout=30)
        if spawn.returncode: raise RuntimeError(spawn.stdout+spawn.stderr)
        deadline=time.monotonic()+10
        while len(states)<10 and time.monotonic()<deadline: time.sleep(.05)
        assert states and pub.get_subscription_count()>0
        def run(delay, zero):
            start=states[-1].actual.positions[0]
            msg=JointTrajectory(); msg.joint_names=['probe_joint']
            if not zero:
                ns=node.get_clock().now().nanoseconds
                msg.header.stamp.sec=ns//1000000000; msg.header.stamp.nanosec=ns%1000000000
            for dt in [.2,.6]:
                point=JointTrajectoryPoint(); point.positions=[start+.002]; point.velocities=[0.]
                point.time_from_start=Duration(sec=0,nanosec=int(dt*1e9)); msg.points.append(point)
            time.sleep(delay)
            published_ns=node.get_clock().now().nanoseconds
            before=len(states); pub.publish(msg); time.sleep(1.0)
            rows=states[before:]; samples=[]
            for m in rows:
                d=m.desired
                samples.append({'stamp':m.header.stamp.sec+m.header.stamp.nanosec/1e9,'p':list(d.positions),'v':list(d.velocities),'a':list(d.accelerations),'t':d.time_from_start.sec+d.time_from_start.nanosec/1e9})
            peak_v=max(abs(x['v'][0]) for x in samples if x['v'])
            peak_a=max(abs(x['a'][0]) for x in samples if x['a'])
            moving = [x for x in samples if .01 < x['t'] < .19]
            assert len(moving) >= (8 if zero or delay == 0 else 1), 'insufficient first-segment feedback'
            final = rows[-1]
            elapsed_ns = final.desired.time_from_start.sec * 1000000000 + final.desired.time_from_start.nanosec
            stamp_ns = final.header.stamp.sec * 1000000000 + final.header.stamp.nanosec
            if zero:
                assert elapsed_ns >= 600000000
                assert stamp_ns - elapsed_ns >= published_ns, 'controller origin predates publication'
                assert abs(final.desired.positions[0] - start - .002) < 1e-9
            return {'transport_delay_s':delay,'zero_stamp':zero,'peak_v':peak_v,'peak_a':peak_a,
                    'inferred_start_after_publish_ms':(stamp_ns-elapsed_ns-published_ns)/1e6}
        results=[run(0,False),run(.15,False),run(.15,True)]
        assert results[1]['peak_v'] > .03 and results[1]['peak_a'] > 1., results
        assert results[2]['peak_v'] <= .0165 and results[2]['peak_a'] <= .33, results
        assert results[1]['peak_v'] > results[2]['peak_v'] * 2., results
        assert results[1]['peak_a'] > results[2]['peak_a'] * 5., results
        from ament_index_python.packages import get_package_share_directory
        import xml.etree.ElementTree as ET
        version = ET.parse(Path(get_package_share_directory('joint_trajectory_controller')) / 'package.xml').findtext('version')
        print(json.dumps({'jtc_version':version,'domain':224,'hardware':'mock_components/GenericSystem','results':results}))
    except Exception:
        log.flush();log.seek(0);print(log.read());raise
    finally:
        if process:
            process.terminate()
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait()
        log.close()
        executor.shutdown();thread.join(timeout=3);node.destroy_node();rclpy.shutdown()
