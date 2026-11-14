import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shlex
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).parents[1] / "src/controller_remote.py"
spec = importlib.util.spec_from_file_location("controller_remote", SCRIPT)
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)


def job(command="true"):
    return {"op": "submit", "id": "controller-" + secrets.token_hex(24),
            "command_hash": hashlib.sha256(command.encode()).hexdigest(), "command": command}


class JournalTests(unittest.TestCase):
    def test_arm_progress_and_log_tail_fit_record_even_with_invalid_utf8(self):
        command = f"{shlex.quote(sys.executable)} -c 'import sys; sys.stdout.buffer.write(b\"ARM_STAGE|startup|\" + bytes([255])*2000 + b\"\\n\" + bytes([255])*5000)'"
        request = job(command)
        request["id"] = request["id"].replace("controller-", "arm-mode-")
        remote.worker(self.root, self.reserve(request), command)
        proof = remote.query(self.root, request["id"], request["command_hash"])
        self.assertEqual(proof["phase"], "succeeded")
        self.assertLessEqual(len(proof["progress"]), 512)
        self.assertLess((self.root / (request["id"] + ".json")).stat().st_size, remote.MAX_RECORD_BYTES)

    def test_arm_deadline_does_not_inherit_short_controller_timeout(self):
        short = job("sleep 0.3")
        arm = job("sleep 0.3")
        arm["id"] = arm["id"].replace("controller-", "arm-mode-")
        with patch.object(remote, "COMMAND_TIMEOUT", 0.05):
            remote.submit(self.root, short["id"], short["command_hash"], short["command"])
            remote.submit(self.root, arm["id"], arm["command_hash"], arm["command"])
        self.assertTrue(self.wait(short)["timed_out"])
        result = self.wait(arm)
        self.assertEqual(result["phase"], "succeeded")
        self.assertFalse(result["timed_out"])

    def test_arm_policy_records_progress_and_only_executes_once(self):
        marker = self.home / "arm-once"
        request = job("printf 'ARM_STAGE|startup|starting\\n'; sleep 0.3; printf x >> " + shlex.quote(str(marker)))
        request["id"] = request["id"].replace("controller-", "arm-mode-")
        self.cli(request, discard_reply=True)
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            proof = self.read(request)
            if proof.get("progress") == "ARM_STAGE|startup|starting":
                break
            time.sleep(0.01)
        self.assertEqual(proof.get("progress"), "ARM_STAGE|startup|starting")
        self.assertEqual(self.wait(request)["phase"], "succeeded")
        self.cli(request)
        self.assertEqual(marker.read_text(), "x")
        large = job("#" + "x" * 40000)
        with self.assertRaises(ValueError):
            remote.request(large)
        large["id"] = large["id"].replace("controller-", "arm-mode-")
        remote.request(large)
        too_large = job("#" + "x" * 131072)
        too_large["id"] = too_large["id"].replace("controller-", "arm-mode-")
        with self.assertRaises(ValueError):
            remote.request(too_large)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.root = self.home / ".cache/rebotarm-debug-desk/controller-operations-v1"

    def cli(self, value, discard_reply=False):
        result = subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(value).encode(),
                                stdout=subprocess.DEVNULL if discard_reply else subprocess.PIPE,
                                stderr=subprocess.PIPE, env={**os.environ, "HOME": str(self.home)}, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        return None if discard_reply else json.loads(result.stdout)

    def read(self, request):
        return self.cli({key: value for key, value in dict(request, op="query").items() if key != "command"})

    def wait(self, request):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            value = self.read(request)
            if value["phase"] in ("succeeded", "rejected", "uncertain"):
                return value
            time.sleep(0.01)
        self.fail("detached worker did not finish")

    def test_parent_exits_and_lost_reply_recovers_without_resubmission(self):
        output = self.home / "one execution"
        request = job(f"sleep 0.3; printf done >> {shlex.quote(str(output))}")
        self.cli(request, discard_reply=True)
        self.assertFalse(output.exists(), "parent must exit before delayed work finishes")
        result = self.wait(request)
        self.assertEqual(result["phase"], "succeeded")
        self.assertEqual(result["exit_code"], 0)
        self.assertFalse(result["timed_out"])
        self.assertEqual(output.read_text(), "done")
        for _ in range(3):
            self.read(request)
        self.assertEqual(output.read_text(), "done", "query must not execute")

    def test_duplicate_submit_is_idempotent_and_wrong_payload_cannot_take_over(self):
        output = self.home / "count"
        request = job(f"sleep 0.15; printf x >> {shlex.quote(str(output))}")
        self.cli(request)
        self.cli(request)
        changed = job("printf BAD")
        changed["id"] = request["id"]
        with self.assertRaisesRegex(ValueError, "another command"):
            remote.reserve(self.root, changed["id"], changed["command_hash"])
        self.assertEqual(self.wait(request)["phase"], "succeeded")
        self.cli(request)
        self.assertEqual(output.read_text(), "x")

    def reserve(self, request):
        return remote.reserve(self.root, request["id"], request["command_hash"])[0]

    def test_nonzero_and_timeout_are_not_completed_ros_service_proof(self):
        for command, timeout in [("exit 2", 2), ("sleep 3", 0.05)]:
            request = job(command)
            remote.worker(self.root, self.reserve(request), command, timeout)
            value = remote.query(self.root, request["id"], request["command_hash"])
            self.assertEqual(value["phase"], "uncertain")
            self.assertTrue(value["started"])
            self.assertEqual(value["timed_out"], command.startswith("sleep"))

    def test_spawn_rejection_is_proven_before_execution_and_record_write_precedes_launch(self):
        request = job()
        record = self.reserve(request)
        with patch.object(remote.subprocess, "Popen", side_effect=OSError("cannot spawn")):
            remote.worker(self.root, record, request["command"])
        proof = remote.query(self.root, request["id"], request["command_hash"])
        self.assertEqual(proof["phase"], "rejected")
        self.assertFalse(proof["started"])
        with patch.object(remote, "write_record", side_effect=OSError("disk full")), patch.object(remote.subprocess, "Popen") as spawn:
            with self.assertRaises(OSError):
                remote.worker(self.root, record, request["command"])
            spawn.assert_not_called()

    def test_missing_query_never_creates_or_executes_and_payload_is_strict(self):
        request = job("echo no")
        self.assertEqual(remote.query(self.root, request["id"], request["command_hash"])["phase"], "unknown")
        self.assertFalse(self.root.exists())
        for change in [{"id": "../escape"}, {"command_hash": "bad"}, {"op": "query"}, {"command": "other"}]:
            with self.assertRaises(ValueError):
                remote.request({**request, **change})

    def test_bounded_retention_never_evicts_unresolved_records(self):
        with patch.object(remote, "MAX_RECORDS", 3):
            pending = [job() for _ in range(3)]
            for request in pending:
                self.reserve(request)
            with self.assertRaisesRegex(ValueError, "unresolved"):
                self.reserve(job())
            remote.worker(self.root, self.reserve(pending[0]), "true")
            self.reserve(job())
            self.assertEqual(len(list(self.root.glob("controller-*.json"))), 3)
            self.assertEqual(remote.query(self.root, pending[0]["id"], pending[0]["command_hash"])["phase"], "unknown")
            self.assertEqual(remote.query(self.root, pending[1]["id"], pending[1]["command_hash"])["phase"], "reserved")

    def test_output_is_bounded_and_invalid_record_or_symlink_fails_closed(self):
        request = job(f"{shlex.quote(sys.executable)} -c 'print(\"x\" * 1000000)'")
        remote.worker(self.root, self.reserve(request), request["command"])
        path = self.root / (request["id"] + ".json")
        self.assertLess(path.stat().st_size, remote.MAX_RECORD_BYTES)
        record = remote.query(self.root, request["id"], request["command_hash"])
        self.assertLessEqual(len(record["message"]), 2048)
        path.write_text(json.dumps(dict(record, exit_code=1)))
        with self.assertRaisesRegex(ValueError, "success proof"):
            remote.query(self.root, request["id"], request["command_hash"])
        link = self.home / "link"
        link.symlink_to(self.root)
        with self.assertRaises(ValueError):
            remote.query(link, request["id"], request["command_hash"])


if __name__ == "__main__":
    unittest.main()
