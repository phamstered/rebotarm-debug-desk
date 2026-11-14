"""One-shot Controller command journal. Invoked over authenticated SSH only.

submit reserves a record before forking; query never executes a command. The
native caller never retries submit. Nonzero/timeout is uncertain (the ROS service
may still have received the request), not proof that the switch was rejected.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time

VERSION = 1
MAX_RECORDS = 256
MAX_RECORD_BYTES = 16384
COMMAND_TIMEOUT = 20
ID = re.compile(r"(?:controller-|arm-mode-|collection-|bag-)[a-f0-9]{48}\Z")
PHASES = {"reserved", "running", "succeeded", "rejected", "uncertain"}


def request(value):
    if not isinstance(value, dict) or value.get("op") not in ("submit", "query"):
        raise ValueError("invalid operation")
    job = value.get("id", "")
    digest = value.get("command_hash", "")
    if not isinstance(job, str) or not ID.fullmatch(job):
        raise ValueError("invalid operation id")
    if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("invalid command hash")
    if value["op"] == "submit":
        command = value.get("command")
        if not isinstance(command, str) or not command or len(command.encode()) > (131072 if job.startswith(("arm-mode-", "collection-")) else 32768) or "\0" in command:
            raise ValueError("invalid command")
        if hashlib.sha256(command.encode()).hexdigest() != digest:
            raise ValueError("command hash mismatch")
    elif "command" in value:
        raise ValueError("read-only query cannot include a command")
    return job, digest


def root_dir(root, create):
    if create:
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        info = root.lstat()
    except FileNotFoundError:
        return False
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("operation directory must be private and not a symlink")
    return True


def read_record(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_RECORD_BYTES:
            raise ValueError("invalid operation record size/type")
        value = json.load(stream)
    if (value.get("version") != VERSION or value.get("phase") not in PHASES
            or not isinstance(value.get("started"), bool)
            or value.get("id") != path.stem):
        raise ValueError("invalid operation record")
    if value["phase"] == "succeeded" and (value.get("exit_code") != 0 or not value["started"]):
        raise ValueError("invalid success proof")
    if value["phase"] == "rejected" and value["started"]:
        raise ValueError("invalid pre-execution rejection")
    return value


def write_record(root, value):
    data = json.dumps(value, ensure_ascii=True).encode()
    if len(data) > MAX_RECORD_BYTES:
        raise ValueError("operation record too large")
    fd, temporary = tempfile.mkstemp(prefix=".record-", dir=root)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, root / (value["id"] + ".json"))
        directory = os.open(root, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def query(root, job, digest):
    unknown = {"version": VERSION, "id": job, "command_hash": digest, "phase": "unknown"}
    if not root_dir(root, False):
        return unknown
    try:
        value = read_record(root / (job + ".json"))
    except FileNotFoundError:
        return unknown
    if value.get("command_hash") != digest:
        raise ValueError("operation id belongs to another command")
    return value


def reserve(root, job, digest):
    root_dir(root, True)
    # Serialize reservation and bounded retention; never evict unresolved jobs.
    fd = os.open(root / ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        existing = query(root, job, digest)
        if existing["phase"] != "unknown":
            return existing, False
        records = list(root.glob("controller-*.json")) + list(root.glob("arm-mode-*.json")) + list(root.glob("collection-*.json")) + list(root.glob("bag-*.json"))
        if len(records) >= MAX_RECORDS:
            completed = []
            for path in records:
                value = read_record(path)
                if value["phase"] in ("succeeded", "rejected"):
                    completed.append((path.stat().st_mtime_ns, path))
            if not completed:
                raise ValueError("operation journal full of unresolved jobs")
            for _, path in sorted(completed)[:len(records) - MAX_RECORDS + 1]:
                path.unlink()
        value = {"version": VERSION, "id": job, "command_hash": digest,
                 "phase": "reserved", "started": False, "message": "reserved before execution"}
        write_record(root, value)
        return value, True


def worker(root, record, command, timeout=COMMAND_TIMEOUT):
    # This write must finish durably before Popen; missing records never prove no-op.
    record = dict(record, phase="running", started=True, message="command running")
    write_record(root, record)
    try:
        child = subprocess.Popen(["bash", "-lc", command], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 start_new_session=True)
    except OSError as error:
        record.update(phase="rejected", started=False, message=str(error)[:512])
        write_record(root, record)
        return
    tail = bytearray()
    progress_buffer = bytearray()
    expired = False
    deadline = time.monotonic() + timeout
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                expired = True
                break
            for key, _ in selector.select(min(remaining, 0.1)):
                data = os.read(key.fd, 4096)
                if not data:
                    selector.unregister(key.fileobj)
                else:
                    tail.extend(data)
                    del tail[:-2048]
                    if record["id"].startswith(("arm-mode-", "collection-", "bag-")):
                        progress_buffer.extend(data)
                        while b"\n" in progress_buffer:
                            line, _, rest = progress_buffer.partition(b"\n")
                            progress_buffer = bytearray(rest)
                            if record["id"].startswith("arm-mode-") and line.startswith(b"ARM_STAGE|") and len(line) <= 2048:
                                # ensure_ascii expands malformed/unicode input;
                                # leave room for the separately bounded log tail.
                                record["progress"] = line.decode("utf-8", errors="replace")[:512]
                                write_record(root, record)
                            if ((record["id"].startswith("collection-") and line.startswith(b"ROBOT_CONSOLE_COLLECTION_RECEIPT=")) or (record["id"].startswith("bag-") and line.startswith(b"ROBOT_CONSOLE_BAG_RECEIPT="))) and len(line) <= 1024:
                                try:
                                    receipt = json.loads(line.split(b"=", 1)[1])
                                    if isinstance(receipt, dict) and len(json.dumps(receipt, ensure_ascii=True)) <= 1024:
                                        record["receipt"] = receipt
                                except ValueError:
                                    pass
                        if len(progress_buffer) > 2048:
                            progress_buffer.clear()
        if not expired:
            try:
                child.wait(timeout=max(0.001, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                expired = True
        if expired:
            # Only our subprocess group. Ending the local CLI does NOT prove the
            # remote ROS service stopped: the journal deliberately stays uncertain.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
    child.stdout.close()
    record.update(phase="succeeded" if child.returncode == 0 and not expired else "uncertain",
                  exit_code=child.returncode, timed_out=expired,
                  message=tail.decode("utf-8", errors="replace"))
    if record["id"].startswith(("collection-", "bag-")) and "receipt" not in record:
        record["phase"] = "uncertain"
    write_record(root, record)


def submit(root, job, digest, command):
    record, fresh = reserve(root, job, digest)
    if not fresh:
        return record
    try:
        pid = os.fork()
    except OSError as error:
        record.update(phase="rejected", message=str(error)[:512])
        write_record(root, record)
        return record
    if pid == 0:
        try:
            os.setsid()
            signal.signal(signal.SIGHUP, signal.SIG_IGN)
            fd = os.open(os.devnull, os.O_RDWR)
            for target in (0, 1, 2):
                os.dup2(fd, target)
            if fd > 2:
                os.close(fd)
            worker(root, record, command, timeout=600 if job.startswith("arm-mode-") else 180 if job.startswith("collection-") else COMMAND_TIMEOUT)
        finally:
            os._exit(0)
    return record


def main():
    raw = sys.stdin.buffer.read(1048577)
    if len(raw) > 1048576:
        raise ValueError("request too large")
    value = json.loads(raw)
    job, digest = request(value)
    root = Path.home() / ".cache/rebotarm-debug-desk/controller-operations-v1"
    result = (submit(root, job, digest, value["command"]) if value["op"] == "submit"
              else query(root, job, digest))
    print(json.dumps(result, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
