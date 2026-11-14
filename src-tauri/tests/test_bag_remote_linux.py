"""Explicit Linux integration suite: private subprocesses only, never ROS."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location("bag_remote", Path(__file__).parents[1] / "src/bag_remote.py")
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)


class LinuxProcessTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="bag-identity-fixture-")
        self.home = Path(self.directory.name)
        self.manager = remote.Manager(self.home, "record")
        self.child = None
        self.addCleanup(self.clean)

    def clean(self):
        if self.manager.path.exists():
            record = json.loads(self.manager.path.read_text())
            for item in self.manager.processes.members(record):
                self.manager.processes.send(item, signal.SIGKILL)
        if self.child:
            self.child.wait(timeout=3)
        self.directory.cleanup()

    def launch(self, code):
        def process(argv, **kwargs):
            self.assertIn("ros2 bag record", argv[-1])
            self.child = subprocess.Popen([sys.executable, "-c", code], **kwargs)
            return self.child
        self.manager.start("unused/install/setup.bash", 220, launch=process)

    def wait(self, condition):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if condition(): return
            time.sleep(0.03)
        self.fail("fixture deadline expired")

    def test_private_process_survives_parent_cli_and_pidfd_stops_only_owned_process(self):
        unrelated = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"], start_new_session=True)
        self.addCleanup(lambda: (unrelated.terminate(), unrelated.wait(timeout=3)) if unrelated.poll() is None else None)
        self.launch("import signal,time;signal.signal(signal.SIGINT,signal.SIG_IGN);time.sleep(30)")
        again = remote.Manager(self.home, "record")
        self.assertTrue(again.status()["active"])
        self.assertFalse(again.stop(220, 0.1, 1)["active"])
        self.child.wait(timeout=3)
        self.assertIsNone(unrelated.poll())
        self.assertTrue(self.manager.path.exists(), "retain process identity after exit")

    def test_descendant_in_new_session_is_found_after_leader_exits(self):
        ready = self.home / "descendant.pid"
        descendant = "import signal,time;signal.signal(signal.SIGINT,signal.SIG_IGN);time.sleep(30)"
        code = "import subprocess,sys,pathlib,time;child=subprocess.Popen([sys.executable,'-c'," + repr(descendant) + "],start_new_session=True);pathlib.Path(" + repr(str(ready)) + ").write_text(str(child.pid));time.sleep(0.5)"
        self.launch(code)
        self.wait(ready.exists)
        self.child.wait(timeout=5)
        self.assertTrue(self.manager.status()["active"], "leader exit must not imply bag exit")
        self.assertFalse(self.manager.stop(220, 0.1, 1)["active"])

    def test_changed_start_time_refuses_signal_and_preserves_process(self):
        self.launch("import time;time.sleep(30)")
        record = json.loads(self.manager.path.read_text())
        changed = {**record, "start": str(int(record["start"]) + 1)}
        remote.write_file(self.manager.path, json.dumps(changed).encode())
        try:
            with self.assertRaisesRegex(RuntimeError, "PID was reused"):
                self.manager.stop(220, 0, 0)
            self.assertIsNone(self.child.poll())
        finally:
            remote.write_file(self.manager.path, json.dumps(record).encode())
        self.assertFalse(self.manager.stop(220, 0.1, 1)["active"])


if __name__ == "__main__":
    if sys.platform != "linux" or not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError("Run this explicit integration suite on Linux with pidfd support")
    unittest.main()
