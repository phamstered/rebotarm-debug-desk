import importlib.util
import json
import os
from pathlib import Path
import signal
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).parents[1] / "src/bag_remote.py"
spec = importlib.util.spec_from_file_location("bag_remote", SCRIPT)
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)


class FakeProcesses:
    def __init__(self):
        self.items = []
        self.signals = []
        self.exit_on = signal.SIGTERM
        self.boot_id = "boot-a"
        self.legacy = False

    def boot(self):
        return self.boot_id

    def inspect(self, pid):
        return next((dict(item) for item in self.items if item["pid"] == pid), None)

    def members(self, record):
        if record["boot"] != self.boot():
            return []
        if any(item["token"] != record["token"] or (item["pid"] == record["pid"] and item["start"] != record["start"]) for item in self.items):
            raise RuntimeError("identity changed")
        return list(self.items)

    def send(self, item, sig):
        self.signals.append((item["pid"], sig))
        if sig == self.exit_on:
            self.items = [current for current in self.items if current["pid"] != item["pid"]]

    def legacy_alive(self, pid, kind):
        return self.legacy


class BagTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.processes = FakeProcesses()
        self.manager = remote.Manager(self.home, "record", self.processes)
        self.launches = []

    def launch(self, argv, **kwargs):
        self.launches.append((argv, kwargs))
        self.assertTrue((self.manager.root / (self.manager.stem + ".pending")).exists(), "reserve before launching")
        self.processes.items = [{"pid": 42, "start": "100", "token": kwargs["env"][remote.TOKEN],
                                 "group": 42, "session": 42, "uid": os.getuid()}]
        return type("Child", (), {"pid": 42})()

    def start(self):
        return self.manager.start("project/install/setup.bash", 220, launch=self.launch)

    def test_read_only_empty_and_legacy_history_and_live_legacy_refusal(self):
        self.assertFalse(self.manager.status()["active"])
        self.assertFalse(self.manager.root.exists())
        self.manager.legacy_root.mkdir(parents=True)
        pid = self.manager.legacy_root / "rosbag.pid"
        history = self.manager.legacy_root / "rosbag.path"
        pid.write_text("42\n"); history.write_text("bags/kept\n")
        self.assertEqual(self.manager.status()["path"], "bags/kept")
        self.processes.legacy = True
        for action in [self.manager.status, self.start, lambda: self.manager.stop(220, 0, 0)]:
            with self.assertRaisesRegex(RuntimeError, "legacy bag"):
                action()
        self.assertEqual(pid.read_text(), "42\n")
        self.assertEqual(history.read_text(), "bags/kept\n")
        self.assertFalse(self.launches or self.processes.signals)

    def test_start_identity_is_persisted_and_reopened_without_relaunch(self):
        started = self.start()
        self.assertTrue(started["active"])
        record = json.loads(self.manager.path.read_text())
        self.assertEqual(record["start"], "100")
        self.assertEqual(record["boot"], "boot-a")
        self.assertEqual(record["domain"], 220)
        self.assertEqual(len(record["token"]), 48)
        self.assertEqual(self.manager.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.manager.root.stat().st_mode & 0o777, 0o700)
        argv, kwargs = self.launches[0]
        self.assertIn("ros2 bag record -a -o", argv[-1])
        self.assertEqual(kwargs["env"]["ROS_DOMAIN_ID"], "220")
        self.assertTrue(kwargs["start_new_session"])
        other = remote.Manager(self.home, "record", self.processes)
        self.assertTrue(other.status()["active"])
        other.start("project/install/setup.bash", 220, launch=self.launch)
        self.assertEqual(len(self.launches), 1)
        with self.assertRaisesRegex(RuntimeError, "another bag"):
            other.start("project/install/setup.bash", 219, launch=self.launch)

    def test_stop_retains_identity_until_all_owned_processes_exit(self):
        self.start()
        self.processes.items.append({**self.processes.items[0], "pid": 43, "start": "110"})
        before = self.manager.path.read_bytes()
        self.processes.exit_on = None
        with self.assertRaisesRegex(RuntimeError, "has not exited"):
            self.manager.stop(220, 0, 0)
        self.assertEqual(self.manager.path.read_bytes(), before)
        self.assertTrue(self.manager.status()["active"])
        self.assertEqual(set(self.processes.signals), {(42, signal.SIGINT), (43, signal.SIGINT), (42, signal.SIGTERM), (43, signal.SIGTERM)})
        self.processes.exit_on = signal.SIGTERM
        self.assertFalse(self.manager.stop(220, 0, 0)["active"])
        self.assertEqual(self.manager.path.read_bytes(), before, "keep history/identity after exit")

    def test_playback_requires_existing_path_and_keeps_recording_identity_separate(self):
        self.manager = remote.Manager(self.home, "play", self.processes)
        with self.assertRaisesRegex(RuntimeError, "bag path not found"):
            self.manager.start("setup.bash", 220, "bags/missing", launch=self.launch)
        self.assertFalse(self.launches)
        target = self.home / "bags/example"
        target.mkdir(parents=True)
        result = self.manager.start("setup.bash", 220, "bags/example", launch=self.launch)
        self.assertTrue(result["active"])
        self.assertEqual(result["path"], "bags/example")
        self.assertIn("ros2 bag play " + str(target) + " --clock", self.launches[0][0][-1])
        self.assertFalse((self.manager.root / "rosbag-process-v1.json").exists())
        self.manager.start("setup.bash", 220, "bags/example", launch=self.launch)
        with self.assertRaisesRegex(RuntimeError, "another bag"):
            self.manager.start("setup.bash", 220, "bags/different", launch=self.launch)
        self.assertEqual(len(self.launches), 1)
        self.assertFalse(self.manager.stop(220, 0, 0)["active"])
        self.assertEqual(self.manager.status()["path"], "bags/example")

    def test_pid_reuse_wrong_domain_and_reboot_never_signal_another_process(self):
        self.start()
        with self.assertRaisesRegex(RuntimeError, "another ROS domain"):
            self.manager.stop(219, 0, 0)
        self.processes.items[0]["start"] = "999"
        with self.assertRaisesRegex(RuntimeError, "identity changed"):
            self.manager.stop(220, 0, 0)
        self.assertFalse(self.processes.signals)
        self.processes.boot_id = "boot-b"
        self.assertFalse(self.manager.status()["active"])
        self.assertFalse(self.manager.stop(220, 0, 0)["active"])
        self.assertFalse(self.processes.signals)

    def test_persistence_failure_after_launch_blocks_idle_and_duplicate_start(self):
        save = remote.write_file
        def fail(path, data):
            if path == self.manager.path:
                raise OSError("disk full")
            save(path, data)
        with patch.object(remote, "write_file", fail), self.assertRaises(OSError):
            self.start()
        self.assertEqual(len(self.launches), 1)
        with self.assertRaisesRegex(RuntimeError, "reservation is unresolved"):
            self.manager.status()
        with self.assertRaisesRegex(RuntimeError, "reservation is unresolved"):
            self.start()
        self.assertEqual(len(self.launches), 1)

    def test_concurrent_launches_share_remote_lock(self):
        barrier = threading.Barrier(2)
        errors = []
        def run():
            try:
                barrier.wait()
                self.start()
            except Exception as error:
                errors.append(error)
        threads = [threading.Thread(target=run) for _ in range(2)]
        for thread in threads: thread.start()
        for thread in threads: thread.join(3)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertFalse(errors)
        self.assertEqual(len(self.launches), 1)

    def test_corrupt_or_symlink_metadata_never_launches_or_signals(self):
        self.manager.root.mkdir(mode=0o700, parents=True)
        self.manager.path.write_text("broken")
        with self.assertRaises(ValueError): self.start()
        self.manager.path.unlink()
        target = self.home / "unrelated"
        target.write_text("keep")
        self.manager.path.symlink_to(target)
        with self.assertRaises(OSError): self.manager.stop(220, 0, 0)
        self.assertEqual(target.read_text(), "keep")
        self.assertFalse(self.launches or self.processes.signals)

    def test_pidfd_signal_rechecks_identity_and_does_not_use_numeric_kill(self):
        processes = remote.Processes()
        original = {"pid": 42, "start": "100", "token": "a" * 48}
        with patch.object(remote.os, "pidfd_open", return_value=71, create=True) as opened, patch.object(remote.os, "close") as closed, patch.object(remote.signal, "pidfd_send_signal", create=True) as sent, patch.object(processes, "inspect", return_value={**original, "start": "101"}):
            with self.assertRaisesRegex(RuntimeError, "changed before signal"):
                processes.send(original, signal.SIGINT)
            opened.assert_called_once_with(42);sent.assert_not_called();closed.assert_called_once_with(71)
        with patch.object(remote.os, "pidfd_open", return_value=72, create=True), patch.object(remote.os, "close"), patch.object(remote.signal, "pidfd_send_signal", create=True) as sent, patch.object(processes, "inspect", return_value=original):
            processes.send(original, signal.SIGTERM)
            sent.assert_called_once_with(72, signal.SIGTERM)

    def test_process_scan_finds_children_after_leader_exit_and_session_change(self):
        proc = self.home / "proc";proc.mkdir()
        token = "a" * 48
        def process(pid, group, session, actual_token):
            root = proc / str(pid);root.mkdir()
            fields = ["0"] * 20
            fields[0] = "S";fields[2] = str(group);fields[3] = str(session);fields[19] = "100"
            (root / "stat").write_text(f"{pid} (fixture) " + " ".join(fields))
            (root / "environ").write_bytes((remote.TOKEN + "=" + actual_token + "\0").encode())
        process(43, 42, 42, token)
        process(44, 44, 44, token)  # Child started a new session but retained ownership token.
        process(45, 45, 45, "unrelated")
        processes = remote.Processes()
        with patch.object(remote, "Path", side_effect=lambda value: proc if str(value) == "/proc" else Path(value)), patch.object(processes, "boot", return_value="boot-a"):
            items = processes.members({"boot": "boot-a", "pid": 42, "start": "90", "token": token})
            self.assertEqual({item["pid"] for item in items}, {43, 44})
            process(42, 42, 42, "foreign")
            with self.assertRaisesRegex(RuntimeError, "identity changed"):
                processes.members({"boot": "boot-a", "pid": 42, "start": "90", "token": token})


if __name__ == "__main__":
    unittest.main()
