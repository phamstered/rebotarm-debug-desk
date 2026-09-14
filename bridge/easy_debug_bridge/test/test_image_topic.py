#!/usr/bin/env python3
"""End-to-end validation for binary sensor_msgs/Image transport."""

import base64
import hashlib
import json
import os
import socket
import struct
import subprocess


HOST = os.environ.get("ROBOT_CONSOLE_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("ROBOT_CONSOLE_BRIDGE_PORT", "18768"))


def receive_exact(sock, length):
    data = b""
    while len(data) < length:
        chunk = sock.recv(length - len(data))
        if not chunk:
            raise ConnectionError("WebSocket closed while receiving data")
        data += chunk
    return data


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


def receive_frame(sock):
    first, second = receive_exact(sock, 2)
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", receive_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", receive_exact(sock, 8))[0]
    payload = receive_exact(sock, length)
    return bool(first & 0x80), first & 0x0F, payload


def receive_message(sock):
    finished, opcode, data = receive_frame(sock)
    while not finished:
        finished, continuation_opcode, chunk = receive_frame(sock)
        assert continuation_opcode == 0
        data += chunk
    if opcode == 1:
        return json.loads(data)
    assert opcode == 2 and data[:4] == b"RCI1" and len(data) >= 8
    metadata_length = struct.unpack("!I", data[4:8])[0]
    payload_offset = 8 + metadata_length
    message = json.loads(data[8:payload_offset])
    message["data"]["data_bytes"] = data[payload_offset:]
    return message


def main():
    sock = websocket_connect()
    topic = "/robot_console_test/image"
    send_json(sock, {
        "op": "subscribe", "request_id": "image-test",
        "topic": topic, "type": "sensor_msgs/msg/Image",
    })
    subprocess.run([
        "ros2", "topic", "pub", "--once", topic, "sensor_msgs/msg/Image",
        "{height: 1, width: 3, encoding: mono8, is_bigendian: 0, step: 3, data: [1, 128, 255]}",
    ], check=True, timeout=15)
    for _ in range(20):
        message = receive_message(sock)
        if message.get("op") == "topic_message" and message.get("topic") == topic:
            data = message["data"]
            assert data["height"] == 1 and data["width"] == 3
            assert data["encoding"] == "mono8" and data["data_length"] == 3
            assert data["data_bytes"] == bytes([1, 128, 255])
            print("binary image topic validation passed")
            sock.close()
            return
    raise AssertionError("没有收到 Image Topic 数据")


if __name__ == "__main__":
    main()
