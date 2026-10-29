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
from moveit_msgs.action import MoveGroup
from sensor_msgs.msg import JointState
from test_image_topic import websocket_connect, send_json, receive_message

NAMES = [f"joint{i}" for i in range(1, 7)]

class Fixture(rclpy.node.Node):
    def __init__(self):
        super().__init__("move_group")
        self.group = ReentrantCallbackGroup()
        self.q = [0., -.2, -.3, 0., 0., 0.]
        self.active = True; self.fault = 0; self.publish_feedback = True; self.speed = 0.; self.state_offset = 0.
        self.goals = []; self.canceled = 0
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
        self.create_timer(.03, self.publish, callback_group=self.group)
    def controllers(self, request, response):
        c = ControllerState(); c.name = "arm_trajectory_controller"; c.type = "joint_trajectory_controller/JointTrajectoryController"
        c.state = "active" if self.active else "inactive"; response.controller = [c]; return response
    def publish(self):
        if not self.publish_feedback: return
        q = list(self.q)
        j = JointState(); j.header.stamp = self.get_clock().now().to_msg(); j.name = NAMES; j.position = q; j.velocity = [self.speed]*6; j.effort = [0.]*6; self.pub_joint.publish(j)
        s = JointTrajectoryControllerState(); s.joint_names = NAMES; s.actual.positions = [q[0]+self.state_offset]+q[1:]; s.actual.velocities = [0.]*6; self.pub_state.publish(s)
        h = HardwareStatus(); h.mode = HardwareStatus.MODE_TRACK; h.fault_code = self.fault; h.active_joint_mask = 0x3f; self.pub_hw.publish(h)
    def execute(self, handle):
        goal = handle.request
        assert goal.request.group_name == "arm" and goal.request.pipeline_id == "ompl"
        assert not goal.planning_options.plan_only and not goal.planning_options.replan
        assert goal.request.max_velocity_scaling_factor <= .2
        assert goal.request.start_state.joint_state.name == NAMES
        constraints = goal.request.goal_constraints[0].joint_constraints
        assert [c.joint_name for c in constraints] == NAMES
        target = [c.position for c in constraints]; self.goals.append(target)
        fb = MoveGroup.Feedback(); fb.state = "PLANNING"; handle.publish_feedback(fb)
        result = MoveGroup.Result()
        if abs(target[0]-.5)<1e-6:
            result.error_code.val = -12; handle.abort(); return result
        fb.state = "MONITOR"; handle.publish_feedback(fb)
        for _ in range(200 if abs(target[0]-.7)<1e-6 else 50 if abs(target[0]-.4)<1e-6 else 8):
            if handle.is_cancel_requested:
                self.canceled += 1; result.error_code.val = -7; handle.canceled(); return result
            time.sleep(.05)
        if abs(target[0]-.3)>1e-6:self.q = target
        result.error_code.val = 1; handle.succeed(); return result

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
        assert info["home_positions"] == [0.,-.01,-.01,0.,0.,0.], info
        m = request("position_move", command_id="unarmed", positions=[0.]*6); assert m["accepted"] is False and not fixture.goals
        m = request("position_move", command_id="bad", confirmation="ARMED", positions=[0.,5.,0.,0.,0.,0.]); assert m["accepted"] is False
        assert move("arrive")["op"] == "position_move_ack"
        result, phases = terminal("arrive"); assert result["motion_phase"] == "succeeded", result
        assert "verifying" in phases, phases
        count = len(fixture.goals); move("arrive"); time.sleep(.1); assert len(fixture.goals) == count
        assert request("position_move", command_id="home", label="HOME", confirmation="ARMED", home=True)["op"]=="position_move_ack"
        result,_=terminal("home");assert result["motion_phase"]=="succeeded",result
        assert fixture.goals[-1]==[0.,-.01,-.01,0.,0.,0.]
        move("collision", .5); result,_ = terminal("collision"); assert result["motion_phase"] == "failed" and result["code"] == -12, result
        move("not-reached", .3); result,_=terminal("not-reached"); assert result["motion_phase"]=="failed",result
        assert "未到达" in result["message"],result
        move("cancel", .4); fixture.speed=.2; request("position_cancel", command_id="cancel");time.sleep(.5)
        assert request("position_motion_info")["busy"], "cancel ACK must not mean stopped"
        fixture.speed=0.;result,_=terminal("cancel"); assert result["motion_phase"] == "canceled",result
        move("fault", .4); fixture.fault=11; result,_=terminal("fault"); assert result["motion_phase"] == "canceled",result
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
        assert not m["busy"] and fixture.canceled>=4,m
        assert move("rejected", .6)["op"]=="position_move_ack"
        result,_=terminal("rejected");assert result["motion_phase"]=="failed",result
        ready();move("lease", .7);result,_=terminal("lease");assert result["motion_phase"]=="canceled" and "停稳" in result["message"],result
        fixture.state_offset=.1;time.sleep(.2);assert move("mismatch")["accepted"] is False
        fixture.state_offset=0.;fixture.speed=.2;time.sleep(.2);assert move("moving")["accepted"] is False
        fixture.speed=0.;fixture.active=False;time.sleep(.7);assert move("inactive")["accepted"] is False
        fixture.active=True;ready()
        fixture.set_parameters([Parameter("robot_description_planning.joint_limits.joint1.has_acceleration_limits",value=False)])
        time.sleep(3.5);assert move("noaccel")["accepted"] is False
        print("PASS MoveIt routing, live SRDF HOME, safety/limits, arrival, deduplication, collision/rejection, cancel, fault/stale/disconnect watchdog and cross-client exclusion; isolated domain",domain)
    finally:
        if sock:sock.close()
        if other:other.close()
        process.terminate();process.wait(timeout=10);log.close();executor.shutdown();fixture.destroy_node();rclpy.try_shutdown();thread.join(timeout=5)

if __name__ == "__main__": main()
