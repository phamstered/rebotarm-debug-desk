"""Bounded read-only RGB/CameraInfo/TF capture. No controller/action publishers."""
import base64
import json
import math
import sys
import time
import struct
import zlib
from collections import deque


def validate_config(config):
    for name in ('image_topic', 'camera_info_topic', 'joint_topic', 'base_frame', 'eef_frame', 'sensor_frame', 'camera_body_frame'):
        value = config.get(name, '')
        if not isinstance(value, str) or not value or len(value) > 200 or any(c not in '/_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' for c in value):
            raise ValueError('Invalid topic/frame: ' + name)
    if config['base_frame'] == config['eef_frame']:
        raise ValueError('Base and end-effector must be different frames')
    if config['mode'] not in ('capture', 'preview', 'frames'):
        raise ValueError('Invalid capture mode')


def stamp_ns(stamp):
    return stamp.sec * 1000000000 + stamp.nanosec


def transform_matrix(transform):
    t, q = transform.translation, transform.rotation
    values = [t.x, t.y, t.z, q.x, q.y, q.z, q.w]
    if not all(math.isfinite(x) for x in values):
        raise ValueError('Non-finite TF')
    norm = sum(x*x for x in values[3:]) ** 0.5
    if abs(norm-1) > 0.01:
        raise ValueError('Invalid TF quaternion')
    x, y, z, w = (v / norm for v in values[3:])
    return [1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w), t.x,
            2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w), t.y,
            2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y), t.z,
            0, 0, 0, 1]


def stable_feedback(history, image_ns, now_ns):
    """Six measured arm joints, >=300 ms stopped, recent data around image time."""
    needed = ['joint' + str(i) for i in range(1, 7)]
    rows = [row for row in history if image_ns-400_000_000 <= row['stamp_ns'] <= image_ns+100_000_000]
    if len(rows) < 3 or rows[-1]['stamp_ns']-rows[0]['stamp_ns'] < 300_000_000:
        return None
    if any(not 0 < b['stamp_ns']-a['stamp_ns'] <= 100_000_000 for a, b in zip(rows, rows[1:])):
        return None
    if not -50_000_000 <= now_ns-rows[-1]['stamp_ns'] <= 500_000_000:
        return None
    for row in rows:
        if set(needed)-set(row['names']) or len(row['names']) != len(set(row['names'])):
            return None
        if len(row['positions']) != len(row['names']) or len(row['velocities']) != len(row['names']):
            return None
        indices = [row['names'].index(name) for name in needed]
        if any(not math.isfinite(row['positions'][i]) or not math.isfinite(row['velocities'][i]) or abs(row['velocities'][i]) > .02 for i in indices):
            return None
    for name in needed:
        positions = [row['positions'][row['names'].index(name)] for row in rows]
        if max(positions)-min(positions) > .002:
            return None
    nearest = min(rows, key=lambda row: abs(row['stamp_ns']-image_ns))
    return nearest if abs(nearest['stamp_ns']-image_ns) <= 100_000_000 else None


def encode_image(image):
    """Encode ROS RGB using the standard library; no Jetson OpenCV/NumPy ABI."""
    channels = {'rgb8': 3, 'bgr8': 3, 'rgba8': 4, 'bgra8': 4, 'mono8': 1}.get(image.encoding)
    if channels is None or not 0 < image.width <= 4096 or not 0 < image.height <= 4096:
        raise ValueError('Unsupported RGB encoding/dimensions')
    if image.step < image.width*channels or len(image.data) != image.step*image.height or len(image.data) > 64*1024*1024:
        raise ValueError('Malformed RGB buffer')
    raw = bytes(image.data)
    scan = bytearray()
    for y in range(image.height):
        row = raw[y*image.step:y*image.step+image.width*channels]
        if image.encoding in ('bgr8', 'bgra8'):
            rgb = bytearray(row)
            rgb[0::channels], rgb[2::channels] = row[2::channels], row[0::channels]
            row = rgb
        scan.append(0)
        scan.extend(row)
    def chunk(kind, data):
        return struct.pack('>I', len(data))+kind+data+struct.pack('>I', zlib.crc32(kind+data) & 0xffffffff)
    header = struct.pack('>IIBBBBB', image.width, image.height, 8, {1: 0, 3: 2, 4: 6}[channels], 0, 0, 0)
    encoded = b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR', header)+chunk(b'IDAT', zlib.compress(scan, 1))+chunk(b'IEND', b'')
    if len(encoded) > 16*1024*1024:
        raise ValueError('Encoded image exceeds 16 MiB')
    return encoded


def capture(config):
    validate_config(config)
    import rclpy
    from rclpy.node import Node
    from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
    from rclpy.time import Time
    from rclpy.duration import Duration
    from sensor_msgs.msg import Image, CameraInfo, JointState
    from tf2_ros import Buffer, TransformListener
    rclpy.init(args=[])
    node = Node('debug_desk_handeye_capture')
    qos = QoSProfile(depth=5, reliability=ReliabilityPolicy.BEST_EFFORT, durability=DurabilityPolicy.VOLATILE)
    state = {'image': None, 'info': None}
    history = deque(maxlen=300)
    tf = Buffer(cache_time=Duration(seconds=10), node=node)
    listener = TransformListener(tf, node)
    def joint(msg):
        stamp = stamp_ns(msg.header.stamp)
        if history and stamp <= history[-1]['stamp_ns']:
            history.clear()
        history.append({'stamp_ns': stamp, 'names': list(msg.name), 'positions': list(msg.position), 'velocities': list(msg.velocity)})
    subscriptions = [node.create_subscription(Image, config['image_topic'], lambda m: state.update(image=m), qos),
                     node.create_subscription(CameraInfo, config['camera_info_topic'], lambda m: state.update(info=m), qos),
                     node.create_subscription(JointState, config['joint_topic'], joint, qos)]
    deadline = time.monotonic()+8
    reason = 'Waiting for RGB and CameraInfo'
    try:
        while time.monotonic() < deadline:
            rclpy.spin_once(node, timeout_sec=.02)
            if config['mode'] == 'frames':
                if deadline-time.monotonic() < 6:
                    import yaml
                    frames = yaml.safe_load(tf.all_frames_as_yaml()) or {}
                    names = set(frames)
                    names.update(v['parent'] for v in frames.values() if isinstance(v, dict) and v.get('parent'))
                    return {'frames': sorted(names)}
                continue
            image, info = state['image'], state['info']
            if image is None or info is None:
                continue
            stamp = stamp_ns(image.header.stamp)
            now = node.get_clock().now().nanoseconds
            if not -50_000_000 <= now-stamp <= 500_000_000:
                reason = 'RGB timestamp is stale or ahead of ROS time'; continue
            if image.header.frame_id != config['sensor_frame'] or info.header.frame_id != image.header.frame_id:
                reason = 'Image / CameraInfo optical frame does not match selected Sensor frame'; continue
            if (info.width, info.height) != (image.width, image.height) or abs(stamp_ns(info.header.stamp)-stamp) > 500_000_000:
                reason = 'CameraInfo dimensions or timestamp do not match RGB'; continue
            if info.k[0] <= 0 or info.k[4] <= 0 or not all(math.isfinite(v) for v in list(info.k)+list(info.d)):
                raise ValueError('Invalid CameraInfo intrinsics')
            measured = None; robot = None; body = None
            if config['mode'] == 'capture':
                measured = stable_feedback(history, stamp, now)
                if measured is None:
                    reason = 'Arm must remain stopped for 300 ms with fresh complete measured joint feedback'; continue
                try:
                    requested = Time.from_msg(image.header.stamp)
                    robot = transform_matrix(tf.lookup_transform(config['base_frame'], config['eef_frame'], requested).transform)
                    body = transform_matrix(tf.lookup_transform(config['camera_body_frame'], config['sensor_frame'], requested).transform)
                except Exception as ex:
                    reason = 'Acquisition-time TF unavailable: ' + str(ex); continue
            encoded = encode_image(image)
            return {'image_png': base64.b64encode(encoded).decode('ascii'), 'stamp_ns': str(stamp),
                    'width': image.width, 'height': image.height, 'k': list(info.k), 'd': list(info.d),
                    'distortion_model': info.distortion_model, 'sensor_frame': image.header.frame_id,
                    'robot': robot, 'body_to_sensor': body, 'joints': measured,
                    'frame_age_ms': (now-stamp)/1e6, 'capture_config': config}
        raise RuntimeError(reason)
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'result': capture(json.loads(sys.argv[1]))}, allow_nan=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        sys.exit(1)
