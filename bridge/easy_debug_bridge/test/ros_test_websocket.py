"""Standard-library text client for isolated ROS integration tests."""
import base64
import json
import os
import socket
import struct
import uuid


class WebSocket:
    """Small RFC6455 text client, using stdlib only for isolated ROS tests."""
    def __init__(self, port):
        self.events = {}
        self.command_id = None
        self.socket = socket.create_connection(('127.0.0.1', port), timeout=3)
        key = base64.b64encode(os.urandom(16)).decode()
        self.socket.sendall(('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n'
                            'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n'
                            'Sec-WebSocket-Key: %s\r\n\r\n' % key).encode())
        response = b''
        while not response.endswith(b'\r\n\r\n'):
            chunk = self.socket.recv(1)
            if not chunk:
                self.socket.close()
                raise RuntimeError('WebSocket closed during handshake')
            response += chunk
        assert b'101 Switching Protocols' in response, response

    def read(self, count):
        value = b''
        while len(value) < count:
            chunk = self.socket.recv(count - len(value))
            if not chunk:
                raise RuntimeError('WebSocket closed')
            value += chunk
        return value

    def receive(self):
        # Beast fragments larger motion-log replies across continuation frames.
        payload = b''
        while True:
            first, second = self.read(2)
            length = second & 127
            if length == 126:
                length = struct.unpack('!H', self.read(2))[0]
            elif length == 127:
                length = struct.unpack('!Q', self.read(8))[0]
            assert not second & 128, 'Server frames must not be masked'
            assert first & 15 in (0, 1), first
            payload += self.read(length)
            if first & 128:
                break
        message = json.loads(payload)
        if message.get('op') == 'position_motion':
            self.events[message['command_id']] = message
        return message

    def request(self, op, **fields):
        request_id = str(uuid.uuid4())
        if op == 'position_move':
            self.command_id = fields['command_id']
        data = json.dumps(dict(op=op, request_id=request_id, **fields)).encode()
        mask = os.urandom(4)
        header = bytes([129, 128 | len(data)]) if len(data) < 126 else bytes([129, 254]) + struct.pack('!H', len(data))
        self.socket.sendall(header + mask + bytes(x ^ mask[i % 4] for i, x in enumerate(data)))
        while True:
            reply = self.receive()
            # Hello is the legacy handshake response and has no request_id.
            if reply.get('request_id') == request_id or (op == 'hello' and reply.get('op') == 'hello'):
                return reply
