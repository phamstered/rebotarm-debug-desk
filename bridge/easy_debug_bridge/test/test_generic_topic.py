#!/usr/bin/env python3
"""Run against an isolated, running Bridge with ROS 2 control_msgs installed."""

import time

import rclpy
from control_msgs.msg import JointTrajectoryControllerState
from test_image_topic import receive_message, send_json, websocket_connect


def response(sock, request_id):
    while True:
        message = receive_message(sock)
        if message.get("request_id") == request_id:
            return message


def main():
    rclpy.init()
    node = rclpy.create_node("robot_console_generic_topic_test")
    topic = "/robot_console_test/controller_state"
    publisher = node.create_publisher(JointTrajectoryControllerState, topic, 10)
    sock = websocket_connect()
    sock.settimeout(2)
    try:
        for attempt in range(100):
            send_json(sock, {"op": "topics", "request_id": f"topics-{attempt}"})
            discovered = response(sock, f"topics-{attempt}")
            if any(item["name"] == topic for item in discovered["topics"]):
                break
            time.sleep(0.1)
        else:
            raise AssertionError("Bridge did not discover the test publisher")

        for attempt in range(100):
            request_id = f"topic-info-{attempt}"
            send_json(sock, {"op": "topic_info", "request_id": request_id, "topic": topic})
            topic_info = response(sock, request_id)["topic_info"]
            if any(endpoint["node_name"] == node.get_name() for endpoint in topic_info["publishers"]):
                break
            time.sleep(0.1)
        else:
            raise AssertionError("Bridge did not discover the test publisher endpoint")
        assert topic_info["name"] == topic
        assert topic_info["types"] == ["control_msgs/msg/JointTrajectoryControllerState"]
        assert any(endpoint["node_name"] == node.get_name() and endpoint["endpoint_type"] == "PUBLISHER" and endpoint["qos"]["reliability"] == "RELIABLE" and endpoint["gid"] for endpoint in topic_info["publishers"])

        send_json(sock, {"op": "node_info", "request_id": "node-info", "node": "/" + node.get_name()})
        node_info = response(sock, "node-info")["node_info"]
        assert any(entry["name"] == topic for entry in node_info["publishers"])

        send_json(sock, {"op": "topic_info", "request_id": "bad-topic-info", "topic": "/bad//topic"})
        assert response(sock, "bad-topic-info")["op"] == "error"

        send_json(sock, {
            "op": "subscribe", "request_id": "wrong-type", "topic": topic,
            "type": "std_msgs/msg/String",
        })
        assert response(sock, "wrong-type")["op"] == "error"

        send_json(sock, {
            "op": "subscribe", "request_id": "missing-type",
            "topic": "/robot_console_test/missing_type", "type": "missing_msgs/msg/Nope",
        })
        assert response(sock, "missing-type")["op"] == "error"

        send_json(sock, {
            "op": "subscribe", "request_id": "controller-state", "topic": topic,
            "type": "control_msgs/msg/JointTrajectoryControllerState",
        })
        assert response(sock, "controller-state")["op"] == "subscribed"

        sample = JointTrajectoryControllerState()
        sample.joint_names = ["joint1"]
        sample.actual.positions = [0.25]
        sample.actual.time_from_start.sec = 2
        for _ in range(20):
            publisher.publish(sample)
            try:
                received = receive_message(sock)
            except TimeoutError:
                continue
            if received.get("topic") != topic:
                continue
            data = received["data"]
            assert data["joint_names"] == ["joint1"]
            assert data["actual"]["positions"] == [0.25]
            assert data["actual"]["time_from_start"]["sec"] == 2
            print("generic controller state topic validation passed")
            break
        else:
            raise AssertionError("No decoded controller state message received")
    finally:
        sock.close()
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
