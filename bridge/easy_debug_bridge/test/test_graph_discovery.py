#!/usr/bin/env python3
"""Read-only Graph integration with synthetic nodes in a non-production domain."""
import os
import time

import rclpy
from std_msgs.msg import String
from test_image_topic import websocket_connect, send_json, receive_message


def main():
    assert int(os.environ.get('ROS_DOMAIN_ID', '0')) != 0, 'isolated ROS domain required'
    rclpy.init()
    nodes = [rclpy.create_node(name, namespace=namespace) for name, namespace in (
        ('stm32h723_motor_bridge', '/'), ('camera_bridge', '/camera'),
        ('robo_driver_node', '/leader'), ('arm_teleop_controller', '/'))]
    publishers = [node.create_publisher(String, f'/robot_console_test/graph_{i}', 10) for i, node in enumerate(nodes)]
    sock = websocket_connect()
    sequence = 0

    def request(op, **fields):
        nonlocal sequence
        sequence += 1
        rid = str(sequence)
        send_json(sock, dict(op=op, request_id=rid, **fields))
        while True:
            result = receive_message(sock)
            if result.get('request_id') == rid:
                assert result['op'] != 'error', result
                return result

    try:
        expected = {node.get_fully_qualified_name() for node in nodes}
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            graph = request('graph')
            names = {node['label'] for node in graph['nodes'] if node['kind'] == 'node'}
            if expected <= names:
                break
            time.sleep(.1)
        assert expected <= names, (expected, names)
        for i, node in enumerate(nodes):
            assert dict(source='node:' + node.get_fully_qualified_name(), target=f'topic:/robot_console_test/graph_{i}', relation='publish') in graph['edges']
            details = request('node_info', node=node.get_fully_qualified_name())['node_info']
            assert any(topic['name'] == f'/robot_console_test/graph_{i}' for topic in details['publishers'])
        removed = nodes.pop()
        departed = removed.get_fully_qualified_name()
        removed.destroy_node()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            graph = request('graph')
            if all(node['label'] != departed for node in graph['nodes']):
                break
            time.sleep(.1)
        assert all(node['label'] != departed for node in graph['nodes'])
        print('PASS graph discovers synthetic STM32/camera/leader/controller nodes, preserves namespaces and publisher edges, serves node details and removes departed nodes')
    finally:
        sock.close()
        for node in nodes:
            node.destroy_node()
        rclpy.try_shutdown()


if __name__ == '__main__':
    main()
