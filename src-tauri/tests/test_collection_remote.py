"""No ROS or hardware required; exercised from cargo test."""
import importlib.util
import json
from pathlib import Path
import signal
import tempfile
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("collection_remote", Path(__file__).parents[1] / "src/collection_remote.py")
remote = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(remote)


def sample(recording=False, frames=0, saved=2):
    return json.dumps(dict(recording=recording, pending_frames=frames, saved_episodes=saved, fps=20, task="拾取红块"))


class RecorderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.services = Mock()
        self.services.call.return_value = sample()
        self.control = remote.RecorderControl(self.services, Path(self.temp.name) / "cache")
        self.config = dict(repoId="robot/demo", root=str(Path(self.temp.name) / "dataset"), task="pick 'cube' $(echo NO)",
                           fps=20, wristImageTopic="/camera/image", baseImageTopic="", stateTopic="/joint_states",
                           armCommandTopic="/arm/commands", gripperCommandTopic="/gripper/commands",
                           pythonPath=str(Path(self.temp.name) / "python"), resume=False)
        Path(self.config["pythonPath"]).touch()

    def owned(self, finalizing=False):
        self.control.manifest.write_text(json.dumps(dict(pid=123, identity="old-start", config=self.config, finalizing=finalizing)))

    def test_external_recorder_has_no_process_ownership(self):
        result = self.control.status()
        self.assertEqual(result["state"], "idle")
        self.assertFalse(result["managed"])
        self.assertEqual(result["savedEpisodes"], 2)
        with patch.object(remote.os, "kill") as kill:
            with self.assertRaisesRegex(RuntimeError, "仅能结束"):
                self.control.finish()
            kill.assert_not_called()

    def test_recorder_metadata_is_separate_for_each_ros_domain(self):
        with patch.dict(remote.os.environ, {"ROS_DOMAIN_ID": "197"}):
            isolated = remote.default_cache()
        with patch.dict(remote.os.environ, {"ROS_DOMAIN_ID": "0"}):
            normal = remote.default_cache()
        self.assertNotEqual(isolated, normal)
        self.assertEqual(isolated.name, "domain-197")

    def test_recorder_environment_preserves_ros_paths_and_adds_existing_cudss(self):
        prefix = Path(self.temp.name) / "venv"
        library = prefix / "lib/python3.10/site-packages/nvidia/cu12/lib"
        library.mkdir(parents=True)
        (prefix / "pyvenv.cfg").touch()
        with patch.dict(remote.os.environ, {"LD_LIBRARY_PATH": "/opt/ros/lib", "PATH": "/usr/bin"}):
            environment = remote.recorder_environment(prefix / "bin/python")
        self.assertEqual(environment["LD_LIBRARY_PATH"], str(library) + ":/opt/ros/lib")
        self.assertEqual(environment["VIRTUAL_ENV"], str(prefix))
        self.assertEqual(environment["PATH"], str(prefix / "bin") + ":/usr/bin")
        self.assertEqual(environment["PYTHONUNBUFFERED"], "1")

    def test_missing_service_and_stale_pid_are_stopped(self):
        self.owned()
        self.services.call.return_value = None
        with patch.object(remote, "process_identity", return_value="reused-pid"):
            result = self.control.status()
            self.assertEqual(result["state"], "stopped")
            self.assertFalse(result["managed"])
            with patch.object(remote.os, "kill") as kill:
                with self.assertRaisesRegex(RuntimeError, "进程身份"):
                    self.control.finish()
                kill.assert_not_called()

    def test_pending_or_recording_episode_blocks_finish(self):
        self.owned()
        with patch.object(remote, "process_identity", return_value="old-start"), patch.object(remote.os, "kill") as kill:
            for recording, frames in [(True, 0), (True, 20), (False, 20)]:
                self.services.call.return_value = sample(recording, frames)
                with self.assertRaisesRegex(RuntimeError, "保存或丢弃"):
                    self.control.finish()
            kill.assert_not_called()

    def test_finish_signals_only_owned_recorder_and_confirms_finalization(self):
        self.owned()
        self.control.log_path.write_text("Dataset finalized\n")
        with patch.object(remote, "process_identity", side_effect=["old-start", "old-start", None]), patch.object(remote.os, "kill") as kill:
            result = self.control.finish()
        kill.assert_called_once_with(123, signal.SIGINT)
        self.assertEqual(result["state"], "stopped")
        self.assertEqual(result["savedEpisodes"], 2)
        self.services.call.return_value = None
        self.assertEqual(self.control.status()["savedEpisodes"], 2)

    def test_finish_does_not_claim_success_without_finalize_marker(self):
        self.owned()
        with patch.object(remote, "process_identity", side_effect=["old-start", "old-start", None]), patch.object(remote.os, "kill"):
            with self.assertRaisesRegex(RuntimeError, "未确认 finalize"):
                self.control.finish()

    def test_finalizing_process_is_not_interrupted_again(self):
        self.owned(finalizing=True)
        with patch.object(remote, "process_identity", return_value="old-start"), patch.object(remote.os, "kill") as kill:
            self.assertEqual(self.control.status()["state"], "finalizing")
            self.services.call.assert_not_called()
            with self.assertRaisesRegex(RuntimeError, "空闲"):
                self.control.finish()
            kill.assert_not_called()

    def test_episode_services_propagate_failure_and_refresh_counts(self):
        self.services.call.side_effect = [sample(True, 10), "saved episode", sample(False, 0, 3)]
        result = self.control.execute("save_episode")
        self.assertEqual(result["savedEpisodes"], 3)
        self.assertEqual(result["message"], "saved episode")
        self.assertEqual(self.services.call.call_args_list[1].args[0], "save_episode")
        self.services.call.side_effect = [sample(), RuntimeError("disk full")]
        with self.assertRaisesRegex(RuntimeError, "disk full"):
            self.control.execute("save_episode")
        with self.assertRaisesRegex(RuntimeError, "不支持"):
            self.control.execute("delete_dataset")

    def test_launch_preserves_task_as_argument_and_waits_for_ready(self):
        self.services.call.side_effect = [None, sample()]
        child = Mock(pid=123)
        with patch.object(remote.subprocess, "run", return_value=Mock(returncode=0)), patch.object(remote.subprocess, "Popen", return_value=child) as launch, patch.object(remote, "process_identity", return_value="start"):
            result = self.control.launch(self.config)
        args = launch.call_args.args[0]
        self.assertIn("--task=" + self.config["task"], args)
        self.assertIn("--no-keyboard", args)
        self.assertEqual(args[1:3], ["-m", "rebotarm_vla.lerobot_recorder"])
        self.assertEqual(result["state"], "idle")
        self.assertTrue(launch.call_args.kwargs["start_new_session"])
        self.assertNotIn("shell", launch.call_args.kwargs)

    def test_launch_refuses_duplicate_existing_root_and_missing_resume_metadata(self):
        with patch.object(remote.subprocess, "Popen") as launch:
            with self.assertRaisesRegex(RuntimeError, "已有采集器"):
                self.control.launch(self.config)
            self.services.call.return_value = None
            Path(self.config["root"]).mkdir()
            with self.assertRaisesRegex(RuntimeError, "保存目录已存在"):
                self.control.launch(self.config)
            self.config["resume"] = True
            with self.assertRaisesRegex(RuntimeError, "meta/info.json"):
                self.control.launch(self.config)
            launch.assert_not_called()

    def test_launch_reports_missing_dependencies_before_spawning(self):
        self.services.call.return_value = None
        with patch.object(remote.subprocess, "run", return_value=Mock(returncode=1, stderr="no lerobot")), patch.object(remote.subprocess, "Popen") as launch:
            with self.assertRaisesRegex(RuntimeError, "no lerobot"):
                self.control.launch(self.config)
            launch.assert_not_called()

    def test_resume_rejects_schema_or_fps_mismatch_before_spawning(self):
        self.services.call.return_value = None
        self.config["resume"] = True
        meta = Path(self.config["root"]) / "meta"
        meta.mkdir(parents=True)
        info = dict(fps=20, features={"observation.state": {"shape": [7]}, "action": {"shape": [7]}, "observation.images.wrist": {"shape": [480, 640, 3]}})
        with patch.object(remote.subprocess, "Popen") as launch:
            for bad in [dict(info, fps=30), dict(info, features={}), dict(info, features=dict(info["features"], action={"shape": [6]}))]:
                (meta / "info.json").write_text(json.dumps(bad))
                with self.assertRaisesRegex(RuntimeError, "续录配置"):
                    self.control.launch(self.config)
            launch.assert_not_called()

    def test_finalization_timeout_never_escalates_to_force_kill(self):
        self.owned()
        with patch.object(remote, "process_identity", return_value="old-start"), patch.object(remote.os, "kill") as kill, patch.object(remote.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "未强制终止"):
                self.control.finish()
            kill.assert_called_once_with(123, signal.SIGINT)

    def test_process_identity_checks_module_and_linux_start_time(self):
        fields = ["S"] + ["0"] * 18 + ["start-123"] + ["0"] * 5
        with patch.object(Path, "read_text", return_value="123 (python worker) " + " ".join(fields)), patch.object(Path, "read_bytes", return_value=b"python\0-m\0rebotarm_vla.lerobot_recorder\0"):
            self.assertEqual(remote.process_identity(123), "start-123")
        with patch.object(Path, "read_text", return_value="123 (python) " + " ".join(fields)), patch.object(Path, "read_bytes", return_value=b"python\0other_module\0"):
            self.assertIsNone(remote.process_identity(123))


if __name__ == "__main__":
    unittest.main()
