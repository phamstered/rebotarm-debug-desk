import importlib.util
import json
import os
from pathlib import Path
import signal
import tempfile
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[1] / 'src/moveit_lifecycle.py'
spec = importlib.util.spec_from_file_location('moveit_lifecycle', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MoveitTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.manager = module.Manager(self.directory.name, '229')
        self.owner = dict(pid=123, start='1000', uid=os.getuid(), domain='229')
        self.probe = Mock()
        self.probe.count.return_value = 1
        self.probe.present.return_value = False
        self.probe.ready.return_value = True
        self.clock = 0
        self.patch(module.time, 'monotonic', side_effect=self.tick)
        self.patch(module.time, 'sleep')
        self.patch(module.os, 'getpgid', return_value=123)
        self.identity = self.patch(module, 'identity', return_value=self.owner)
        self.members = self.patch(module, 'group_members', return_value=[])
        self.spawn = self.patch(module.subprocess, 'Popen')
        self.spawn.return_value.pid = 123
        self.spawn.return_value.poll.return_value = None

    def patch(self, target, name, **options):
        patcher = patch.object(target, name, **options)
        result = patcher.start()
        self.addCleanup(patcher.stop)
        return result

    def tick(self):
        self.clock += 0.5
        return self.clock

    def save(self, **overrides):
        self.manager.file.write_text(json.dumps(dict(self.owner, **overrides)))

    def test_external_ready_planner_is_reused_without_claiming_ownership(self):
        pid, _ = self.manager.start(self.probe)
        self.assertEqual(pid, 0)
        self.spawn.assert_not_called()
        self.assertFalse(self.manager.file.exists())

    def test_owned_ready_planner_is_reused(self):
        self.save()
        self.assertEqual(self.manager.start(self.probe)[0], 123)
        self.spawn.assert_not_called()

    def test_existing_unready_node_is_not_duplicated(self):
        self.probe.ready.return_value = False
        self.probe.count.return_value = 0
        self.probe.present.return_value = True
        with self.assertRaisesRegex(ValueError, '超时'):
            self.manager.start(self.probe)
        self.spawn.assert_not_called()

    def test_internal_moveit_node_duplicates_are_not_duplicate_action_servers(self):
        probe = module.RosProbe.__new__(module.RosProbe)
        probe.node = Mock()
        probe.node.get_node_names_and_namespaces.return_value = [('move_group', '/')] * 3
        probe.node.get_publishers_info_by_topic.return_value = [
            Mock(endpoint_gid=[1, 2], topic_type='action_msgs/msg/GoalStatusArray'),
            Mock(endpoint_gid=[1, 2], topic_type='action_msgs/msg/GoalStatusArray'),
        ]
        self.assertTrue(probe.present())
        self.assertEqual(probe.count(), 1)
        probe.node.get_publishers_info_by_topic.return_value.append(
            Mock(endpoint_gid=[1, 3], topic_type='action_msgs/msg/GoalStatusArray'))
        self.assertEqual(probe.count(), 2)

    def test_duplicate_nodes_fail_closed(self):
        self.probe.count.return_value = 2
        with self.assertRaisesRegex(ValueError, '多个'):
            self.manager.start(self.probe)
        self.spawn.assert_not_called()

    def test_new_launch_records_identity_and_rotates_old_log(self):
        log = Path(self.directory.name) / 'arm-moveit.log'
        log.write_text('previous session')
        self.probe.count.side_effect = [0, 1]
        self.assertEqual(self.manager.start(self.probe)[0], 123)
        self.assertEqual(self.spawn.call_args.args[0], module.LAUNCH)
        self.assertTrue(self.spawn.call_args.kwargs['start_new_session'])
        self.assertEqual(json.loads(self.manager.file.read_text()), self.owner)
        self.assertEqual(next(log.parent.glob('history/*')).read_text(), 'previous session')

    def test_early_exit_retains_diagnostics_and_owner(self):
        self.probe.count.return_value = 0
        self.spawn.return_value.poll.return_value = 1
        with self.assertRaisesRegex(ValueError, '提前退出'):
            self.manager.start(self.probe)
        self.assertTrue(self.manager.file.exists())

    def test_new_launch_timeout_retains_owner_for_explicit_cleanup(self):
        self.probe.count.return_value = 0
        with self.assertRaisesRegex(ValueError, '超时'):
            self.manager.start(self.probe)
        self.assertTrue(self.manager.file.exists())

    def test_reused_pid_or_foreign_domain_is_never_signalled(self):
        for change in ({'start': '2000'}, {'domain': '0'}):
            self.save(**change)
            with patch.object(module.os, 'kill') as kill:
                with self.assertRaises(ValueError):
                    self.manager.stop()
                kill.assert_not_called()
            self.assertTrue(self.manager.file.exists())

    def test_missing_owner_with_live_descendants_blocks_cleanup(self):
        self.save()
        self.identity.return_value = None
        self.members.return_value = [456]
        with self.assertRaisesRegex(ValueError, '子进程仍在'):
            self.manager.stop()
        self.assertTrue(self.manager.file.exists())

    def test_finished_owner_can_be_forgotten(self):
        self.save()
        self.identity.return_value = None
        self.manager.stop()
        self.assertFalse(self.manager.file.exists())

    def test_stop_signals_owned_group_and_waits_without_force(self):
        for ignored, expected in [('0000', signal.SIGINT), ('0002', signal.SIGTERM)]:
            self.save()
            self.members.side_effect = [[123], []]
            original = Path.read_text
            def read(path, *args, **kwargs):
                return 'SigIgn:\t' + ignored if str(path) == '/proc/123/status' else original(path, *args, **kwargs)
            with patch.object(Path, 'read_text', read), patch.object(module.os, 'kill') as kill:
                self.manager.stop()
                kill.assert_called_once_with(123, expected)
            self.assertFalse(self.manager.file.exists())

    def test_stop_timeout_preserves_file_without_escalation(self):
        self.save()
        self.members.return_value = [123]
        original = Path.read_text
        def read(path, *args, **kwargs):
            return 'SigIgn:\t0000' if str(path) == '/proc/123/status' else original(path, *args, **kwargs)
        with patch.object(Path, 'read_text', read), patch.object(module.os, 'kill') as kill:
            with self.assertRaisesRegex(ValueError, '未强杀'):
                self.manager.stop()
            kill.assert_called_once_with(123, signal.SIGINT)
        self.assertTrue(self.manager.file.exists())


if __name__ == '__main__':
    unittest.main()
