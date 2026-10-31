import importlib.util
from pathlib import Path
import os
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('control_logs', Path(__file__).parents[1] / 'src/control_logs.py')
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


class LogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.cache = self.home / '.cache/robot-console'
        self.cache.mkdir(parents=True)

    def read(self, source='teleop', download=False):
        return reader.read_log(source, download, self.home)

    def test_missing_and_append(self):
        self.assertFalse(self.read()['exists'])
        p = self.cache / 'arm-teleop.log'
        p.write_text('first\n')
        a = self.read()
        p.write_text('first\nsecond\n')
        b = self.read()
        self.assertEqual(b['content'], 'first\nsecond\n')
        self.assertNotEqual(a['revision'], b['revision'])
        p.write_text('rotated\n')
        self.assertEqual(self.read()['content'], 'rotated\n')

    def test_tail_bounds_and_full_download(self):
        content = ('previous line\n' * 15000) + 'last line\n'
        (self.cache / 'arm-teleop.log').write_text(content)
        tail = self.read()
        self.assertTrue(tail['truncated'])
        self.assertLessEqual(len(tail['content'].encode()), 128 * 1024)
        self.assertTrue(tail['content'].endswith('last line\n'))
        self.assertLessEqual(len(tail['content'].splitlines()), 2000)
        self.assertEqual(self.read(download=True)['content'], content)
        with (self.cache / 'arm-teleop.log').open('wb') as stream:
            stream.truncate(32 * 1024 * 1024 + 1)
        with self.assertRaisesRegex(ValueError, '32 MiB'):
            self.read(download=True)

    def test_many_short_lines_are_bounded_without_affecting_download(self):
        content = 'x\n' * 3000
        (self.cache / 'arm-teleop.log').write_text(content)
        self.assertEqual(len(self.read()['content'].splitlines()), 2000)
        self.assertTrue(self.read()['truncated'])
        self.assertEqual(self.read(download=True)['content'], content)

    def test_latest_controller_log_and_rotation(self):
        root = self.home / '.ros/log'
        root.mkdir(parents=True)
        self.assertFalse(self.read('controller')['exists'])
        old = root / 'ros2_control_node_1.log'
        new = root / 'ros2_control_node_2.log'
        old.write_text('old'); new.write_text('new')
        os.utime(old, ns=(1, 1)); os.utime(new, ns=(2, 2))
        self.assertEqual(self.read('controller')['content'], 'new')
        os.utime(old, ns=(3, 3))
        self.assertEqual(self.read('controller')['content'], 'old')

    def test_sources_paths_and_non_regular_files(self):
        for source in ['unknown', '../secret', 'teleop;id']:
            with self.assertRaises(ValueError): self.read(source)
        outside = self.home / 'secret'
        outside.write_text('secret')
        path = self.cache / 'arm-teleop.log'
        path.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, '越过'): self.read()
        path.unlink(); os.mkfifo(path)
        with self.assertRaisesRegex(ValueError, '普通文件'): self.read()
        path.unlink(); path.write_bytes(b'line\xff\n')
        self.assertIn('\ufffd', self.read()['content'])
        for source in ['trajectory', 'realsense']:
            (self.cache / ('arm-' + source + '.log')).write_text(source)
            self.assertEqual(self.read(source)['content'], source)

    def test_app_session_clears_all_sources_without_truncating_remote_logs(self):
        for source in ('teleop', 'trajectory', 'realsense'):
            (self.cache / f'arm-{source}.log').write_text('historical\n')
        root = self.home / '.ros/log'; root.mkdir(parents=True)
        controller = root / 'ros2_control_node_1.log'; controller.write_text('old controller\n')
        baseline = reader.capture_baseline(self.home)
        for source in ('teleop', 'trajectory', 'realsense', 'controller'):
            self.assertEqual(reader.read_log(source, home=self.home, baseline=baseline)['content'], '')
        path = self.cache / 'arm-trajectory.log'
        with path.open('a') as stream: stream.write('new output\n')
        for download in (False, True):
            result = reader.read_log('trajectory', download, self.home, baseline)
            self.assertEqual(result['content'], 'new output\n')
            self.assertFalse(result['truncated'])
        self.assertEqual(path.read_text(), 'historical\nnew output\n')
        self.assertEqual(reader.read_log('vla', home=self.home, baseline=baseline)['content'], 'new output\n')
        restarted = reader.capture_baseline(self.home)
        self.assertEqual(reader.read_log('trajectory', home=self.home, baseline=restarted)['content'], '')

    def test_new_files_replacement_and_in_place_truncation_show_new_output(self):
        path = self.cache / 'arm-trajectory.log'; path.write_text('previous\n')
        baseline = reader.capture_baseline(self.home)
        path.write_text('new run with longer output\n')
        self.assertEqual(reader.read_log('trajectory', home=self.home, baseline=baseline)['content'], path.read_text())
        path.unlink(); path.write_text('replacement\n')
        self.assertEqual(reader.read_log('trajectory', home=self.home, baseline=baseline)['content'], 'replacement\n')
        root = self.home / '.ros/log'; root.mkdir(parents=True)
        new = root / 'ros2_control_node_123.log'; new.write_text('fresh controller\n')
        self.assertEqual(reader.read_log('controller', home=self.home, baseline=baseline)['content'], 'fresh controller\n')

    def test_archived_restart_with_identical_bytes_is_not_hidden_by_old_cursor(self):
        path = self.cache / 'arm-trajectory.log'
        path.write_text('identical startup footer\n')
        baseline = reader.capture_baseline(self.home)
        path.rename(self.cache / 'previous.log')
        path.write_text('identical startup footer\n')
        result = reader.read_log('trajectory', home=self.home, baseline=baseline)
        self.assertEqual(result['content'], 'identical startup footer\n')

    def test_session_baseline_rejects_symlink_escape_and_fifo(self):
        outside = self.home / 'secret'; outside.write_text('secret')
        path = self.cache / 'arm-teleop.log'; path.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, '越过'): reader.capture_baseline(self.home)
        path.unlink(); os.mkfifo(path)
        with self.assertRaisesRegex(ValueError, '普通文件'): reader.capture_baseline(self.home)


if __name__ == '__main__': unittest.main()
