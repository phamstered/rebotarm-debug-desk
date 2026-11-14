#!/usr/bin/env python3
"""Bridge-owned group orchestration, isolated mocks only (domain 217)."""
import json
import os
import socket
import subprocess
import struct
import sys
import threading
import time
import uuid

import rclpy
from rclpy.executors import MultiThreadedExecutor
from moveit_msgs.action import ExecuteTrajectory
from rclpy.parameter import Parameter
from test_gripper_motion_ros import MockRobot, WebSocket, ARM, GRIPPER, wait_for


class GroupRobot(MockRobot):
    def __init__(self):
        super().__init__()
        self.starts = []
        self.hold_execution = False
        self.executing = False
        self.fail_execution = False
        self.ignore_cancel = False
        self.gripper_bias_once = 0.
        self.joint_bias_once = {}
        self.velocity_after_execute = 0.
        self.running_velocity = 0.
        self.pause_after_execute = False
        self.invalid_speed_plan = False
        self.hardware_fault = 0
        self.set_parameters([Parameter('robot_description_planning.joint_limits.%s.%s' % (joint, name), value=2.)
                             for joint in ARM for name in ['max_velocity', 'max_acceleration']])
        publisher = self.joints_pub
        robot = self
        class FeedbackPublisher:
            def publish(self, message):
                message.velocity[3] = robot.running_velocity
                publisher.publish(message)
        self.joints_pub = FeedbackPublisher()
        hardware = self.hardware_pub
        class HardwarePublisher:
            def publish(self, message):
                message.fault_code = robot.hardware_fault
                hardware.publish(message)
        self.hardware_pub = HardwarePublisher()

    def plan(self, handle):
        self.starts.append(dict(zip(handle.request.request.start_state.joint_state.name,
                                    handle.request.request.start_state.joint_state.position)))
        assert handle.request.planning_options.plan_only, 'Groups must always validate full plans'
        result = super().plan(handle)
        if self.invalid_speed_plan and result.planned_trajectory.joint_trajectory.points:
            index = result.planned_trajectory.joint_trajectory.joint_names.index('joint4')
            result.planned_trajectory.joint_trajectory.points[0].velocities[index] = 2.01
        return result

    def run(self, handle):
        self.executing = True
        while self.hold_execution and (not handle.is_cancel_requested or self.ignore_cancel):
            time.sleep(.02)
        self.executing = False
        if handle.is_cancel_requested:
            result = ExecuteTrajectory.Result()
            result.error_code.val = -7
            handle.canceled()
            return result
        if self.fail_execution:
            self.fail_execution = False
            self.executions.append(handle.request.trajectory.joint_trajectory)
            result = ExecuteTrajectory.Result()
            result.error_code.val = -1
            handle.abort()
            return result
        result = super().run(handle)
        self.positions[GRIPPER] += self.gripper_bias_once
        self.gripper_bias_once = 0.
        for name, error in self.joint_bias_once.items():
            self.positions[name] += error
        self.joint_bias_once = {}
        self.running_velocity = self.velocity_after_execute
        self.velocity_after_execute = 0.
        if self.pause_after_execute:
            self.pause = True
            self.pause_after_execute = False
        return result


class Client(WebSocket):
    def receive(self):
        message = super().receive()
        if message.get('op') == 'position_motion' and 'group_id' in message:
            self.history = getattr(self, 'history', []) + [message]
            assert isinstance(message.get('group_step_label'), str) and message['group_step_label'], message
            assert message.get('position_error_check_enforced') is False, message
        return message

    def request(self, op, **fields):
        if op == 'position_group_start':
            self.command_id = fields['command_id']
        return super().request(op, **fields)

    def oversized_group(self, **fields):
        request_id = str(uuid.uuid4())
        data = b' ' * (256 * 1024) + json.dumps(dict(op='position_group_start', request_id=request_id, **fields)).encode()
        mask = os.urandom(4)
        self.socket.sendall(bytes([129, 255]) + struct.pack('!Q', len(data)) + mask + bytes(x ^ mask[i % 4] for i, x in enumerate(data)))
        while True:
            reply = self.receive()
            if reply.get('request_id') == request_id:
                return reply


def main(binary):
    assert os.environ.get('ROS_DOMAIN_ID') == '217', 'Isolated ROS_DOMAIN_ID=217 required'
    rclpy.init()
    robot = GroupRobot()
    executor = MultiThreadedExecutor(num_threads=6)
    executor.add_node(robot)
    thread = threading.Thread(target=executor.spin, daemon=True)
    thread.start()
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1', 0))
        port = reserve.getsockname()[1]
    clients = []
    with open('/tmp/position-group-192-bridge.log', 'w') as log:
        process = subprocess.Popen([binary, '--ros-args', '-p', 'port:=%d' % port], stdout=log, stderr=log)
        try:
            def connect():
                try:
                    return Client(port)
                except OSError:
                    return None
            ws = wait_for(connect)
            other = wait_for(connect)
            clients.extend([ws, other])
            def info(client=ws):
                return client.request('position_motion_info')
            ready = wait_for(lambda: (lambda x: x if x.get('gripper_available') else None)(info()))
            assert ready['motion_group_supported'] is True, ready
            assert ready['position_error_check_enforced'] is False, ready
            def spec(hold=.8):
                return dict(group_id='test-group', label='动作组', preparation_duration_s=2., steps=[
                    dict(id='a', label='A', positions=[.05, 0., 0., 0., 0., 0.], gripper_position=.025,
                         motion_duration_s=0., hold_duration_s=hold),
                    dict(id='b', label='B', positions=[.1, 0., 0., 0., 0., 0.], gripper_position=.03,
                         motion_duration_s=3., hold_duration_s=.1)])
            def start(value=None, client=ws, command=None):
                return client.request('position_group_start', command_id=command or str(uuid.uuid4()),
                                      confirmation='ARMED', **(value or spec()))
            def event(phase=None, index=None, client=ws):
                state = info(client)
                value = client.events.get(client.command_id, {})
                if phase is not None and value.get('motion_phase') != phase:
                    return False
                if index is not None and value.get('group_index') != index:
                    return False
                return value if value else False
            def terminal(phase, client=ws):
                value = event(phase, client=client)
                return value if value and not info(client)['busy'] else False
            def observe_for(duration, check):
                until = time.monotonic() + duration
                while time.monotonic() < until:
                    info()
                    check()
                    time.sleep(.05)

            # Every step is validated before the first plan, including future gripper targets.
            assert ws.oversized_group(command_id=str(uuid.uuid4()), confirmation='ARMED', **spec())['accepted'] is False
            for mutate in [lambda s: s['steps'][1]['positions'].__setitem__(5, 2.),
                           lambda s: s['steps'][1].__setitem__('gripper_position', .06),
                           lambda s: s['steps'][0].__setitem__('motion_duration_s', 1.),
                           lambda s: s['steps'][1].__setitem__('motion_duration_s', 0.),
                           lambda s: s['steps'][1].__setitem__('hold_duration_s', -1.),
                           lambda s: s['steps'][1].__setitem__('id', 'a'),
                           lambda s: s['steps'][0].__setitem__('positions', {'x': 0.})]:
                value = spec(); mutate(value)
                assert start(value)['accepted'] is False
            assert not robot.groups and not robot.executions

            # Hold and pause retain the global motion lock across both clients.
            assert start(spec(2.))['accepted'] is True
            held = wait_for(lambda: event('waiting', 0))
            assert held['group_phase'] == 'holding' and held['group_count'] == 2
            assert len(robot.executions) == 1 and robot.groups == ['arm_with_gripper']
            command = ws.command_id
            assert ws.request('position_group_pause', command_id=command)['accepted'] is True
            paused = wait_for(lambda: event('paused', 0))
            elapsed = paused['group_elapsed_s']
            time.sleep(.4)
            paused = wait_for(lambda: event('paused', 0))
            assert abs(paused['group_elapsed_s'] - elapsed) < .05, (elapsed, paused)
            assert len(robot.executions) == 1
            assert info(other)['busy'] is True and info(other)['command_id'] == ''
            assert other.request('position_group_resume', command_id=command)['accepted'] is False
            assert other.request('position_group_pause', command_id=command)['accepted'] is False
            assert other.request('position_cancel', command_id=command)['op'] == 'error'
            for client in [ws, other]:
                assert client.request('position_move', command_id=str(uuid.uuid4()), confirmation='ARMED', positions=[0.] * 6)['accepted'] is False
                assert start(client=client)['accepted'] is False
            ws.command_id = command
            # Replaying the same ID is idempotent and never submits another Action.
            assert start(spec(2.), command=command)['accepted'] is True
            assert len(robot.groups) == 1
            assert ws.request('position_group_resume', command_id=command)['accepted'] is True
            completed = wait_for(lambda: terminal('succeeded'))
            assert completed['group_index'] == 1 and len(robot.executions) == 2
            assert robot.starts[1]['joint1'] == .05 and abs(robot.starts[1][GRIPPER] - .025) < 1e-9
            assert robot.executions[0].points[-1].time_from_start.sec == 2
            assert robot.executions[1].points[-1].time_from_start.sec == 3

            # Even with 2/2 model limits, a trajectory above the hard limit is
            # rejected before ExecuteTrajectory and cannot start a later step.
            robot.invalid_speed_plan = True
            before = len(robot.executions)
            value = spec(); value['preparation_duration_s'] = 6.
            assert start(value)['accepted'] is True
            wait_for(lambda: terminal('failed'))
            assert len(robot.executions) == before
            robot.invalid_speed_plan = False

            # Field HOME reproduction: successful Action + fresh stopped
            # feedback progresses despite nominal arm/gripper endpoint errors.
            value = spec(.3)
            value['preparation_duration_s'] = 5.
            value['steps'][0].update(label='HOME', positions=[0.] * 6)
            robot.joint_bias_once = {'joint4': -.043679}
            robot.gripper_bias_once = .002
            before = len(robot.groups)
            assert start(value)['accepted'] is True
            home = wait_for(lambda: event('waiting', 0))
            assert home['group_step_label'] == 'HOME' and home['group_phase'] == 'holding', home
            assert home['position_error_check_enforced'] is False
            errors = {e['joint_name']: e for e in home['arrival_errors']}
            assert abs(errors['joint4']['actual'] + .043679) < 1e-9 and errors['joint4']['target'] == 0., errors
            assert errors['joint4']['position_error'] < -.0436 and errors['joint4']['position_tolerance'] == .02
            assert errors['joint4']['velocity_tolerance'] == .03 and errors['joint4']['unit'] == 'rad'
            assert abs(errors[GRIPPER]['position_error'] - .002) < 1e-9
            completed = wait_for(lambda: terminal('succeeded'))
            assert len(robot.groups) == before + 2
            assert abs(robot.starts[-1]['joint4'] + .043679) < 1e-9
            frozen = completed['arrival_errors']
            robot.positions['joint1'] += .1
            time.sleep(.15)
            assert wait_for(lambda: event('succeeded'))['arrival_errors'] == frozen
            robot.positions['joint1'] -= .1

            # Successful Action alone cannot advance until velocity is stopped.
            robot.velocity_after_execute = .04
            before = len(robot.groups)
            assert start()['accepted'] is True
            wait_for(lambda: event('verifying', 0))
            time.sleep(.6)
            assert info()['busy'] is True and len(robot.groups) == before + 1
            ws.request('position_cancel', command_id=ws.command_id)
            time.sleep(.3)
            assert info()['busy'] is True and len(robot.groups) == before + 1
            robot.running_velocity = 0.
            wait_for(lambda: terminal('canceled'))

            # No fresh post-result feedback means no arrival snapshot and no B.
            robot.pause_after_execute = True
            before = len(robot.groups)
            assert start()['accepted'] is True
            time.sleep(1.3)
            assert info()['busy'] is True and len(robot.groups) == before + 1
            value = event()
            assert value.get('arrival_errors') is None, value
            robot.pause = False
            wait_for(lambda: terminal('failed'))

            # Zero hold does not emit an artificial single-sample waiting check.
            value = spec(0.); value['steps'][1]['hold_duration_s'] = 0.
            before = len(robot.groups)
            assert start(value)['accepted'] is True
            zero_command = ws.command_id
            wait_for(lambda: terminal('succeeded'))
            assert len(robot.groups) == before + 2
            assert not [e for e in ws.history if e['command_id'] == zero_command and e['motion_phase'] == 'waiting']

            # Temporary velocity excursions freeze hold until a fresh 200ms
            # stable window; they do not cancel or consume remaining hold time.
            assert start(spec(2.))['accepted'] is True
            wait_for(lambda: event('waiting', 0))
            before = len(robot.groups)
            high_at = time.monotonic(); robot.running_velocity = .04
            def no_advance():
                assert len(robot.groups) == before and info()['busy'] is True
                assert ws.events[ws.command_id]['motion_phase'] not in ('canceling', 'failed', 'canceled')
            observe_for(.45, no_advance)
            assert event()['motion_phase'] == 'verifying'
            robot.running_velocity = 0.; low_at = time.monotonic()
            observe_for(.15, no_advance)
            wait_for(lambda: (info(), len(robot.groups) == before + 1)[1])
            assert time.monotonic() - low_at > 1.5 and time.monotonic() - high_at > 2., 'Hold consumed during recovery'
            wait_for(lambda: terminal('succeeded'))

            # Pause/resume, including zero hold, cannot bypass recovery.
            robot.hold_plan = True
            assert start(spec(0.))['accepted'] is True
            ws.request('position_group_pause', command_id=ws.command_id)
            robot.hold_plan = False
            wait_for(lambda: event('paused', 0))
            before = len(robot.groups); robot.running_velocity = .04
            observe_for(.2, lambda: None)
            recovering = event('verifying', 0)
            assert recovering and recovering['group_phase'] == 'paused'
            assert ws.request('position_group_resume', command_id=ws.command_id)['accepted'] is False
            robot.running_velocity = 0.
            assert ws.request('position_group_resume', command_id=ws.command_id)['accepted'] is False
            observe_for(.35, lambda: None)
            assert len(robot.groups) == before
            assert ws.request('position_group_resume', command_id=ws.command_id)['accepted'] is True
            wait_for(lambda: terminal('succeeded'))

            # A 5s velocity timeout freezes the triggering hold-reference sample
            # separately from subsequent zero-velocity nominal arrival snapshots.
            assert start(spec(1.))['accepted'] is True
            wait_for(lambda: event('waiting', 0))
            before = len(robot.groups); robot.running_velocity = .04
            trigger = wait_for(lambda: (lambda e: e if e and e.get('hold_failure') else False)(event()), timeout=8)
            failure = trigger['hold_failure']
            assert failure['reason'] == 'velocity_timeout' and failure['phase'] == 'holding', failure
            assert failure['feedback_age_ms'] < 1000 and failure['required_stable_ms'] == 200
            assert next(e for e in failure['samples'] if e['joint_name'] == 'joint4')['velocity'] == .04
            assert info()['busy'] is True and len(robot.groups) == before
            robot.running_velocity = 0.
            failed = wait_for(lambda: terminal('failed'))
            assert failed['hold_failure'] == failure
            assert next(e for e in failed['arrival_errors'] if e['joint_name'] == 'joint4')['velocity'] == 0.

            # Explicit cancellation during recovery preserves fresh stop gating.
            assert start(spec(2.))['accepted'] is True
            wait_for(lambda: event('waiting', 0))
            before = len(robot.groups); robot.running_velocity = .04
            observe_for(.2, lambda: None)
            ws.request('position_cancel', command_id=ws.command_id)
            observe_for(.2, lambda: None)
            assert info()['busy'] is True
            robot.running_velocity = 0.
            canceled = wait_for(lambda: terminal('canceled'))
            assert 'hold_failure' not in canceled and len(robot.groups) == before

            # Fault gates remain immediate while the 5s recovery window is open.
            assert start(spec(2.))['accepted'] is True
            wait_for(lambda: event('waiting', 0))
            before = len(robot.groups); robot.running_velocity = .04
            observe_for(.2, lambda: None)
            robot.hardware_fault = 1
            observe_for(.2, lambda: None)
            assert info()['busy'] is True and len(robot.groups) == before
            robot.running_velocity = 0.
            failed = wait_for(lambda: terminal('failed'))
            assert 'hold_failure' not in failed
            robot.hardware_fault = 0
            wait_for(lambda: info()['gripper_available'])

            # Missing gripper target holds fresh measured opening, with a full
            # seven-axis path/arrival/hold check rather than dropping joint7.
            # A's valid 0.8mm endpoint error must not cause B's 0.1mm path-hold
            # constraint to pull it back to the old nominal target or reject B.
            value = spec(0.)
            del value['steps'][1]['gripper_position']
            value['steps'][1]['hold_duration_s'] = 4.
            robot.gripper_bias_once = .0008
            assert start(value)['accepted'] is True
            wait_for(lambda: event('waiting', 1))
            last = robot.executions[-1]
            assert GRIPPER in last.joint_names
            assert abs(last.points[-1].positions[last.joint_names.index(GRIPPER)] - .0258) < 1e-9
            before = len(robot.groups)
            robot.positions[GRIPPER] = .035
            failed = wait_for(lambda: terminal('failed'))
            failure = failed['hold_failure']
            assert failure['reason'] == 'position_drift' and failure['phase'] == 'holding'
            grip = next(e for e in failure['samples'] if e['joint_name'] == GRIPPER)
            assert abs(grip['target'] - .0258) < 1e-9 and abs(grip['actual'] - .035) < 1e-9
            assert abs(grip['position_error'] - .0092) < 1e-9
            robot.positions[GRIPPER] = .0258
            time.sleep(.15)
            assert event('failed')['hold_failure'] == failure
            assert len(robot.groups) == before

            # Pause requested during planning is applied only after execute+200ms settle.
            robot.hold_plan = True
            before = len(robot.executions)
            plan_count = len(robot.groups)
            assert start()['accepted'] is True
            wait_for(lambda: len(robot.groups) == plan_count + 1)
            reply = ws.request('position_group_pause', command_id=ws.command_id)
            assert reply['accepted'] is True and reply['pending'] is True
            assert event()['motion_phase'] != 'paused'
            robot.hold_plan = False
            wait_for(lambda: event('paused', 0))
            assert len(robot.executions) == before + 1
            ws.request('position_cancel', command_id=ws.command_id)
            wait_for(lambda: terminal('canceled'))
            time.sleep(.3)
            assert len(robot.executions) == before + 1

            # A canceled admitted plan must not be executed by a late result.
            robot.hold_plan = True
            before = len(robot.executions)
            plan_count = len(robot.groups)
            assert start()['accepted'] is True
            wait_for(lambda: len(robot.groups) == plan_count + 1)
            ws.request('position_cancel', command_id=ws.command_id)
            robot.hold_plan = False
            wait_for(lambda: terminal('canceled'))
            assert len(robot.executions) == before

            # The same pause rule holds while the Execute Action is active:
            # acknowledgement is pending, not an immediate mid-trajectory stop.
            robot.hold_execution = True
            assert start()['accepted'] is True
            wait_for(lambda: robot.executing)
            reply = ws.request('position_group_pause', command_id=ws.command_id)
            assert reply['accepted'] is True and reply['pending'] is True
            assert event()['motion_phase'] != 'paused'
            robot.hold_execution = False
            wait_for(lambda: event('paused', 0))
            ws.request('position_cancel', command_id=ws.command_id)
            wait_for(lambda: terminal('canceled'))

            # Failure on A stops the group; B is never planned or sent.
            robot.fail_execution = True
            before = len(robot.groups)
            assert start()['accepted'] is True
            wait_for(lambda: terminal('failed'))
            assert len(robot.groups) == before + 1

            # Missing feedback during hold cancels the group but cannot confirm
            # stop or release the lock until fresh healthy feedback returns.
            assert start(spec(6.))['accepted'] is True
            wait_for(lambda: event('waiting', 0))
            before = len(robot.groups)
            robot.pause = True
            time.sleep(1.3)
            assert info()['busy'] is True
            assert start(client=other)['accepted'] is False
            robot.pause = False
            wait_for(lambda: terminal('failed'))
            assert len(robot.groups) == before

            # A model change during hold fails the entire group without dispatching B.
            before = len(robot.groups)
            assert start(spec(6.))['accepted'] is True
            wait_for(lambda: event('waiting', 0))
            robot.set_parameters([Parameter('trajectory_execution.allowed_start_tolerance', value=.009)])
            wait_for(lambda: terminal('failed'))
            assert len(robot.groups) == before + 1

            # Lease expiry while paused cancels independently of desktop timers.
            assert start(spec(6.))['accepted'] is True
            wait_for(lambda: event('waiting', 0))
            ws.request('position_group_pause', command_id=ws.command_id)
            wait_for(lambda: event('paused', 0))
            before = len(robot.groups)
            robot.running_velocity = .04
            until = time.monotonic() + 5.6
            while time.monotonic() < until:
                # Shared observers and wrong-owner heartbeats must not renew
                # this lease, even though its WebSocket is still connected.
                assert ws.request('position_motion_observe')['op'] == 'position_motion_info'
                assert other.request('position_motion_heartbeat', command_id=ws.command_id)['renewed'] is False
                time.sleep(.1)
            assert info()['busy'] is True
            robot.running_velocity = 0.
            expired = wait_for(lambda: terminal('canceled'))
            assert 'hold_failure' not in expired
            assert len(robot.groups) == before

            # Correlated terminal proof is readable by a new connection, and
            # preserves group metadata after another task replaces current.
            expired_id = ws.command_id
            proof = other.request('position_task_status', command_id=expired_id)
            assert proof['known'] is True and proof['terminal'] is True
            assert proof['motion_phase'] == 'canceled'
            assert proof['motion_state']['command_id'] == expired_id
            assert proof['motion_state']['group_id'] == 'test-group'
            assert other.request('position_task_status', command_id='unknown')['known'] is False
            assert ws.request('position_motion_heartbeat', command_id=expired_id)['renewed'] is False

            # An unconfirmed Action cancellation remains locked in stop_failed,
            # including against a new command from the same owner.
            robot.hold_execution = True
            robot.ignore_cancel = True
            assert start()['accepted'] is True
            wait_for(lambda: robot.executing)
            command = ws.command_id
            assert ws.request('position_motion_heartbeat', command_id=command)['renewed'] is True
            assert other.request('position_task_status', command_id=expired_id)['motion_state']['motion_phase'] == 'canceled'
            before = len(robot.groups)
            ws.request('position_cancel', command_id=command)
            wait_for(lambda: event('stop_failed'), timeout=8)
            assert info()['busy'] is True
            assert start()['accepted'] is False
            ws.command_id = command
            assert len(robot.groups) == before
            robot.ignore_cancel = False
            wait_for(lambda: terminal('canceled'))
            robot.hold_execution = False

            # Disconnect during an accepted execution cancels it and cannot start B.
            robot.hold_execution = True
            assert start()['accepted'] is True
            wait_for(lambda: robot.executing)
            before = len(robot.groups)
            ws.socket.close()
            wait_for(lambda: not info(other)['busy'])
            proof = other.request('position_task_status', command_id=ws.command_id)
            assert proof['known'] is True and proof['terminal'] is True and proof['motion_phase'] == 'canceled', proof
            robot.hold_execution = False
            time.sleep(.3)
            assert len(robot.groups) == before
            with open('/tmp/position-group-192-bridge.log') as bridge_log:
                assert bridge_log.read().count('[hold_failure]') == 2, 'Failure snapshots must log once, without replay duplicates'
            print(json.dumps(dict(ok=True, groups=len(robot.groups), executions=len(robot.executions))))
        finally:
            for client in clients:
                client.socket.close()
            process.terminate()
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait()
            executor.shutdown(timeout_sec=5)
            robot.destroy_node()
            rclpy.shutdown()
            thread.join(timeout=5)


if __name__ == '__main__':
    main(sys.argv[1])
