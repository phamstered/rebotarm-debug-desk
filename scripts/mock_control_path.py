#!/usr/bin/env python3
"""One-shot isolated publisher/subscriber used to test Easy Debug command output."""

import json
import time

import rclpy
from microros_stm32h723_bridge.msg import HardwareStatus, JointCommand
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import JointState


class MockControlPath(Node):
    def __init__(self):
        super().__init__("easy_debug_mock_control_path")
        qos = QoSProfile(depth=10)
        qos.reliability = ReliabilityPolicy.BEST_EFFORT
        qos.durability = DurabilityPolicy.VOLATILE
        self.status_publisher = self.create_publisher(
            HardwareStatus, "/easy_debug/test_status", qos
        )
        self.joint_publisher = self.create_publisher(
            JointState, "/easy_debug/test_joint_states", qos
        )
        self.create_subscription(
            JointCommand, "/easy_debug/test_joint_commands", self.on_command, qos
        )
        self.received = False
        self.timer = self.create_timer(0.05, self.publish_feedback)

    def publish_feedback(self):
        stamp = self.get_clock().now().to_msg()
        status = HardwareStatus()
        status.header.stamp = stamp
        status.mode = HardwareStatus.MODE_DISABLE
        status.active_joint_mask = 1
        status.fault_code = 0
        self.status_publisher.publish(status)

        joint = JointState()
        joint.header.stamp = stamp
        joint.name = ["joint1"]
        joint.position = [0.0]
        joint.velocity = [0.0]
        joint.effort = [0.0]
        self.joint_publisher.publish(joint)

    def on_command(self, message):
        print(json.dumps({
            "sequence": message.sequence,
            "mode": message.mode,
            "position": [float(value) for value in message.position],
            "velocity": [float(value) for value in message.velocity],
            "kp": [float(value) for value in message.kp],
            "kd": [float(value) for value in message.kd],
            "effort": [float(value) for value in message.effort],
        }), flush=True)
        self.received = True


def main():
    rclpy.init()
    node = MockControlPath()
    deadline = time.monotonic() + 20.0
    while rclpy.ok() and not node.received and time.monotonic() < deadline:
        rclpy.spin_once(node, timeout_sec=0.1)
    node.destroy_node()
    rclpy.shutdown()
    raise SystemExit(0 if node.received else 2)


if __name__ == "__main__":
    main()
