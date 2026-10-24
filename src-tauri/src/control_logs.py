"""Read only allowlisted Robot Console logs; invoked by the native SSH command."""
import json
import os
from pathlib import Path
import stat
import sys


def read_log(source, download=False, home=None):
    home = Path(home or Path.home())
    cache = home / '.cache/robot-console'
    if source in ('teleop', 'trajectory', 'realsense'):
        root = cache
        path = cache / ('arm-' + source + '.log')
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
        limit = 32 * 1024 * 1024 if download else 128 * 1024
        if download and info.st_size > limit:
            raise ValueError('日志超过 32 MiB 下载上限，请在 Jetson 上归档后获取')
        start = max(0, info.st_size - limit)
        stream.seek(start)
        data = stream.read(min(limit, info.st_size))
        if start and b'\n' in data:
            data = data.split(b'\n', 1)[1]
        line_truncated = False
        if not download:
            lines = data.splitlines(keepends=True)
            line_truncated = len(lines) > 2000
            if line_truncated:
                data = b''.join(lines[-2000:])
        result.update(exists=True, content=data.decode('utf-8', errors='replace'), truncated=start > 0 or line_truncated,
                      sizeBytes=info.st_size, revision=f'{info.st_dev}:{info.st_ino}:{info.st_size}:{info.st_mtime_ns}')
    return result


if __name__ == '__main__':
    print(json.dumps(read_log(sys.argv[1], sys.argv[2] == 'download'), ensure_ascii=True))
