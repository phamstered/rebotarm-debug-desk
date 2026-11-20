"""Opt-in Humble service integration: isolated domain + mock hardware only.
Run: ROS_DOMAIN_ID=198 python3 test_manager_ros.py /path/to/manager_remote.py
"""
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
from unittest.mock import patch
import yaml


def main():
    if not 180 <= int(os.environ.get('ROS_DOMAIN_ID', '0')) <= 210:
        raise SystemExit('An explicit isolated ROS_DOMAIN_ID (180..210) is required')
    spec = importlib.util.spec_from_file_location('manager_remote', sys.argv[1])
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    ros = m.Ros()
    if ros.snapshot()['available'] or m.manager_processes():
        raise SystemExit('Isolated domain already has a Manager; refusing to use it')
    with tempfile.TemporaryDirectory(prefix='manager-service-test-') as folder:
        root = Path(folder); m.cache = lambda: root / 'cache'
        urdf = '''<robot name="isolated_test"><link name="base"/><link name="tip"/><joint name="joint1" type="revolute"><parent link="base"/><child link="tip"/><limit lower="-1" upper="1" effort="1" velocity="1"/></joint><ros2_control name="IsolatedMock" type="system"><hardware><plugin>mock_components/GenericSystem</plugin></hardware><joint name="joint1"><command_interface name="position"/><state_interface name="position"/></joint></ros2_control></robot>'''
        params = {'controller_manager': {'ros__parameters': {
            'update_rate': 100, 'state': {'type': 'joint_state_broadcaster/JointStateBroadcaster'},
            'a': {'type': 'position_controllers/JointGroupPositionController'},
            'b': {'type': 'position_controllers/JointGroupPositionController'},
            'broken': {'type': 'missing/Plugin'}}},
            'a': {'ros__parameters': {'joints': ['joint1']}}, 'b': {'ros__parameters': {'joints': ['joint1']}}}
        (root / 'config').mkdir(); (root / 'urdf').mkdir()
        (root / 'config/arm_controllers.yaml').write_text(yaml.safe_dump(params))
        (root / 'urdf/rebotarm.arm.micro_ros.xacro').write_text(urdf)
        pid = None
        with patch('ament_index_python.packages.get_package_share_directory', return_value=str(root)):
            try:
                m.start_manager(ros)
                owned = m.owned_process(); assert owned
                pid = owned['pid']
                before = ros.snapshot()
                assert before['available'] and before['owned'], before
                assert {r['name'] for r in before['controllers']} == {'state', 'a', 'b', 'broken'}
                assert before['hardware'][0]['state'] == 'inactive', before
                errors = ros.load(); assert errors and 'broken' in errors[0], errors
                loaded = ros.snapshot(); states = {r['name']: r['state'] for r in loaded['controllers']}
                assert states == dict(a='inactive', b='inactive', state='inactive', broken='unloaded'), states
                assert loaded['hardware'][0]['state'] == 'inactive', loaded
                assert next(r for r in loaded['controllers'] if r['name'] == 'broken')['loadError']
                # Only mock hardware exists in this dedicated domain. Firmware
                # proof is deliberately stubbed here, never in the shipped helper.
                ros.fresh_hardware = lambda topic, **kw: None
                ros.fresh_mit = lambda topic, **kw: None
                request = dict(activate=['a'], deactivate=[], expected=loaded['fingerprint'], statusTopic='/test/status', commandTopic='/test/command')
                ros.switch(request)
                running = ros.snapshot()
                assert next(r for r in running['controllers'] if r['name'] == 'a')['state'] == 'active'
                try:
                    ros.switch(dict(request, activate=['b'], expected=running['fingerprint']))
                except ValueError as error:
                    assert 'Explicitly confirm' in str(error)
                else:
                    raise AssertionError('Silent preemption')
                try:
                    m.stop_manager(ros, dict(request, expected=running['fingerprint']))
                except ValueError as error:
                    assert 'Deactivate' in str(error)
                else:
                    raise AssertionError('Stopped a Manager with active Controllers')
                ros.switch(dict(request, activate=['b'], deactivate=['a'], expected=running['fingerprint']))
                ros.load()
                assert next(r for r in ros.snapshot()['controllers'] if r['name'] == 'b')['state'] == 'active'
                ros.switch(dict(request, activate=[], deactivate=['b'], expected=ros.snapshot()['fingerprint']))
                m.stop_manager(ros, dict(request, expected=ros.snapshot()['fingerprint']))
                assert not ros.snapshot()['available'] and not m.owned_process()
                print(json.dumps(dict(result='passed', defaultStates=states, hardwareOnLoad='inactive', conflict='explicit', existingActive='preserved', ownedStop='verified')))
            finally:
                # Only this fixture's exact child; no domain-wide process killing.
                if pid is None and m.owned_process():
                    pid = m.owned_process()['pid']
                if pid is not None:
                    try:
                        if m.owned_process() and m.owned_process()['pid'] == pid:
                            os.kill(pid, signal.SIGTERM)
                        os.waitpid(pid, 0)
                    except (ProcessLookupError, ChildProcessError):
                        pass


if __name__ == '__main__':
    main()
