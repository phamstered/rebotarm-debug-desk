"""Owned rosbag processes. Read-only status; locked mutations; pidfd signals.

No ROS Python dependency. All launch commands are fixed argv plus validated
configuration. A missing/unreadable identity is never permission to signal a PID.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import time

TOKEN = "ROBOT_CONSOLE_BAG_TOKEN"
MAX_BYTES = 16384


class Processes:
    def boot(self):
        return Path("/proc/sys/kernel/random/boot_id").read_text().strip()

    def inspect(self, pid):
        try:
            root = Path("/proc") / str(pid)
            fields = (root / "stat").read_text().rsplit(")", 1)[1].split()
            if fields[0] in ("Z", "X"):
                return None
            env = (root / "environ").read_bytes().split(b"\0")
            token = next((item.split(b"=", 1)[1].decode("ascii") for item in env if item.startswith((TOKEN + "=").encode())), "")
            return {"pid": pid, "start": fields[19], "group": int(fields[2]),
                    "session": int(fields[3]), "token": token, "uid": root.stat().st_uid}
        except (FileNotFoundError, ProcessLookupError):
            return None

    def members(self, record):
        if record["boot"] != self.boot():
            return []
        result = []
        # A private session may outlive its leader. Never infer group exit merely
        # from the original CLI PID disappearing.
        for path in Path("/proc").iterdir():
            if not path.name.isdigit():
                continue
            same_session = int(path.name) == record["pid"]
            try:
                fields = (path / "stat").read_text().rsplit(")", 1)[1].split()
                same_session = int(fields[2]) == record["pid"] and int(fields[3]) == record["pid"]
                if fields[0] in ("Z", "X") or path.stat().st_uid != os.getuid():
                    continue
                item = self.inspect(int(path.name))
            except (FileNotFoundError, ProcessLookupError):
                continue
            except PermissionError:
                # Unrelated non-dumpable processes are not our bag. An unreadable
                # member of the recorded private session remains unknown.
                if same_session:
                    raise
                continue
            if item is None:
                continue
            if item["token"] != record["token"]:
                if item["group"] == record["pid"] and item["session"] == record["pid"]:
                    raise RuntimeError("bag process group identity changed; refusing to infer idle or signal")
                continue
            if item["pid"] == record["pid"] and item["start"] != record["start"]:
                raise RuntimeError("bag leader PID was reused")
            result.append(item)
        return result

    def send(self, item, sig):
        if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
            raise RuntimeError("kernel/Python pidfd support required to stop an owned bag")
        try:
            fd = os.pidfd_open(item["pid"])
        except ProcessLookupError:
            return
        try:
            # Bind first, then check identity again. The descriptor keeps the
            # signal attached to that process even if the numeric PID is reused.
            current = self.inspect(item["pid"])
            if current is None:
                return
            if current != item:
                raise RuntimeError("bag process changed before signal")
            try:
                signal.pidfd_send_signal(fd, sig)
            except ProcessLookupError:
                pass
        finally:
            os.close(fd)

    def legacy_alive(self, pid, kind):
        try:
            args = (Path("/proc") / str(pid) / "cmdline").read_bytes().split(b"\0")
            return any(Path(arg.decode(errors="replace")).name == "ros2" for arg in args) and b"bag" in args and kind.encode() in args
        except (FileNotFoundError, ProcessLookupError):
            return False


def read_file(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > MAX_BYTES:
            raise RuntimeError("invalid bag process record")
        return stream.read()


def write_file(path, data):
    fd, temporary = tempfile.mkstemp(prefix=".bag-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Manager:
    def __init__(self, home, kind, processes=None):
        if kind not in ("record", "play"):
            raise ValueError("invalid bag kind")
        self.home, self.kind = Path(home), kind
        self.legacy_root = self.home / ".cache/robot-console"
        self.root = self.legacy_root / "bag-processes-v1"
        self.stem = "rosbag" if kind == "record" else "rosbag-play"
        self.path = self.root / (self.stem + "-process-v1.json")
        self.processes = processes or Processes()

    def validate_root(self):
        if self.root.exists():
            info = self.root.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
                raise RuntimeError("bag directory is not a private writable owner directory")

    def load(self):
        self.validate_root()
        raw = read_file(self.path)
        pending = read_file(self.root / (self.stem + ".pending"))
        if pending is not None and (raw is None or json.loads(pending).get("token") != json.loads(raw).get("token")):
            raise RuntimeError("bag launch reservation is unresolved; process identity must be recovered before another launch")
        if raw is None:
            legacy = read_file(self.legacy_root / (self.stem + ".pid"))
            if legacy and legacy.strip().isdigit() and int(legacy) > 1 and self.processes.legacy_alive(int(legacy), self.kind):
                raise RuntimeError("legacy bag is running without process identity; stop it with its original launcher before upgrading")
            return None
        record = json.loads(raw)
        if (record.get("version") != 1 or record.get("kind") != self.kind
                or type(record.get("pid")) is not int or record["pid"] <= 1
                or not isinstance(record.get("start"), str) or not record["start"].isdigit()
                or not isinstance(record.get("boot"), str) or not record["boot"]
                or not isinstance(record.get("token"), str) or len(record["token"]) != 48
                or any(c not in "0123456789abcdef" for c in record["token"])
                or not valid_path(record.get("path"))
                or type(record.get("domain")) is not int or not 0 <= record["domain"] <= 65535):
            raise RuntimeError("invalid bag process identity")
        return record

    def status(self):
        record = self.load()
        members = self.processes.members(record) if record else []
        history = record["path"] if record else (read_file(self.legacy_root / (self.stem + ".path")) or b"").decode().strip()
        if not valid_path(history):
            raise RuntimeError("invalid bag history path")
        return {"active": bool(members), "pid": record["pid"] if members else 0,
                "path": history, "domain": record["domain"] if record else None,
                "processIdentity": hashlib.sha256(json.dumps([record[k] for k in ("boot", "pid", "start", "token")]).encode()).hexdigest() if record else ""}

    def locked(self, operation):
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.validate_root()
        fd = os.open(self.root / (self.stem + ".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as lock:
            info = os.fstat(lock.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                raise RuntimeError("invalid bag operation lock")
            fcntl.flock(lock, fcntl.LOCK_EX)
            return operation()

    def start(self, setup, domain, path="", launch=None, transport=""):
        def operation():
            before = self.status()
            if before["active"]:
                if before["domain"] != domain or (self.kind == "play" and before["path"] != path):
                    raise RuntimeError("another bag is already active; stop it before changing domain/path")
                return before
            token = secrets.token_hex(24)
            destination = path
            if self.kind == "record":
                base = self.home / "robot-console-bags"
                base.mkdir(exist_ok=True)
                destination = str(base / ("robot-console-" + time.strftime("%Y%m%d-%H%M%S") + "-" + token[:8]))
                args = ["ros2", "bag", "record", "-a", "-o", destination]
            else:
                target = Path(path)
                if not target.is_absolute():
                    target = self.home / target
                if not target.exists():
                    raise RuntimeError("bag path not found")
                args = ["ros2", "bag", "play", str(target), "--clock"]
            setup_path = shlex.quote(str(self.home / setup))
            shell = transport + "\nsource /opt/ros/humble/setup.bash; if [ -f " + setup_path + " ]; then source " + setup_path + "; fi; exec " + shlex.join(args)
            pending = self.root / (self.stem + ".pending")
            write_file(pending, json.dumps({"token": token, "boot": self.processes.boot(), "kind": self.kind, "domain": domain, "path": destination}).encode())
            # The PID is a private session leader; descendants inherit the token.
            with open(self.root / (self.stem + ".log"), "ab") as log:
                try:
                    child = (launch or subprocess.Popen)(["bash", "-c", shell], stdin=subprocess.DEVNULL,
                        stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                        env={**os.environ, TOKEN: token, "ROS_DOMAIN_ID": str(domain)})
                except OSError:
                    pending.unlink()  # Popen itself failed: no child was created.
                    raise
            identity = self.processes.inspect(child.pid)
            if not identity or identity["uid"] != os.getuid() or identity["token"] != token or identity["group"] != child.pid or identity["session"] != child.pid:
                raise RuntimeError("unable to bind newly launched bag process identity; no PID will be signaled")
            record = {"version": 1, "kind": self.kind, "pid": child.pid, "start": identity["start"],
                      "boot": self.processes.boot(), "token": token, "domain": domain, "path": destination}
            write_file(self.path, json.dumps(record).encode())
            pending.unlink()
            # Keep the old read-only status files useful, but never use them as
            # authority for signaling in this implementation.
            write_file(self.legacy_root / (self.stem + ".pid"), str(child.pid).encode())
            write_file(self.legacy_root / (self.stem + ".path"), destination.encode())
            return self.status()
        return self.locked(operation)

    def stop(self, domain, grace=5.0, terminate_grace=2.5):
        def operation():
            record = self.load()
            if record is None:
                return self.status()
            if record["domain"] != domain and self.processes.members(record):
                raise RuntimeError("bag belongs to another ROS domain")
            for sig, duration in [(signal.SIGINT, grace), (signal.SIGTERM, terminate_grace)]:
                deadline = time.monotonic() + duration
                sent = set()
                while True:
                    members = self.processes.members(record)
                    if not members:
                        # Retain identity/history to distinguish gone from unknown.
                        return self.status()
                    for item in members:
                        key = (item["pid"], item["start"])
                        if key not in sent:
                            self.processes.send(item, sig)
                            sent.add(key)
                    if time.monotonic() >= deadline:
                        break
                    time.sleep(0.05)
            if not self.processes.members(record):
                return self.status()
            raise RuntimeError("bag process group has not exited; identity retained")
        return self.locked(operation)


def valid_path(value):
    return isinstance(value, str) and len(value) <= 4096 and not any(ord(c) < 32 or c == "|" for c in value)


def main():
    request = json.loads(sys.argv[1])
    if not isinstance(request, dict) or request.get("action") not in ("status", "start", "stop") or type(request.get("domain")) is not int or not 0 <= request["domain"] <= 65535:
        raise ValueError("invalid bag request")
    manager = Manager(Path.home(), request["kind"])
    action = request["action"]
    if action == "start":
        if not valid_path(request.get("setup")) or not request["setup"] or not valid_path(request.get("path", "")):
            raise ValueError("invalid bag setup/path")
        result = manager.start(request["setup"], request["domain"], request.get("path", ""), transport=request.get("transport", ""))
    elif action == "stop":
        result = manager.stop(request["domain"])
    else:
        result = manager.status()
        if result["active"] and result["domain"] != request["domain"]:
            raise RuntimeError("bag belongs to another ROS domain")
    state = ("RECORDING" if manager.kind == "record" else "PLAYING") if result["active"] else "IDLE"
    print("%s|%s|%s" % (state, result["pid"], result["path"]))
    receipt = {key: result[key] for key in ("active", "pid", "domain", "processIdentity")}
    receipt.update(kind=manager.kind, pathHash=hashlib.sha256(result["path"].encode()).hexdigest())
    print("ROBOT_CONSOLE_BAG_RECEIPT=" + json.dumps(receipt))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("rosbag: " + str(error), file=sys.stderr)
        sys.exit(1)
