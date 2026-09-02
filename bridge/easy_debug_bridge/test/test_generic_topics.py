#!/usr/bin/env python3
"""End-to-end validation for runtime ROS message introspection."""

import base64
import hashlib
import json
import os
import socket
import struct
import subprocess


HOST = os.environ.get("ROBOT_CONSOLE_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("ROBOT_CONSOLE_BRIDGE_PORT", "18768"))


def websocket_connect():
    sock = socket.create_connection((HOST, PORT), timeout=10)
    key = base64.b64encode(os.urandom(16)).decode()
    request = (
        "GET / HTTP/1.1\r\n"
        f"Host: {HOST}:{PORT}\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    )
    sock.sendall(request.encode())
    response = b""
    while b"\r\n\r\n" not in response:
        response += sock.recv(4096)
    expected = base64.b64encode(
        hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
    ).decode()
    assert b"101 Switching Protocols" in response and expected.encode() in response
    return sock


def send_json(sock, payload):
    data = json.dumps(payload, separators=(",", ":")).encode()
    mask = os.urandom(4)
    length = len(data)
    if length < 126:
        header = bytes((0x81, 0x80 | length))
    elif length < 65536:
        header = bytes((0x81, 0xFE)) + struct.pack("!H", length)
    else:
        header = bytes((0x81, 0xFF)) + struct.pack("!Q", length)
    sock.sendall(header + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(data)))


def receive_json(sock):
    first, second = sock.recv(2)
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", sock.recv(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", sock.recv(8))[0]
    data = b""
    while len(data) < length:
        data += sock.recv(length - len(data))
    assert first & 0x0F == 1
    return json.loads(data)


def wait_for(sock, predicate):
    for _ in range(20):
        message = receive_json(sock)
        if predicate(message):
            return message
    raise AssertionError("没有收到匹配的 Bridge 消息")


def validate_topic(sock, index, topic, message_type, yaml, check):
    request_id = f"generic-{index}"
    send_json(sock, {
        "op": "subscribe", "request_id": request_id,
        "topic": topic, "type": message_type,
    })
    response = wait_for(sock, lambda item: item.get("request_id") == request_id)
    assert response["op"] == "subscribed", response
    subprocess.run(
        ["ros2", "topic", "pub", "--once", topic, message_type, yaml],
        check=True, timeout=20,
    )
    message = wait_for(
        sock, lambda item: item.get("op") == "topic_message" and item.get("topic") == topic,
    )
    assert "_decode_error" not in message["data"], message
    check(message["data"])


def main():
    sock = websocket_connect()
    sock.settimeout(10)
    validate_topic(
        sock, 1, "/robot_console_test/pose", "geometry_msgs/msg/PoseStamped",
        "{header: {frame_id: map}, pose: {position: {x: 1.25, y: -2.5, z: 0.5}, "
        "orientation: {x: 0.0, y: 0.0, z: 0.0, w: 1.0}}}",
        lambda data: (
            data["header"]["frame_id"] == "map"
            and data["pose"]["position"]["x"] == 1.25
            and data["pose"]["orientation"]["w"] == 1.0
        ) or (_ for _ in ()).throw(AssertionError(data)),
    )
    validate_topic(
        sock, 2, "/robot_console_test/diagnostics", "diagnostic_msgs/msg/DiagnosticArray",
        "{header: {frame_id: base}, status: [{level: 1, name: motor, message: warm, "
        "hardware_id: stm32, values: [{key: temp, value: '72.5'}]}]}",
        lambda data: (
            data["status"][0]["name"] == "motor"
            and data["status"][0]["values"] == [{"key": "temp", "value": "72.5"}]
        ) or (_ for _ in ()).throw(AssertionError(data)),
    )
    validate_topic(
        sock, 3, "/robot_console_test/image", "sensor_msgs/msg/Image",
        "{height: 1, width: 3, encoding: mono8, is_bigendian: 0, step: 3, data: [1, 128, 255]}",
        lambda data: (
            data["height"] == 1 and data["width"] == 3
            and data["encoding"] == "mono8" and data["data"] == [1, 128, 255]
        ) or (_ for _ in ()).throw(AssertionError(data)),
    )
    validate_topic(
        sock, 4, "/robot_console_test/int64", "std_msgs/msg/Int64",
        "{data: 9223372036854775807}",
        lambda data: data["data"] == "9223372036854775807"
        or (_ for _ in ()).throw(AssertionError(data)),
    )
    sock.close()
    print("generic topic introspection validation passed")


if __name__ == "__main__":
    main()
