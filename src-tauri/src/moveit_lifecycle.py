"""Launch only the real MoveIt planner; never starts hardware or sends a goal."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import uuid

LAUNCH = ['/opt/ros/humble/bin/ros2', 'launch', 'rebotarm_moveit_config',
          'real_move_group.launch.py']


def identity(pid):
    try:
        path = Path('/proc') / str(pid)
        fields = (path / 'stat').read_text().rsplit(') ', 1)[1].split()
        if fields[0] == 'Z':
            return None
        args = (path / 'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
        if args[-3:] != [v.encode() for v in LAUNCH[-3:]]:
            raise ValueError('MoveIt PID 已被其他进程使用，保留现场')
        environment = dict(item.split(b'=', 1) for item in
                           (path / 'environ').read_bytes().split(b'\0') if b'=' in item)
        return dict(pid=pid, start=fields[19], uid=path.stat().st_uid,
                    domain=environment.get(b'ROS_DOMAIN_ID', b'0').decode())
    except (FileNotFoundError, ProcessLookupError):
        return None


def group_members(group):
    result = []
    for path in Path('/proc').glob('[0-9]*'):
        try:
            fields = (path / 'stat').read_text().rsplit(') ', 1)[1].split()
            if fields[0] != 'Z' and int(fields[2]) == group:
                result.append(int(path.name))
        except (FileNotFoundError, ProcessLookupError):
            pass
    return result


class RosProbe:
    def __init__(self):
        import rclpy
        from rclpy.action import ActionClient
        from moveit_msgs.action import MoveGroup
        from moveit_msgs.srv import GetPlanningScene
        from rcl_interfaces.srv import GetParameters
        self.rclpy = rclpy
        rclpy.init()
        self.node = rclpy.create_node('robot_console_moveit_readiness')
        self.action = ActionClient(self.node, MoveGroup, '/move_action')
        self.parameters = self.node.create_client(GetParameters, '/move_group/get_parameters')
        self.scene = self.node.create_client(GetPlanningScene, '/get_planning_scene')

    def tick(self):
        self.rclpy.spin_once(self.node, timeout_sec=0.2)

    def count(self):
        # MoveIt itself creates several nodes named move_group. Count unique
        # action status publishers, not those internal node-name duplicates.
        return len({tuple(info.endpoint_gid) for info in
                    self.node.get_publishers_info_by_topic('/move_action/_action/status')
                    if info.topic_type == 'action_msgs/msg/GoalStatusArray'})

    def present(self):
        return any(name == 'move_group' and namespace == '/'
                   for name, namespace in self.node.get_node_names_and_namespaces())

    def ready(self):
        return (self.action.server_is_ready() and self.parameters.service_is_ready()
                and self.scene.service_is_ready())

    def close(self):
        self.node.destroy_node()
        self.rclpy.shutdown()


class Manager:
    def __init__(self, cache, domain):
        self.cache, self.domain = Path(cache), str(domain)
        self.file = self.cache / f'moveit-{domain}.json'

    def owner(self):
        if not self.file.exists():
            return None
        saved = json.loads(self.file.read_text())
        if (saved.get('domain') != self.domain or saved.get('uid') != os.getuid()
                or not isinstance(saved.get('pid'), int) or saved['pid'] <= 1):
            raise ValueError('MoveIt 归属文件无效，拒绝清理或重复启动')
        current = identity(saved['pid'])
        if current is None:
            if group_members(saved['pid']):
                raise ValueError('MoveIt 启动器已退出但子进程仍在，保留现场')
            self.file.unlink()
            return None
        if current != saved or os.getpgid(saved['pid']) != saved['pid']:
            raise ValueError('MoveIt PID 身份或 ROS 域已变化，保留现场')
        return current

    def stop(self):
        owner = self.owner()
        if owner is None:
            return
        # Signal the verified launcher once; ros2 launch forwards shutdown to
        # its children. Broadcasting to the group would signal them twice.
        # External planners have no ownership file and are never stopped here.
        pid = owner['pid']
        ignored = next(line.split()[1] for line in
                       (Path('/proc') / str(pid) / 'status').read_text().splitlines()
                       if line.startswith('SigIgn:'))
        if self.owner() != owner:
            raise ValueError('MoveIt 进程身份变化，拒绝发送信号')
        os.kill(pid, signal.SIGTERM if int(ignored, 16) & 2 else signal.SIGINT)
        deadline = time.monotonic() + 12
        while group_members(pid):
            if time.monotonic() >= deadline:
                raise ValueError('MoveIt 未在期限内退出；未强杀，归属文件保留')
            time.sleep(0.2)
        self.file.unlink(missing_ok=True)

    def start(self, probe):
        owner = self.owner()
        # Allow DDS discovery before deciding whether an externally started
        # planner exists; an existing but unready node must not be duplicated.
        discovery = time.monotonic() + 2
        while time.monotonic() < discovery:
            probe.tick()
        count = probe.count()
        if count > 1:
            raise ValueError('当前 ROS 域存在多个 /move_action 实例，请先处理重复规划器')
        if count == 1 and probe.ready():
            return owner['pid'] if owner else 0, '复用已就绪 MoveIt'
        process = None
        if owner is None and count == 0 and not probe.present():
            self.cache.mkdir(parents=True, exist_ok=True)
            log = self.cache / 'arm-moveit.log'
            if log.exists():
                history = self.cache / 'history'
                history.mkdir(exist_ok=True)
                log.rename(history / f'arm-moveit.log.{uuid.uuid4().hex}')
            with log.open('wb') as output:
                process = subprocess.Popen(LAUNCH, stdin=subprocess.DEVNULL,
                                           stdout=output, stderr=subprocess.STDOUT,
                                           start_new_session=True)
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                owner = identity(process.pid)
                if owner:
                    break
                time.sleep(0.05)
            if not owner or owner['domain'] != self.domain or owner['uid'] != os.getuid():
                raise ValueError('无法核验新启动 MoveIt 的进程归属')
            fd, temporary = tempfile.mkstemp(dir=self.cache)
            with os.fdopen(fd, 'w') as stream:
                json.dump(owner, stream)
            os.replace(temporary, self.file)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            probe.tick()
            if process is not None and process.poll() is not None:
                raise ValueError('MoveIt 提前退出，请查看 arm-moveit.log')
            count = probe.count()
            if count > 1:
                raise ValueError('发现重复 /move_action 实例，拒绝声明就绪')
            if count == 1 and probe.ready():
                return owner['pid'] if owner else 0, 'MoveIt 已就绪'
        raise ValueError('等待 /move_action、参数服务与 Planning Scene 超时；查看 arm-moveit.log')


def main():
    manager = Manager(Path.home() / '.cache/robot-console', os.environ.get('ROS_DOMAIN_ID', '0'))
    if sys.argv[1] == 'stop':
        manager.stop()
        return
    if sys.argv[1] != 'start':
        raise ValueError('不支持的 MoveIt 操作')
    probe = RosProbe()
    try:
        pid, message = manager.start(probe)
        print(f'OK|{pid}|{message}', flush=True)
    except Exception:
        # A failed planner never interrupts the arm's continuous command stream.
        # Preserve owned processes for a subsequent retry/explicit mode cleanup.
        log = manager.cache / 'arm-moveit.log'
        if log.is_file():
            with log.open('rb') as stream:
                stream.seek(max(0, log.stat().st_size - 8192))
                print(stream.read().decode(errors='replace'), file=sys.stderr)
        raise
    finally:
        probe.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'MoveIt: {error}', file=sys.stderr)
        sys.exit(1)
