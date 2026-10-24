#!/usr/bin/env python3
"""Isolated ROS integration: image interests and binary/legacy URDF resources.

ROS_DOMAIN_ID must be nonzero. ROBOT_CONSOLE_TEST_WORKSPACE must name an
isolated *_test workspace containing the running Bridge, never production.
"""
import base64
import json
import os
from pathlib import Path
import socket
import struct
import tempfile
import time

import rclpy
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Image
from ament_index_python.packages import get_package_share_directory
from test_image_topic import websocket_connect, send_json, receive_frame


def receive(sock):
    finished, opcode, data = receive_frame(sock)
    chunks = [data]
    while not finished:
        finished, continuation, chunk = receive_frame(sock)
        assert continuation == 0
        chunks.append(chunk)
    data = b"".join(chunks)
    if opcode == 1:
        return json.loads(data)
    assert opcode == 2 and data[:4] in (b"RCI1", b"RCR1")
    offset = 8 + struct.unpack("!I", data[4:8])[0]
    result = json.loads(data[8:offset])
    result["raw"] = data[offset:]
    if data[:4] == b"RCR1":
        assert result["data_length"] == len(result["raw"])
    return result


def request(sock, payload):
    request.counter += 1
    rid = str(request.counter)
    send_json(sock, {**payload, "request_id": rid})
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = receive(sock)
        if response.get("request_id") == rid:
            return response
    raise AssertionError("request timed out")
request.counter = 0


def expect_image(sock, topic, publish):
    publish()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        response = receive(sock)
        if response.get("topic") == topic and response.get("op") == "topic_message":
            assert response["raw"] == bytes([1, 128, 255])
            return
    raise AssertionError("missing image")


def no_image(sock, topic):
    sock.settimeout(.35)
    try:
        while True:
            response = receive(sock)
            assert response.get("op") != "topic_message" or response.get("topic") != topic, "image leaked to uninterested client"
    except socket.timeout:
        pass
    finally:
        sock.settimeout(10)


def main():
    assert int(os.environ.get("ROS_DOMAIN_ID", "0")) != 0, "use an isolated ROS domain"
    workspace = Path(os.environ["ROBOT_CONSOLE_TEST_WORKSPACE"]).resolve()
    assert workspace.name.endswith("_test"), "isolated workspace required"
    share = Path(get_package_share_directory("easy_debug_bridge")).resolve()
    assert share.is_relative_to(workspace / "install"), "refusing to write fixtures into a production package"
    rclpy.init()
    node = rclpy.create_node("robot_console_viewer_transport_test")
    topic = "/robot_console_test/viewer_image"
    publisher = node.create_publisher(Image, topic, qos_profile_sensor_data)
    image = Image(height=1, width=3, encoding="mono8", step=3, data=[1, 128, 255])
    a, b, c = websocket_connect(), websocket_connect(), websocket_connect()
    try:
        for client in (a, b):
            assert request(client, {"op": "subscribe", "topic": topic, "type": "sensor_msgs/msg/Image"})["op"] == "subscribed"
        deadline = time.monotonic() + 5
        while publisher.get_subscription_count() != 1 and time.monotonic() < deadline:
            time.sleep(.05)
        assert publisher.get_subscription_count() == 1
        time.sleep(.4)
        expect_image(a, topic, lambda: publisher.publish(image))
        expect_image(b, topic, lambda: publisher.publish(image))
        assert request(c, {"op": "topics"})["op"] == "topics"
        no_image(c, topic)
        assert request(a, {"op": "unsubscribe", "topic": topic})["op"] == "unsubscribed"
        expect_image(b, topic, lambda: publisher.publish(image))
        no_image(a, topic)
        b.shutdown(socket.SHUT_RDWR)
        b.close()
        deadline = time.monotonic() + 5
        while publisher.get_subscription_count() and time.monotonic() < deadline:
            time.sleep(.05)
        assert publisher.get_subscription_count() == 0, "last client did not release ROS image subscription"
        assert request(a, {"op": "subscribe", "topic": topic, "type": "sensor_msgs/msg/Image"})["op"] == "subscribed"
        time.sleep(.3)
        expect_image(a, topic, lambda: publisher.publish(image))
        assert request(a, {"op": "unsubscribe", "topic": topic})["op"] == "unsubscribed"
        assert request(a, {"op": "subscribe", "topic": "/robot_console_test/text", "type": "std_msgs/msg/String"})["op"] == "subscribed"
        assert request(a, {"op": "unsubscribe", "topic": "/robot_console_test/text"})["op"] == "error"
        with tempfile.TemporaryDirectory(prefix="viewer-transport-", dir=share) as directory:
            fixtures = Path(directory)
            raw = bytes(range(256)) * 512
            (fixtures / "mesh.stl").write_bytes(raw)
            (fixtures / "empty.stl").write_bytes(b"")
            with (fixtures / "large.stl").open("wb") as handle:
                handle.truncate(64 * 1024 * 1024 + 1)
            prefix = f"package://easy_debug_bridge/{fixtures.name}/"
            for filename, expected in (("mesh.stl", raw), ("empty.stl", b"")):
                uri = prefix + filename
                binary = request(c, {"op": "resource", "uri": uri, "encoding": "binary"})
                legacy = request(c, {"op": "resource", "uri": uri})
                assert binary["op"] == legacy["op"] == "resource"
                assert binary["uri"] == uri and binary["raw"] == base64.b64decode(legacy["base64"]) == expected
            for uri, encoding in ((prefix + "large.stl", "binary"), (prefix + "mesh.stl", "gzip"),
                                  ("package://easy_debug_bridge/../package.xml", "binary"),
                                  ("package://easy_debug_bridge//etc/passwd", "binary"),
                                  (prefix + "missing.stl", "binary")):
                assert request(c, {"op": "resource", "uri": uri, "encoding": encoding})["op"] == "error"
        # Existing ROS symlink-install resources must still work after lexical checks.
        resource = request(c, {"op": "resource", "uri": "package://rebotarm_gazebo/meshes/base_link.STL", "encoding": "binary"})
        assert resource["op"] == "resource" and len(resource["raw"]) > 84
        print("PASS image interest isolation, unsubscribe ACK ordering, disconnect cleanup, resubscribe, binary/legacy equivalence, empty/large/missing/encoding/traversal boundaries, symlink-install mesh")
    finally:
        for client in (a, b, c):
            client.close()
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
