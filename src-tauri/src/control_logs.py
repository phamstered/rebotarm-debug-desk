"""Read only allowlisted Robot Console logs; invoked by the native SSH command."""
import json
import hashlib
import os
from pathlib import Path
import stat
import sys


def fingerprint(stream, size):
    stream.seek(max(0, size - 64))
    return hashlib.sha256(stream.read(min(size, 64))).hexdigest()


def capture_baseline(home=None):
    home = Path(home or Path.home())
    paths = [(home / '.cache/robot-console' / f'arm-{s}.log') for s in ('teleop', 'trajectory', 'realsense')]
    paths += list((home / '.ros/log').glob('ros2_control_node_*.log'))
    if len(paths) > 4096:
        raise ValueError('日志文件过多，请先归档')
    result = {}
    for path in paths:
        root = home / ('.ros/log' if path.name.startswith('ros2_control_node_') else '.cache/robot-console')
        if not path.resolve().is_relative_to(root.resolve()):
            raise ValueError('日志路径越过允许目录')
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        except FileNotFoundError:
            continue
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('日志不是普通文件')
            result[str(path)] = dict(device=info.st_dev, inode=info.st_ino, size=info.st_size,
                                     digest=fingerprint(stream, info.st_size))
    return result


def read_log(source, download=False, home=None, baseline=None):
    home = Path(home or Path.home())
    cache = home / '.cache/robot-console'
    if source in ('teleop', 'trajectory', 'vla', 'realsense'):
        root = cache
        path = cache / ('arm-' + ('trajectory' if source == 'vla' else source) + '.log')
    elif source == 'controller':
        root = home / '.ros/log'
        paths = [p for p in root.glob('ros2_control_node_*.log') if p.is_file()]
        path = max(paths, key=lambda p: p.stat().st_mtime_ns) if paths else root / 'ros2_control_node_*.log'
    else:
        raise ValueError('不支持的日志来源')
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError('日志路径越过允许目录')
    result = dict(source=source, path=str(path), exists=False, content='', truncated=False, sizeBytes=0, revision='')
    try:
        # O_NONBLOCK prevents a substituted FIFO from hanging the SSH reader.
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    except FileNotFoundError:
        return result
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('日志不是普通文件')
        cursor = (baseline or {}).get(str(path))
        offset = 0
        if (cursor and cursor['device'] == info.st_dev and cursor['inode'] == info.st_ino and
                info.st_size >= cursor['size'] and fingerprint(stream, cursor['size']) == cursor['digest']):
            offset = cursor['size']
        limit = 32 * 1024 * 1024 if download else 128 * 1024
        if download and info.st_size - offset > limit:
            raise ValueError('日志超过 32 MiB 下载上限，请在 Jetson 上归档后获取')
        start = max(offset, info.st_size - limit)
        stream.seek(start)
        data = stream.read(min(limit, info.st_size - start))
        if start > offset and b'\n' in data:
            data = data.split(b'\n', 1)[1]
        line_truncated = False
        if not download:
            lines = data.splitlines(keepends=True)
            line_truncated = len(lines) > 2000
            if line_truncated:
                data = b''.join(lines[-2000:])
        result.update(exists=True, content=data.decode('utf-8', errors='replace'), truncated=start > offset or line_truncated,
                      sizeBytes=info.st_size, revision=f'{info.st_dev}:{info.st_ino}:{info.st_size}:{info.st_mtime_ns}')
    return result


if __name__ == '__main__':
    result = capture_baseline() if sys.argv[1:3] == ['session', 'baseline'] else read_log(
        sys.argv[1], sys.argv[2] == 'download', baseline=json.loads(sys.argv[3]) if len(sys.argv) > 3 else None)
    print(json.dumps(result, ensure_ascii=True))
