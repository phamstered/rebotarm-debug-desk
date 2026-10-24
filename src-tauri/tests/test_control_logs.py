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


if __name__ == '__main__': unittest.main()
