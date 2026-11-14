"""Linux process integration. Uses only temporary Python children, never ROS/hardware."""
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

SPEC = importlib.util.spec_from_file_location("collection_remote", Path(__file__).parents[1] / "src/collection_remote.py")
remote = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(remote)


class Processes(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.children = []
        self.addCleanup(self.cleanup_children)

    def cleanup_children(self):
        for child in self.children:
            if child.poll() is None:
                child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)

    def child(self, module="rebotarm_vla.lerobot_recorder"):
        log = self.root / f"child-{len(self.children)}.log"
        ready = log.with_suffix(".ready")
        code = """import signal,sys,time
from pathlib import Path
log,ready=map(Path,sys.argv[1:3])
def finish(sig,frame):
    log.write_text('Dataset finalized\\n')
    sys.exit(0)
signal.signal(signal.SIGINT,finish)
ready.touch()
while True: time.sleep(.01)
"""
        child = subprocess.Popen([sys.executable, "-c", code, str(log), str(ready), module])
        self.children.append(child)
        deadline = time.monotonic() + 5
        while not ready.exists():
            self.assertIsNone(child.poll())
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.01)
        return child, log

    def test_real_identity_and_pidfd_finalize_only_the_owned_child(self):
        child, log = self.child()
        other, _ = self.child()
        identity = remote.process_identity(child.pid)
        self.assertEqual(len(identity), 64)
        self.assertEqual(identity, remote.process_identity(child.pid))
        self.assertNotEqual(identity, remote.process_identity(other.pid))
        class Services:
            def call(self, action, **kwargs):
                if action != "status":
                    raise AssertionError("no ROS mutation allowed")
                return json.dumps(dict(recording=False, pending_frames=0, saved_episodes=1, fps=20, task="fixture"))
        control = remote.RecorderControl(Services(), self.root / "cache")
        control.cache.mkdir()
        control.log_path = log
        control.manifest.write_text(json.dumps(dict(pid=child.pid, identity=identity,
            config=dict(root=str(self.root / "dataset"), repoId="fixture/cube"))))
        result = control.finish()
        self.assertEqual(child.wait(timeout=5), 0)
        self.assertEqual(result["state"], "stopped")
        self.assertEqual(result["savedEpisodes"], 1)
        self.assertIsNone(other.poll())

    def test_mismatch_and_wrong_module_send_no_signal_and_close_descriptor(self):
        child, _ = self.child()
        other, _ = self.child("unrelated-fixture")
        before = len(list(Path("/proc/self/fd").iterdir()))
        for pid in [child.pid, other.pid]:
            with self.assertRaisesRegex(RuntimeError, "进程身份已改变"):
                with remote.recorder_pidfd(pid, "0" * 64) as fd:
                    signal.pidfd_send_signal(fd, signal.SIGINT)
        self.assertEqual(len(list(Path("/proc/self/fd").iterdir())), before)
        self.assertIsNone(child.poll())
        self.assertIsNone(other.poll())
        self.assertIsNone(remote.process_identity(other.pid))

    def test_descriptor_of_exited_process_cannot_signal_a_new_process(self):
        child, _ = self.child()
        with remote.recorder_pidfd(child.pid, remote.process_identity(child.pid)) as fd:
            child.terminate()
            child.wait(timeout=5)
            other, _ = self.child()
            with self.assertRaises(ProcessLookupError):
                signal.pidfd_send_signal(fd, signal.SIGINT)
            self.assertIsNone(other.poll())


if __name__ == "__main__":
    if sys.platform != "linux" or not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise SystemExit("This integration suite requires Linux and pidfd support; run on the isolated Jetson test host")
    unittest.main()
