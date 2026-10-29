import ast
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('monitor_motion', Path(__file__).with_name('monitor_motion.py'))
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


def stamp(t):
    return {'sec': int(t), 'nanosec': round((t-int(t))*1e9)}


def event(kind, t, data, gid='p1'):
    return {'kind': kind, 't': t, 'data': data, 'publisher_gid': gid}


def status(t, state, goal=1, born=101):
    return event('move_status', t, {'status_list': [{'goal_info': {'goal_id': {'uuid': [goal]*16}, 'stamp': stamp(born)}, 'status': state}]})


def controller(t, error=.02):
    return event('controller', t, {'joint_names': list(reversed(m.JOINTS)), 'desired': {'positions': [1.]*6, 'velocities': [.1]*6}, 'actual': {'positions': [1.-error]*6, 'velocities': [.08]*6}})


def command(t, seq, gid='p1', v=0.):
    return event('command', t, {'header': {'stamp': stamp(t+200)}, 'sequence': seq, 'position': [1.]*7, 'velocity': [v]*7, 'kp': [40.]*7, 'kd': [3.]*7}, gid)


class MotionTests(unittest.TestCase):
    def test_trajectory_fields_and_interior_stops(self):
        tr = {'joint_names': m.JOINTS, 'points': [{'positions': [t]*6, 'velocities': [v]*6, 'accelerations': [a]*6, 'time_from_start': stamp(t)} for t,v,a in [(0,0,.1),(.1,.01,.1),(.2,0,0)]]}
        r = m.trajectory_metrics(tr)
        self.assertTrue(r['valid'])
        self.assertEqual(r['interior_stopped_points'], 0)
        self.assertAlmostEqual(r['max_knot_acceleration_slope_rad_s3'], 1.)
        tr['points'][1]['velocities'] = [0.]*6
        self.assertEqual(m.trajectory_metrics(tr)['interior_stopped_points'], 1)
        tr['points'][1]['time_from_start'] = stamp(0)
        self.assertFalse(m.trajectory_metrics(tr)['valid'])

    def test_invalid_trajectory_and_positions_only(self):
        self.assertFalse(m.trajectory_metrics({})['valid'])
        tr = {'joint_names': ['j'], 'points': [{'positions': [0.], 'time_from_start': stamp(0)}]}
        self.assertFalse(m.trajectory_metrics(tr)['full_velocity'])
        tr['points'][0]['positions'] = [float('nan')]
        self.assertFalse(m.trajectory_metrics(tr)['valid'])

    def test_per_publisher_sequence_wrap_and_cadence(self):
        s = m.Stats()
        for e in [command(0, 0xfffffffe), command(.005, 100, 'p2'), command(.01, 0xffffffff), command(.015, 101, 'p2'), command(.02, 1), command(.03, 4)]:
            s.add(e)
        r = s.report()
        # Firmware intentionally skips sequence 0. Detect that separately from real gap.
        self.assertEqual(r['sequence_missing_observed'], 2)
        self.assertEqual(r['sequence_non_forward'], 0)
        self.assertEqual(r['receive_cadence']['command:p2']['count'], 2)
        self.assertAlmostEqual(r['receive_cadence']['command:p2']['median_ms'], 10)

    def test_reordered_controller_joints_and_bad_vectors(self):
        s = m.Stats()
        e = controller(0)
        e['data']['actual']['positions'][0] = .5  # joint6, not joint1
        s.add(e)
        self.assertAlmostEqual(s.report()['tracking']['joint6']['max_abs_error_rad'], .5)
        e['data']['actual']['positions'] = []
        s.add(e)
        self.assertEqual(s.report()['invalid_vectors'], 1)
        self.assertEqual(s.report()['tracking']['joint6']['samples'], 1)

    def test_motions_exclude_idle_and_preexisting_goals(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            (p/'metadata.json').write_text(json.dumps({'start_ros_ns': 100000000000, 'finalized': True}))
            events = [status(0,4,2,90), controller(.1, 1.), status(1,2), controller(1.1,.02), command(1.1,1), status(2,4), controller(3,2.)]
            (p/'events.jsonl').write_text(''.join(json.dumps(e)+'\n' for e in events))
            report = m.analyze(p)
            self.assertEqual(len(report['motions']), 1)
            self.assertAlmostEqual(report['motions'][0]['metrics']['tracking']['joint1']['max_abs_error_rad'], .02)
            self.assertEqual(report['overall']['tracking']['joint1']['max_abs_error_rad'], 2.)
            self.assertTrue(any('目标速度全部为零' in f for f in report['findings']))
            self.assertTrue((p/'summary.md').exists())
            self.assertEqual(m.analyze(p), report)  # repeatable offline analysis

    def test_no_motion_or_missing_command_does_not_claim_zero_feedforward(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            (p/'events.jsonl').write_text(json.dumps(controller(1))+'\n'+ '{partial')
            r = m.analyze(p)
            self.assertEqual(r['invalid_lines'], 1)
            self.assertEqual(r['motions'], [])
            self.assertFalse(any('目标速度全部为零' in f for f in r['findings']))
            self.assertTrue(any('采集不完整' in f for f in r['findings']))

    def test_writer_caps_and_drains(self):
        with tempfile.TemporaryDirectory() as tmp:
            w = m.Writer(Path(tmp)/'events.jsonl', 200)
            w.put(event('x', 0, {'value': 'x'*400}))
            w.close()
            self.assertEqual(w.reason, 'size_limit')
            self.assertEqual(w.dropped, 1)
            self.assertEqual((Path(tmp)/'events.jsonl').stat().st_size, 0)
            w = m.Writer(Path(tmp)/'ok.jsonl', 10000)
            for i in range(10):
                w.put(event('x', i, {}))
            w.close()
            self.assertEqual(len(list(m.records(Path(tmp)/'ok.jsonl'))), 10)

    def test_unattributed_messages_do_not_mix_sequences(self):
        s = m.Stats()
        for e in [command(0, 100, 'unavailable'), command(.01, 1, 'unavailable')]:
            s.add(e)
        self.assertIsNone(s.report()['sequence_missing_observed'])
        self.assertIsNone(s.report()['sequence_non_forward'])
        self.assertEqual(s.report()['sequence_unattributed_samples'], 2)

    def test_nonfinite_telemetry_preserved_as_null_and_io_error_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)/'events.jsonl'
            w = m.Writer(p, 1000)
            w.put(event('joint', 0, {'position': [float('nan'), float('inf')]}))
            w.close()
            self.assertEqual(json.loads(p.read_text())['data']['position'], [None, None])
            w = m.Writer(Path(tmp)/'missing'/'out.jsonl', 1000)
            w.close()
            self.assertEqual(w.reason, 'writer_error')
            self.assertTrue(w.error)

    def test_cli_rejects_unbounded_capture_before_importing_ros(self):
        for option in ['nan', '0', '3601']:
            with self.subTest(option=option), patch('sys.argv', ['monitor_motion.py', 'record', '--duration', option]), patch('sys.stderr'):
                with self.assertRaises(SystemExit) as failure:
                    m.main()
                self.assertEqual(failure.exception.code, 2)

    def test_capture_has_no_control_mutations(self):
        tree = ast.parse(Path(m.__file__).read_text())
        calls = {n.func.attr for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)}
        self.assertTrue(calls.isdisjoint({'create_publisher', 'send_goal_async', 'async_send_goal', 'cancel_goal_async', 'set_parameters', 'set_parameters_atomically'}))


if __name__ == '__main__':
    unittest.main()
