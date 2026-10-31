#!/usr/bin/env python3
"""Synthetic MoveIt/controller/MCU E2E. Requires explicit isolated ROS domain.

ROS_DOMAIN_ID=225 ROBOT_CONSOLE_BRIDGE_PORT=18769 \
BRIDGE_TEST_BINARY=/path/to/bridge_node python3 test_position_motion.py
No physical controllers or motor outputs are used.
"""
import os
import subprocess
import threading
import time
from pathlib import Path

import rclpy
from rclpy.action import ActionServer, CancelResponse, GoalResponse
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from rclpy.parameter import Parameter
from ament_index_python.packages import get_package_share_directory
from control_msgs.msg import JointTrajectoryControllerState
from controller_manager_msgs.msg import ControllerState
from controller_manager_msgs.srv import ListControllers
from microros_stm32h723_bridge.msg import HardwareStatus
from moveit_msgs.action import MoveGroup, ExecuteTrajectory
from trajectory_msgs.msg import JointTrajectoryPoint
from sensor_msgs.msg import JointState
from test_image_topic import websocket_connect, send_json, receive_message

NAMES = [f"joint{i}" for i in range(1, 7)]

class Fixture(rclpy.node.Node):
    def __init__(self):
        super().__init__("move_group")
        self.group = ReentrantCallbackGroup()
        self.q = [0., -.2, -.3, 0., 0., 0.]
        self.active = True; self.fault = 0; self.publish_feedback = True; self.speed = 0.; self.state_offset = 0.
        self.goals = []; self.starts = []; self.path_constraints = []; self.canceled = 0
        self.reference_offset = 0.; self.reference_speed = 0.; self.omit_reference = False; self.velocity_claimed = True
        self.joint_positions = None
        self.executions = []; self.plan_delay = 0.; self.plan_kind = "normal"
        self.slow_execution = False; self.reject_execution = False; self.fail_execution = False
        urdf = Path(get_package_share_directory("rebotarm_gazebo")) / "urdf/rebotarm.urdf"
        srdf = Path(get_package_share_directory("rebotarm_moveit_config")) / "config/rebotarm.srdf"
        params = {"robot_description": urdf.read_text(), "robot_description_semantic": srdf.read_text(),
                  "moveit_manage_controllers": False, "moveit_controller_manager": "moveit_simple_controller_manager/MoveItSimpleControllerManager",
                  "moveit_simple_controller_manager.controller_names": ["arm_trajectory_controller"],
                  "moveit_simple_controller_manager.arm_trajectory_controller.joints": NAMES,
                  "moveit_simple_controller_manager.arm_trajectory_controller.type": "FollowJointTrajectory",
                  "moveit_simple_controller_manager.arm_trajectory_controller.action_ns": "follow_joint_trajectory",
                  "trajectory_execution.allowed_start_tolerance": .01}
        for name in NAMES:
            for field, value in [("max_velocity", .5), ("max_acceleration", .5), ("has_velocity_limits", True), ("has_acceleration_limits", True)]:
                params[f"robot_description_planning.joint_limits.{name}.{field}"] = value
        for key, value in params.items(): self.declare_parameter(key, value)
        self.pub_joint = self.create_publisher(JointState, "/stm32/joint_states", 10)
        self.pub_state = self.create_publisher(JointTrajectoryControllerState, "/arm_trajectory_controller/controller_state", 10)
        self.pub_hw = self.create_publisher(HardwareStatus, "/stm32/status", 10)
        self.create_service(ListControllers, "/controller_manager/list_controllers", self.controllers, callback_group=self.group)
        self.server = ActionServer(self, MoveGroup, "/move_action", self.execute, callback_group=self.group,
                                   cancel_callback=lambda _: CancelResponse.ACCEPT,
                                   goal_callback=lambda goal: GoalResponse.REJECT if abs(goal.request.goal_constraints[0].joint_constraints[0].position-.6)<1e-6 else GoalResponse.ACCEPT)
        self.execution_server = ActionServer(self, ExecuteTrajectory, "/execute_trajectory", self.execute_trajectory,
            callback_group=self.group, cancel_callback=lambda _: CancelResponse.ACCEPT,
            goal_callback=lambda _: GoalResponse.REJECT if self.reject_execution else GoalResponse.ACCEPT)
        self.create_timer(.03, self.publish, callback_group=self.group)
    def controllers(self, request, response):
        c = ControllerState(); c.name = "arm_trajectory_controller"; c.type = "joint_trajectory_controller/JointTrajectoryController"
        c.state = "active" if self.active else "inactive"
        c.claimed_interfaces = [j+"/position" for j in NAMES] + ([j+"/velocity" for j in NAMES] if self.velocity_claimed else [])
        response.controller = [c]; return response
    def publish(self):
        if not self.publish_feedback: return
        q = list(self.q)
        j = JointState(); j.header.stamp = self.get_clock().now().to_msg(); j.name = NAMES; j.position = q if self.joint_positions is None else self.joint_positions; j.velocity = [self.speed]*6; j.effort = [0.]*6; self.pub_joint.publish(j)
        s = JointTrajectoryControllerState(); s.joint_names = NAMES; s.actual.positions = [q[0]+self.state_offset]+q[1:]; s.actual.velocities = [0.]*6
        if not self.omit_reference:
            s.desired.positions = q[:2]+[q[2]+self.reference_offset]+q[3:]
            s.desired.velocities = [self.reference_speed]*6
        self.pub_state.publish(s)
        h = HardwareStatus(); h.mode = HardwareStatus.MODE_TRACK; h.fault_code = self.fault; h.active_joint_mask = 0x3f; self.pub_hw.publish(h)
    def execute(self, handle):
        goal = handle.request
        assert goal.request.group_name == "arm" and goal.request.pipeline_id == "ompl"
        assert not goal.planning_options.replan
        assert goal.request.max_velocity_scaling_factor <= .2
        assert goal.request.start_state.joint_state.name == NAMES
        self.starts.append(list(goal.request.start_state.joint_state.position))
        constraints = goal.request.goal_constraints[0].joint_constraints
        assert [c.joint_name for c in constraints] == NAMES
        target = [c.position for c in constraints]; self.goals.append(target)
        self.path_constraints.append(goal.request.path_constraints.joint_constraints)
        fb = MoveGroup.Feedback(); fb.state = "PLANNING"; handle.publish_feedback(fb)
        result = MoveGroup.Result()
        if abs(target[0]-.5)<1e-6:
            result.error_code.val = -12; handle.abort(); return result
        if goal.planning_options.plan_only:
            until=time.monotonic()+self.plan_delay
            while time.monotonic()<until:
                if handle.is_cancel_requested:
                    self.canceled+=1;result.error_code.val=-7;handle.canceled();return result
                time.sleep(.02)
            trajectory=result.planned_trajectory.joint_trajectory
            trajectory.joint_names=NAMES
            for seconds, positions in ((0,goal.request.start_state.joint_state.position),(2,target)):
                point=JointTrajectoryPoint();point.positions=list(positions)
                held={c.joint_name for c in goal.request.path_constraints.joint_constraints}
                point.velocities=[0. if name in held else .1 for name in NAMES]
                point.accelerations=[0. if name in held else .2 for name in NAMES];point.time_from_start.sec=seconds
                trajectory.points.append(point)
            if self.plan_kind=="empty":trajectory.points=[]
            if self.plan_kind=="bad-start":trajectory.points[0].positions[0]+=.05
            if self.plan_kind=="bad-end":trajectory.points[-1].positions[0]+=.05
            if self.plan_kind=="bad-time":trajectory.points[-1].time_from_start.sec=0
            result.error_code.val=1;handle.succeed();return result
        fb.state = "MONITOR"; handle.publish_feedback(fb)
        for _ in range(200 if abs(target[0]-.7)<1e-6 else 50 if abs(target[0]-.4)<1e-6 else 8):
            if handle.is_cancel_requested:
                self.canceled += 1; result.error_code.val = -7; handle.canceled(); return result
            time.sleep(.05)
        if abs(target[0]-.3)>1e-6:self.q = target
        result.error_code.val = 1; handle.succeed(); return result


    def execute_trajectory(self, handle):
        trajectory=handle.request.trajectory.joint_trajectory
        assert trajectory.joint_names==NAMES
        self.executions.append(trajectory)
        result=ExecuteTrajectory.Result()
        for _ in range(200 if self.slow_execution else 8):
            if handle.is_cancel_requested:
                self.canceled+=1;result.error_code.val=-7;handle.canceled();return result
            time.sleep(.05)
        if self.fail_execution:
            result.error_code.val=-4;handle.abort();return result
        self.q=list(trajectory.points[-1].positions)
        result.error_code.val=1;handle.succeed();return result

def main():
    domain = int(os.environ.get("ROS_DOMAIN_ID", "0"))
    assert 200 <= domain <= 232, "isolated test domain required"
    binary = os.environ["BRIDGE_TEST_BINARY"]
    port = int(os.environ.get("ROBOT_CONSOLE_BRIDGE_PORT", "18769"))
    rclpy.init(); fixture = Fixture(); executor = MultiThreadedExecutor(num_threads=4); executor.add_node(fixture)
    thread = threading.Thread(target=executor.spin, daemon=True); thread.start()
    log = open("/tmp/codex-position-motion-e2e-bridge.log", "w")
    process = subprocess.Popen([binary, "--ros-args", "-p", f"port:={port}", "-p", "status_topic:=/stm32/status"], stdout=log, stderr=log)
    sock = other = None; sequence = 0
    def connect():
        end = time.monotonic()+10
        while time.monotonic()<end:
            try: return websocket_connect()
            except (ConnectionError, OSError): time.sleep(.1)
        raise RuntimeError("Bridge did not start")
    def request(op, connection=None, **fields):
        nonlocal sequence
        sequence += 1; rid = f"r{sequence}"; connection = connection or sock
        send_json(connection, dict(op=op, request_id=rid, **fields))
        while True:
            m = receive_message(connection)
            if m.get("request_id") == rid: return m
    def ready():
        end = time.monotonic()+12
        while time.monotonic()<end:
            m = request("position_motion_info")
            if m.get("available"): return m
            time.sleep(.1)
        raise AssertionError(m)
    def terminal(command):
        end = time.monotonic()+12; phases=[]
        while time.monotonic()<end:
            m = receive_message(sock)
            if m.get("command_id") != command: continue
            phases.append(m.get("motion_phase"))
            if m.get("motion_phase") in ("succeeded", "failed", "canceled"): return m,phases
        raise AssertionError(phases)
    def move(command, x=.2, **fields):
        return request("position_move", command_id=command, label=command, confirmation="ARMED", positions=[x,-.2,-.3,0.,0.,0.], **fields)
    try:
        sock = connect(); info = ready()
        assert info["joint_rotation_supported"] is True, info
        assert info["home_positions"] == [0.,-.01,-.01,0.,0.,0.], info
        assert info["joint_targets_supported"] and info["motion_duration_supported"],info
        all_targets=dict(zip(NAMES,[.1,-.1,-.2,.05,.03,-.02]))
        before=list(fixture.q);count=len(fixture.goals)
        accepted=request("position_move",command_id="six-timed",confirmation="ARMED",joint_targets=all_targets,motion_duration_s=5.)
        assert accepted.get("accepted") is not False,accepted
        result,phases=terminal("six-timed");assert result["motion_phase"]=="succeeded",result
        assert "executing" in phases and "verifying" in phases,phases
        assert len(fixture.goals)==count+1 and len(fixture.executions)==1
        trajectory=fixture.executions[-1]
        assert list(trajectory.points[0].positions)==before and list(trajectory.points[-1].positions)==list(all_targets.values()),trajectory
        assert trajectory.points[-1].time_from_start.sec==5 and trajectory.points[-1].time_from_start.nanosec==0
        assert abs(trajectory.points[-1].velocities[0]-.04)<1e-9
        assert abs(trajectory.points[-1].accelerations[0]-.032)<1e-9
        assert not fixture.path_constraints[-1]
        ready();before=list(fixture.q)
        accepted=request("position_move",command_id="partial-timed",confirmation="ARMED",joint_targets={"joint2":-.15,"joint4":.12},motion_duration_s=2.)
        assert accepted.get("accepted") is not False,accepted
        result,_=terminal("partial-timed");assert result["motion_phase"]=="succeeded",result
        expected=before[:];expected[1]=-.15;expected[3]=.12
        assert list(fixture.executions[-1].points[-1].positions)==expected
        assert [c.joint_name for c in fixture.path_constraints[-1]]==["joint1","joint3","joint5","joint6"]
        count=len(fixture.executions)
        for label,seconds,kind in (("too-short",1.,"normal"),("empty-plan",5.,"empty"),
                                   ("bad-plan-start",5.,"bad-start"),("bad-plan-end",5.,"bad-end"),
                                   ("bad-plan-time",5.,"bad-time")):
            fixture.plan_kind=kind;ready()
            accepted=request("position_move",command_id=label,confirmation="ARMED",joint_targets={"joint2":-.12},motion_duration_s=seconds)
            assert accepted.get("accepted") is not False,accepted
            result,_=terminal(label);assert result["motion_phase"]=="failed",result
            assert len(fixture.executions)==count,"invalid or too-short plan must never execute"
        fixture.plan_kind="normal";ready();count=len(fixture.goals)
        for extra in ({"joint_targets":{}},{"joint_targets":{"joint7":0.}},
                      {"joint_targets":{"joint1":99.}},{"joint_targets":{"joint1":.1},"positions":[0.]*6},
                      {"joint_targets":{"joint1":.1},"joint_name":"joint2","joint_position":.1},
                      {"joint_targets":{"joint1":.1},"motion_duration_s":0.},
                      {"joint_targets":{"joint1":.1},"motion_duration_s":121.}):
            rejected=request("position_move",command_id="invalid-timed",confirmation="ARMED",**extra)
            assert rejected.get("accepted") is False,rejected
        assert len(fixture.goals)==count
        # Cancel in planning: it must not leak a second ExecuteTrajectory goal.
        fixture.plan_delay=.8;ready();count=len(fixture.executions)
        request("position_move",command_id="cancel-plan",confirmation="ARMED",joint_targets={"joint2":-.12},motion_duration_s=5.)
        time.sleep(.2);request("position_cancel",command_id="cancel-plan")
        result,_=terminal("cancel-plan");assert result["motion_phase"]=="canceled",result
        assert len(fixture.executions)==count
        fixture.plan_delay=0.;fixture.slow_execution=True;ready()
        request("position_move",command_id="cancel-timed-execution",confirmation="ARMED",joint_targets={"joint2":-.12},motion_duration_s=5.)
        until=time.monotonic()+5
        while len(fixture.executions)==count and time.monotonic()<until:time.sleep(.05)
        assert len(fixture.executions)==count+1
        request("position_cancel",command_id="cancel-timed-execution")
        result,_=terminal("cancel-timed-execution");assert result["motion_phase"]=="canceled",result
        fixture.slow_execution=False;fixture.reject_execution=True;ready()
        request("position_move",command_id="reject-timed-execution",confirmation="ARMED",joint_targets={"joint2":-.12},motion_duration_s=5.)
        result,_=terminal("reject-timed-execution");assert result["motion_phase"]=="failed",result
        fixture.reject_execution=False;fixture.fail_execution=True;ready()
        request("position_move",command_id="fail-timed-execution",confirmation="ARMED",joint_targets={"joint2":-.12},motion_duration_s=5.)
        result,_=terminal("fail-timed-execution");assert result["motion_phase"]=="failed",result
        fixture.fail_execution=False;ready()
        fixture.plan_delay=.8;ready();count=len(fixture.executions)
        request("position_move",command_id="changed-plan-start",confirmation="ARMED",joint_targets={"joint2":-.12},motion_duration_s=5.)
        time.sleep(.2);fixture.q=[fixture.q[0]+.05]+fixture.q[1:]
        result,_=terminal("changed-plan-start");assert result["motion_phase"]=="failed" and "起点" in result["message"],result
        assert len(fixture.executions)==count
        fixture.plan_delay=.8;ready()
        request("position_move",command_id="disconnect-plan",confirmation="ARMED",joint_targets={"joint2":-.12},motion_duration_s=5.)
        other=connect();sock.close();sock=other;other=None
        until=time.monotonic()+5
        while time.monotonic()<until:
            status=request("position_motion_info")
            if not status["busy"]:break
            time.sleep(.1)
        assert not status["busy"] and len(fixture.executions)==count,status
        fixture.plan_delay=0.;fixture.slow_execution=True;ready()
        request("position_move",command_id="fault-timed-execution",confirmation="ARMED",joint_targets={"joint2":-.12},motion_duration_s=5.)
        until=time.monotonic()+5
        while len(fixture.executions)==count and time.monotonic()<until:time.sleep(.05)
        assert len(fixture.executions)==count+1
        fixture.fault=11
        result,_=terminal("fault-timed-execution");assert result["motion_phase"]=="canceled",result
        fixture.fault=0;fixture.slow_execution=False;ready()

        legacy_canceled=fixture.canceled
        # JTC desired is not a startup condition. MoveIt starts from measured joints.
        for label, offset, speed, omitted in (
                ("positive-reference-error", .0416, 0., False),
                ("negative-reference-error", -.032, 0., False),
                ("reference-moving", 0., .2, False),
                ("missing-reference", 0., 0., True),
                ("nonfinite-reference", float("nan"), float("nan"), False)):
            fixture.reference_offset=offset;fixture.reference_speed=speed;fixture.omit_reference=omitted
            time.sleep(.15);ready();before=list(fixture.q);count=len(fixture.goals)
            accepted=move(label)
            assert accepted.get("accepted") is not False,accepted
            result,_=terminal(label);assert result["motion_phase"]=="succeeded",result
            assert len(fixture.goals)==count+1
            assert fixture.starts[-1]==before,fixture.starts[-1]
        # The single-joint path uses the same readiness check and measured start.
        fixture.omit_reference=True;time.sleep(.15);ready();before=list(fixture.q)
        accepted=request("position_move",command_id="joint-without-reference",confirmation="ARMED",
                         joint_name="joint2",joint_position=-.15)
        assert accepted.get("accepted") is not False,accepted
        result,_=terminal("joint-without-reference");assert result["motion_phase"]=="succeeded",result
        assert fixture.starts[-1]==before
        fixture.reference_offset=0.;fixture.reference_speed=0.;fixture.omit_reference=False;ready()
        count=len(fixture.goals)
        m = request("position_move", command_id="unarmed", positions=[0.]*6); assert m["accepted"] is False and len(fixture.goals)==count
        m = request("position_move", command_id="bad", confirmation="ARMED", positions=[0.,5.,0.,0.,0.,0.]); assert m["accepted"] is False
        assert move("arrive")["op"] == "position_move_ack"
        result, phases = terminal("arrive"); assert result["motion_phase"] == "succeeded", result
        assert "verifying" in phases, phases
        ready(); count = len(fixture.goals); move("arrive"); time.sleep(.1); assert len(fixture.goals) == count
        assert request("position_move", command_id="home", label="HOME", confirmation="ARMED", home=True)["op"]=="position_move_ack"
        result,_=terminal("home");assert result["motion_phase"]=="succeeded",result
        assert fixture.goals[-1]==[0.,-.01,-.01,0.,0.,0.]
        ready(); before = list(fixture.q); count = len(fixture.goals)
        for extra in ({"joint_name":"bad", "joint_position":.1},
                      {"joint_name":"joint2"}, {"joint_position":.1},
                      {"joint_name":"joint2", "joint_position":99.},
                      {"joint_name":"joint2", "joint_position":.1, "positions":[0.]*6},
                      {"joint_name":"joint2", "joint_position":.1, "home":True}):
            rejected = request("position_move", command_id="invalid-joint", confirmation="ARMED", **extra)
            assert rejected["accepted"] is False, rejected
        assert len(fixture.goals) == count
        accepted = request("position_move", command_id="rotate-joint2", confirmation="ARMED",
                           joint_name="joint2", joint_position=-.15)
        assert accepted["op"] == "position_move_ack" and accepted.get("accepted") is not False, accepted
        result,_ = terminal("rotate-joint2"); assert result["motion_phase"] == "succeeded", result
        expected = list(before); expected[1] = -.15
        assert fixture.goals[-1] == expected, fixture.goals[-1]
        holds = fixture.path_constraints[-1]
        assert [c.joint_name for c in holds] == [j for j in NAMES if j != "joint2"]
        for constraint in holds:
            assert constraint.position == before[NAMES.index(constraint.joint_name)]
            assert constraint.tolerance_above == .001 and constraint.tolerance_below == .001
        ready()
        ready(); move("collision", .5); result,_ = terminal("collision"); assert result["motion_phase"] == "failed" and result["code"] == -12, result
        ready(); move("not-reached", .3); result,_=terminal("not-reached"); assert result["motion_phase"]=="failed",result
        assert "未到达" in result["message"],result
        ready(); move("cancel", .4); fixture.speed=.2; request("position_cancel", command_id="cancel");time.sleep(.5)
        assert request("position_motion_info")["busy"], "cancel ACK must not mean stopped"
        fixture.speed=0.;result,_=terminal("cancel"); assert result["motion_phase"] == "canceled",result
        ready(); move("fault", .4); fixture.fault=11; result,_=terminal("fault"); assert result["motion_phase"] == "canceled",result
        fixture.fault=0; ready()
        move("stale", .4); fixture.publish_feedback=False; time.sleep(1.5); fixture.publish_feedback=True
        result,_=terminal("stale"); assert result["motion_phase"] == "canceled",result
        ready(); move("disconnect", .4); other=connect()
        rejected = request("position_move", connection=other, command_id="other", confirmation="ARMED", positions=[0.,-.2,-.3,0.,0.,0.]); assert rejected["accepted"] is False,rejected
        sock.close(); sock=None; time.sleep(1.5); sock=other;other=None
        end=time.monotonic()+8
        while time.monotonic()<end:
            m=request("position_motion_info")
            if not m["busy"]:break
            time.sleep(.1)
        assert not m["busy"] and fixture.canceled-legacy_canceled>=4,m
        ready(); assert move("rejected", .6)["op"]=="position_move_ack"
        result,_=terminal("rejected");assert result["motion_phase"]=="failed",result
        ready();move("lease", .7);result,_=terminal("lease");assert result["motion_phase"]=="canceled" and "停稳" in result["message"],result
        count=len(fixture.goals)
        fixture.state_offset=.1;time.sleep(.2);assert move("mismatch")["accepted"] is False
        fixture.state_offset=0.;fixture.speed=.2;time.sleep(.2);assert move("moving")["accepted"] is False
        fixture.speed=0.;fixture.active=False;time.sleep(.7);assert move("inactive")["accepted"] is False
        fixture.active=True;ready()
        for label, positions in (("nonfinite-actual", [0., 0., float("nan"), 0., 0., 0.]),
                                 ("incomplete-actual", [0.]*5)):
            fixture.joint_positions=positions;time.sleep(.2)
            assert move(label)["accepted"] is False
        fixture.joint_positions=None
        fixture.velocity_claimed=False;time.sleep(.7)
        m=move("position-only");assert m["accepted"] is False and "velocity" in m["message"],m
        assert len(fixture.goals)==count,"invalid actual feedback or controller state must not send a MoveIt goal"
        fixture.velocity_claimed=True;ready()
        fixture.execution_server.destroy()
        until=time.monotonic()+5
        while time.monotonic()<until:
            info=request("position_motion_info")
            if info.get("motion_duration_message"):break
            time.sleep(.1)
        assert "execute_trajectory" in info.get("motion_duration_message",""),info
        assert info["available"],"legacy MoveGroup execution remains available without ExecuteTrajectory"
        rejected=request("position_move",command_id="no-execution-server",confirmation="ARMED",joint_targets={"joint1":.1},motion_duration_s=5.)
        assert rejected.get("accepted") is False and "execute_trajectory" in rejected["message"],rejected
        fixture.set_parameters([Parameter("robot_description_planning.joint_limits.joint1.has_acceleration_limits",value=False)])
        time.sleep(3.5);assert move("noaccel")["accepted"] is False
        print("PASS six-joint timed planning/execution, safe retiming and rejection, cancellation in both stages, disconnect/fault/start drift, measured starts independent of desired references, point/single-joint routing, live SRDF HOME, safety/limits, arrival, deduplication, collision/rejection, cancel, fault/stale/disconnect watchdog and cross-client exclusion; isolated domain",domain)
    finally:
        if sock:sock.close()
        if other:other.close()
        process.terminate();process.wait(timeout=10);log.close();executor.shutdown();fixture.destroy_node();rclpy.try_shutdown();thread.join(timeout=5)

if __name__ == "__main__": main()
