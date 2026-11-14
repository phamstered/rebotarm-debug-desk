#!/usr/bin/env python3
"""Real Bridge adapter with mock ROS publishers ONLY, isolated domain 221."""
import os
import copy
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid

import rclpy
from rclpy.executors import MultiThreadedExecutor
from rclpy.qos import qos_profile_sensor_data
from control_msgs.msg import JointTrajectoryControllerState
from sensor_msgs.msg import JointState
from trajectory_msgs.msg import JointTrajectory
from microros_stm32h723_bridge.msg import HardwareStatus, JointCommand
from test_gripper_motion_ros import MockRobot, WebSocket, wait_for, ARM, GRIPPER, SCALE, OFFSET


class Robot(MockRobot):
    def __init__(self):
        self.trajectories = []
        self.commands = []
        self.mode = HardwareStatus.MODE_TRACK
        self.sequence = 0
        self.frozen = None
        self.omit_reference = False
        self.stale_state = False
        self.follow = True
        self.reference_goal = {}
        self.ends = {}
        self.starts = {}
        super().__init__()
        # Direct JTC must not depend on either MoveIt Action server being up.
        self.move.destroy()
        self.execute.destroy()
        self.subs = [self.create_subscription(JointTrajectory, '/' + name + '/joint_trajectory',
                                             self.trajectory, 10)
                     for name in ['arm_trajectory_controller', 'gripper_trajectory_controller']]
        self.command_sub = self.create_subscription(JointCommand, '/stm32/joint_commands', self.disable, qos_profile_sensor_data)

    def trajectory(self, msg):
        self.trajectories.append(msg)
        duration = msg.points[-1].time_from_start
        assert msg.header.stamp.sec == 0 and msg.header.stamp.nanosec == 0, "JTC must start at consumption"
        start = self.get_clock().now().nanoseconds / 1e9
        end = start + duration.sec + duration.nanosec / 1e9
        for name, value in zip(msg.joint_names, msg.points[-1].positions):
            self.reference_goal[name] = value
            self.ends[name] = end
            self.starts[name] = start
            if self.follow:
                self.positions[name] = value

    def disable(self, msg):
        self.commands.append(msg)
        assert msg.mode == 3
        assert all(x == 0 for values in [msg.position, msg.velocity, msg.kp, msg.kd, msg.effort] for x in values)
        self.mode = msg.mode
        self.sequence = msg.sequence

    def publish(self):
        if self.pause:
            return
        stamp = self.frozen or self.get_clock().now().to_msg()
        now = self.get_clock().now().nanoseconds / 1e9
        names = ARM + [GRIPPER]
        joint = JointState()
        joint.header.stamp = stamp
        joint.name = names
        joint.position = [self.positions[j] for j in ARM] + [(self.positions[GRIPPER] - OFFSET) / SCALE]
        joint.velocity = [0.] * 7
        self.joints_pub.publish(joint)
        broadcast = JointState()
        broadcast.header.stamp = stamp
        broadcast.name = names
        broadcast.position = [self.positions[j] for j in names]
        broadcast.velocity = [0.] * 7
        self.broadcaster_pub.publish(broadcast)
        for publisher, names in [(self.arm_pub, ARM), (self.gripper_pub, [GRIPPER])]:
            state = JointTrajectoryControllerState()
            state.header.stamp = stamp
            if self.stale_state:
                state.header.stamp = copy.deepcopy(stamp)
                state.header.stamp.sec -= 2
            state.joint_names = names
            state.actual.positions = [self.positions[j] for j in names]
            state.actual.velocities = [0.] * len(names)
            if not self.omit_reference:
                state.desired.positions = [self.reference_goal.get(j, self.positions[j]) for j in names]
                elapsed = max(0, int((now - self.starts.get(names[0], now)) * 1e9))
                state.desired.time_from_start.sec = elapsed // 1000000000
                state.desired.time_from_start.nanosec = elapsed % 1000000000
                state.desired.velocities = [0. if now >= self.ends.get(j, 0.) else .001 for j in names]
            publisher.publish(state)
        hw = HardwareStatus()
        hw.header.stamp = stamp
        hw.mode = self.mode
        hw.active_joint_mask = 127
        hw.last_command_sequence = self.sequence
        self.hardware_pub.publish(hw)


def main(binary):
    assert os.environ.get('ROS_DOMAIN_ID') == '221'
    assert os.environ.get('ROS_LOCALHOST_ONLY') == '1'
    rclpy.init()
    robot = Robot()
    executor = MultiThreadedExecutor(num_threads=4)
    executor.add_node(robot)
    thread = threading.Thread(target=executor.spin, daemon=True)
    thread.start()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    with open('/tmp/260-trajectory-task-ros.log', 'w') as log:
        process = subprocess.Popen([binary, '--ros-args', '-p', 'port:=%d' % port], stdout=log, stderr=log)
        clients = []
        try:
            def connect():
                try:
                    return WebSocket(port)
                except OSError:
                    return None
            ws = wait_for(connect)
            clients.append(ws)
            other = WebSocket(port)
            clients.append(other)
            def request(client=ws, gripper=False, duration=1.2, **extras):
                names = [GRIPPER] if gripper else ARM
                start = [robot.positions[n] for n in names]
                goal = [p + (.001 if gripper else .02) for p in start]
                args = dict(command_id=str(uuid.uuid4()),
                            topic='/%s_trajectory_controller/joint_trajectory' % ('gripper' if gripper else 'arm'),
                            joint_names=names,
                            trajectory_points=[dict(positions=start, velocities=[0.] * len(names), time_from_start=.1),
                                               dict(positions=goal, velocities=[0.] * len(names), time_from_start=duration)])
                args.update(extras)
                return args, client.request('trajectory_command', **args)

            # Model/feedback startup refusals must prove no publication.
            def ready():
                args, reply = request()
                if reply.get('accepted'):
                    return args
                assert reply.get('evidence') == 'not_published', reply
                return None
            args = wait_for(ready)
            ident = args['command_id']
            query = lambda cid=ident, client=ws: client.request('trajectory_task_status', command_id=cid)
            assert not query()['terminal']
            assert not other.request('trajectory_heartbeat', command_id=ident)['renewed']
            assert ws.request('trajectory_heartbeat', command_id=ident)['renewed']
            duplicate = ws.request('trajectory_command', **args)
            assert duplicate['op'] == 'error', duplicate
            blocked, reply = request(other)
            assert reply.get('evidence') == 'not_published', reply
            assert query(blocked['command_id'])['result']['evidence'] == 'not_published'
            assert ws.request('position_move', command_id=str(uuid.uuid4()), confirmation='ARMED', positions=[0.] * 6)['accepted'] is False
            done = wait_for(lambda: (x if x['terminal'] else None) if (x := query()) else None)
            assert done['result']['evidence'] == 'target_observed', done
            assert len(robot.trajectories) == 1
            assert not robot.commands
            assert query('unknown')['known'] is False
            assert query('unknown')['terminal'] is False
            # Completion is retained for a different socket without replay.
            assert query(ident, other)['result'] == done['result']

            # Strict parser, controller whitelist, dynamic bounds and nanosecond resolution.
            for extras in [dict(extra=True), dict(topic='/other/joint_trajectory'),
                           dict(trajectory_points=[dict(positions=[0.] * 6, time_from_start=.1, bogus=0)]),
                           dict(trajectory_points=[dict(positions=[.8] * 6, velocities=[0.] * 6, time_from_start=.1)]),
                           dict(trajectory_points=[dict(positions=[.02] * 6, time_from_start=.1),
                                                   dict(positions=[.02] * 6, time_from_start=.10000000001)])]:
                bad, reply = request(**extras)
                assert reply.get('evidence') == 'not_published', reply
                assert query(bad['command_id'])['terminal']
            assert len(robot.trajectories) == 1

            robot.stale_state = True
            time.sleep(.2)
            bad, reply = request()
            assert reply.get('evidence') == 'not_published', reply
            assert '时间戳' in reply['message'], reply
            robot.stale_state = False
            time.sleep(.2)

            # Gripper raw angle is converted to metres using saved calibration.
            grip, reply = request(gripper=True)
            assert reply.get('accepted'), reply
            wait_for(lambda: query(grip['command_id'])['terminal'])
            assert query(grip['command_id'])['result']['evidence'] == 'target_observed'

            # Output-off is insufficient while reference is missing. Once a
            # fresh terminal reference returns, independent feedback confirms stop.
            robot.follow = False
            cancel, reply = request(duration=1.5)
            assert reply.get('accepted'), reply
            robot.omit_reference = True
            assert other.request('trajectory_cancel', command_id=cancel['command_id'])['accepted']
            wait_for(lambda: len(robot.commands) >= 3)
            time.sleep(1.7)
            assert query(cancel['command_id'])['terminal'] is False
            robot.omit_reference = False
            wait_for(lambda: query(cancel['command_id'])['terminal'])
            assert query(cancel['command_id'])['result']['evidence'] == 'output_disabled'
            sequences = [m.sequence for m in robot.commands]
            assert len(sequences) == len(set(sequences))

            # Disconnect cancels the owner; another socket cannot keep it alive.
            robot.mode = HardwareStatus.MODE_TRACK
            robot.follow = True
            robot.reference_goal.clear()
            time.sleep(.2)
            lost, reply = request(client=other, duration=1.5)
            assert reply.get('accepted'), reply
            other.socket.close()
            wait_for(lambda: query(lost['command_id'])['terminal'])
            assert query(lost['command_id'])['result']['evidence'] == 'output_disabled'
            assert len(robot.trajectories) == 4
            # Read-only polling and fresh ROS data must not extend the lease.
            robot.mode = HardwareStatus.MODE_TRACK
            robot.follow = False
            robot.reference_goal.clear()
            time.sleep(.2)
            leased, reply = request(duration=2.)
            assert reply.get('accepted'), reply
            started = time.monotonic()
            while time.monotonic() - started < 4.5:
                assert not query(leased['command_id'])['terminal']
                time.sleep(.1)
            wait_for(lambda: query(leased['command_id'])['terminal'], timeout=4)
            assert query(leased['command_id'])['result']['evidence'] == 'output_disabled'
            assert len(robot.trajectories) == 5
            assert not robot.groups and not robot.executions
            print('Direct JTC ROS adapter: admission, parser, bounds, feedback, gripper units, cancellation, disconnect, lease, retention PASS')
        finally:
            for client in clients:
                client.socket.close()
            process.send_signal(signal.SIGINT)
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            executor.shutdown()
            robot.destroy_node()
            rclpy.shutdown()
            thread.join(timeout=3)


if __name__ == '__main__':
    main(sys.argv[1])
