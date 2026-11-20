import json
import importlib.util
from pathlib import Path
import unittest
from types import SimpleNamespace as Obj
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('manager_remote', Path(__file__).parents[1] / 'src/manager_remote.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


def row(name, state='inactive', interfaces=('joint1/position',)):
    return dict(name=name, typeName='example/Controller', state=state, requiredInterfaces=list(interfaces), claimedInterfaces=list(interfaces) if state=='active' else [], interfacesKnown=True)


class ManagerTests(unittest.TestCase):
    def test_unicode_failure_receipt_stays_within_journal_limit(self):
        receipt=m.operation_receipt('load',['配置失败'*500],{'fingerprint':'a'*64})
        self.assertFalse(receipt['ok'])
        self.assertLessEqual(len(json.dumps(receipt,ensure_ascii=True)),900)
        self.assertTrue(receipt['message'])

    def test_internal_conflicts_and_unconfirmed_preemption_are_rejected(self):
        rows = [row('a'), row('b'), row('old', 'active')]
        with self.assertRaisesRegex(ValueError, 'conflicts'):
            m.switch_plan(rows, ['a', 'b'], ['old'])
        with self.assertRaisesRegex(ValueError, 'Explicitly confirm'):
            m.switch_plan(rows, ['a'], [])
        m.switch_plan(rows, ['a'], ['old'])

    def test_state_only_broadcaster_and_independent_effort_can_coexist(self):
        rows=[row('position'),row('effort',interfaces=('joint1/effort',)),row('state',interfaces=())]
        m.switch_plan(rows,['position','effort','state'],[])

    def test_unknown_metadata_and_unconfigured_are_not_activatable(self):
        for state,known in [('unloaded',True),('unconfigured',True),('inactive',False)]:
            r=row('a',state); r['interfacesKnown']=known
            with self.assertRaises(ValueError):m.switch_plan([r],['a'],[])
        with self.assertRaises(ValueError):m.switch_plan([row('a')],['a'],['a'])

    def test_fingerprint_ignores_ui_and_rate_but_detects_ownership_and_state_changes(self):
        s=dict(available=True,controllers=[row('a')],hardware=[dict(name='hw',state='inactive')])
        original=m.fingerprint(s)
        self.assertEqual(original,m.fingerprint(dict(s,owned=True,updateRate=100)))
        s['hardware'][0]['state']='active';self.assertNotEqual(original,m.fingerprint(s))
        s['hardware'][0]['state']='inactive';s['controllers'][0]['requiredInterfaces']=['joint2/position'];self.assertNotEqual(original,m.fingerprint(s))

    def test_start_preserves_existing_manager_without_spawning(self):
        with patch.object(m.subprocess,'Popen') as spawn:
            m.start_manager(Obj(snapshot=lambda:dict(available=True)))
            spawn.assert_not_called()

    def test_stop_requires_exact_owned_process_and_no_active_controllers(self):
        s=dict(available=True,controllers=[row('a','active')],hardware=[])
        s['fingerprint']=m.fingerprint(s)
        with self.assertRaisesRegex(ValueError,'Deactivate'):
            m.stop_manager(Obj(snapshot=lambda:s),dict(expected=s['fingerprint']))


if __name__=='__main__':unittest.main()
