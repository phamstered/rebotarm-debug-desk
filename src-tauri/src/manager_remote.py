"""Fixed, journalled Controller Manager operations. No arbitrary executable input.

Snapshots enumerate the running manager's declared types, not installed plugins.
A new managed process starts its hardware inactive. Services are never replayed
on timeout; caller must reconcile the durable outer operation journal.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

MANAGER = '/controller_manager'
NAME = re.compile(r'^[A-Za-z0-9_/]+$')


def fingerprint(snapshot):
    fields = {k: snapshot[k] for k in ('available', 'controllers', 'hardware')}
    fields['processIdentity'] = snapshot.get('processIdentity', [])
    return hashlib.sha256(json.dumps(fields, sort_keys=True).encode()).hexdigest()


def switch_plan(rows, activate, deactivate):
    by_name = {r['name']: r for r in rows}
    if len(set(activate + deactivate)) != len(activate + deactivate):
        raise ValueError('Controller selection contains duplicates or overlap')
    if not activate and not deactivate:
        raise ValueError('No Controllers selected')
    for name in activate + deactivate:
        if name not in by_name or by_name[name]['state'] not in ('active', 'inactive'):
            raise ValueError(f'{name}: load and configure before switching')
    claims = {}
    for name in activate:
        row = by_name[name]
        if not row['interfacesKnown']:
            raise ValueError(f'{name}: required command interfaces unavailable; upgrade ROS control')
        for interface in row['requiredInterfaces']:
            if interface in claims:
                raise ValueError(f'{name} conflicts with {claims[interface]} on {interface}')
            claims[interface] = name
    conflicts = sorted(r['name'] for r in rows if r['state'] == 'active'
                       and r['name'] not in activate + deactivate
                       and set(r['claimedInterfaces']).intersection(claims))
    if conflicts:
        raise ValueError('Explicitly confirm stopping conflicting Controllers: ' + ', '.join(conflicts))


class Ros:
    def __init__(self):
        import rclpy
        from rclpy.node import Node
        self.rclpy = rclpy
        rclpy.init()
        self.node = Node('robot_console_manager_' + str(os.getpid()))

    def call(self, service, kind, request=None, timeout=5):
        client = self.node.create_client(kind, service)
        try:
            if not client.wait_for_service(timeout_sec=min(timeout, 2)):
                raise RuntimeError(service + ' unavailable')
            future = client.call_async(request or kind.Request())
            self.rclpy.spin_until_future_complete(self.node, future, timeout_sec=timeout)
            if not future.done():
                raise TimeoutError(service + ': result unknown; do not retry automatically')
            return future.result()
        finally:
            self.node.destroy_client(client)

    def params(self, node, names):
        from rcl_interfaces.srv import GetParameters
        return self.call(node + '/get_parameters', GetParameters, GetParameters.Request(names=names)).values

    def description_ready(self, expected, timeout=2):
        from std_msgs.msg import String
        from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
        messages = []
        qos = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                         durability=DurabilityPolicy.TRANSIENT_LOCAL)
        sub = self.node.create_subscription(String, '/robot_description', lambda msg: messages.append(msg.data), qos)
        try:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                self.rclpy.spin_once(self.node, timeout_sec=.1)
                publishers = self.node.get_publishers_info_by_topic('/robot_description')
                if len(publishers) > 1:
                    raise ValueError('Multiple /robot_description publishers; resolve duplicates before starting Manager')
                if len(publishers) == 1 and messages:
                    if model_geometry(messages[-1]) != model_geometry(expected):
                        raise ValueError('/robot_description model differs from Manager URDF; existing publisher preserved')
                    return True
            if self.node.get_publishers_info_by_topic('/robot_description'):
                raise ValueError('/robot_description publisher exists but no compatible transient-local URDF was received')
            return False
        finally:
            self.node.destroy_subscription(sub)

    def snapshot(self):
        from controller_manager_msgs.srv import ListControllers, ListHardwareComponents
        from rcl_interfaces.srv import ListParameters
        try:
            actual = self.call(MANAGER + '/list_controllers', ListControllers).controller
        except RuntimeError:
            from ament_index_python.packages import get_package_share_directory
            import yaml
            config = Path(get_package_share_directory('microros_stm32h723_bridge')) / 'config/arm_controllers.yaml'
            parameters = yaml.safe_load(config.read_text())['controller_manager']['ros__parameters']
            catalog = [dict(name=name, typeName=value['type'], state='unloaded', claimedInterfaces=[], requiredInterfaces=[], interfacesKnown=False)
                       for name, value in parameters.items() if isinstance(value, dict) and isinstance(value.get('type'), str)]
            result = dict(available=False, controllers=sorted(catalog, key=lambda r:r['name']), hardware=[], updateRate=parameters.get('update_rate'), manager=MANAGER, owned=owned_process() is not None)
            result['processIdentity'] = manager_processes()
            result['fingerprint'] = fingerprint(result)
            return result
        names = self.call(MANAGER + '/list_parameters', ListParameters).result.names
        keys = sorted(n for n in names if n.endswith('.type') and NAME.fullmatch(n[:-5]))
        values = self.params(MANAGER, keys) if keys else []
        configured = {k[:-5]: v.string_value for k, v in zip(keys, values) if v.type == 4 and v.string_value}
        rows = {name: dict(name=name, typeName=kind, state='unloaded', claimedInterfaces=[], requiredInterfaces=[], interfacesKnown=False) for name, kind in configured.items()}
        for row in actual:
            rows[row.name] = dict(name=row.name, typeName=row.type, state=row.state,
                                 claimedInterfaces=list(row.claimed_interfaces),
                                 requiredInterfaces=list(getattr(row, 'required_command_interfaces', [])),
                                 interfacesKnown=hasattr(row, 'required_command_interfaces'))
        try:
            failures = json.loads((cache() / 'load-errors.json').read_text())
        except (OSError, ValueError):
            failures = {}
        for name, row in rows.items():
            if row['state'] in ('unloaded', 'unconfigured') and name in failures:
                row['loadError'] = str(failures[name])[:512]
        components = self.call(MANAGER + '/list_hardware_components', ListHardwareComponents).component
        hardware = [dict(name=c.name, state=c.state.label, plugin=c.class_type) for c in components]
        rate = self.params(MANAGER, ['update_rate'])[0]
        result = dict(available=True, controllers=sorted(rows.values(), key=lambda r: r['name']),
                      hardware=hardware, updateRate=rate.integer_value if rate.type == 2 else None,
                      manager=MANAGER, owned=owned_process() is not None)
        result['processIdentity'] = manager_processes()
        result['fingerprint'] = fingerprint(result)
        return result

    def load(self):
        from controller_manager_msgs.srv import LoadController, ConfigureController
        errors = []
        for row in self.snapshot()['controllers']:
            name = row['name']
            if row['state'] not in ('unloaded', 'unconfigured'):
                continue  # Existing active state is never reset.
            stage('startup', f'{name}: load + configure → inactive')
            try:
                if row['state'] == 'unloaded':
                    response = self.call(MANAGER + '/load_controller', LoadController, LoadController.Request(name=name))
                    if not response.ok:
                        errors.append(name + ': load failed'); continue
                response = self.call(MANAGER + '/configure_controller', ConfigureController, ConfigureController.Request(name=name))
                if not response.ok:
                    errors.append(name + ': configure failed')
            except TimeoutError:
                raise  # A service still in flight is not a known partial failure.
            except RuntimeError as error:
                errors.append(name + ': ' + str(error))
        root = cache(); root.mkdir(parents=True, exist_ok=True, mode=0o700)
        (root / 'load-errors.json').write_text(json.dumps({e.split(':', 1)[0]: e for e in errors}))
        return errors

    def fresh_hardware(self, topic, require_disabled=True):
        from microros_stm32h723_bridge.msg import HardwareStatus
        from rclpy.qos import qos_profile_sensor_data
        stamps = []
        def received(msg):
            stamp = msg.header.stamp.sec * 1000000000 + msg.header.stamp.nanosec
            if msg.fault_code != 0 or msg.mode not in (0, 1, 3) or (require_disabled and msg.mode != 3):
                stamps.clear(); return
            if not stamps or stamp > stamps[-1]:
                stamps.append(stamp)
        sub = self.node.create_subscription(HardwareStatus, topic, received, qos_profile_sensor_data)
        try:
            deadline = time.monotonic() + 4
            while time.monotonic() < deadline and len(stamps) < 3:
                self.rclpy.spin_once(self.node, timeout_sec=.1)
            if len(stamps) < 3:
                raise ValueError('Requires three fresh advancing fault-free HardwareStatus samples' + (' in DISABLE' if require_disabled else '; RETURN cannot be interrupted'))
        finally:
            self.node.destroy_subscription(sub)

    def fresh_mit(self, topic, disabled=False, require_v2=False):
        try:
            from microros_stm32h723_bridge.msg import MotorControlStatus
        except ImportError:
            if require_v2:
                raise ValueError("V2 status was observed but ROS message support is missing")
            return  # Only a session that has never observed V2 may use legacy proof.
        from rclpy.qos import qos_profile_sensor_data
        valid = []
        def received(msg):
            if (msg.protocol_version in (2, 3) and msg.boot_id and not msg.switching
                    and (disabled or (msg.verified_joint_mask == 127 and list(msg.control_modes) == [1] * 7))
                    and msg.owner_source_id == 0 and msg.lease_id == 0 and msg.fault_code == 0
                    and (not disabled or (msg.disabled_verified and msg.mode == 3 and msg.enabled_joint_mask == 0))):
                valid.append(True)
        sub = self.node.create_subscription(MotorControlStatus, topic, received, qos_profile_sensor_data)
        try:
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and not valid:
                self.rclpy.spin_once(self.node, timeout_sec=.1)
            if not valid:
                raise ValueError('Restore all seven axes to verified MIT and release V2 ownership before activation')
        finally:
            self.node.destroy_subscription(sub)

    def switch(self, request):
        from controller_manager_msgs.srv import SwitchController, SetHardwareComponentState
        from lifecycle_msgs.msg import State
        before = self.snapshot()
        if before['fingerprint'] != request.get('expected'):
            raise ValueError('Controller/hardware state changed; refresh and confirm again')
        activate, deactivate = request['activate'], request['deactivate']
        switch_plan(before['controllers'], activate, deactivate)
        # A teaching-configured hardware cannot be converted into stiff control
        # through a generic controller operation. Exit through the preset workflow.
        description = self.params(MANAGER, ['robot_description'])[0].string_value
        import xml.etree.ElementTree as ET
        root = ET.fromstring(description)
        if any(p.attrib.get('name') == 'drag_teaching' and (p.text or '').strip().lower() == 'true' for p in root.iter('param')):
            raise ValueError('Exit drag teaching through the supported preset workflow first')
        if activate:
            self.fresh_mit(request['commandTopic'].rsplit('/', 1)[0] + '/motor_control_status', require_v2=request.get('requireV2', False))
            inactive = [h for h in before['hardware'] if h['state'] == 'inactive']
            if inactive:
                self.fresh_hardware(request['statusTopic'])
            else:
                self.fresh_hardware(request['statusTopic'], require_disabled=False)
            command_activation = any(r['name'] in activate and r['requiredInterfaces'] for r in before['controllers'])
            for hardware in inactive if command_activation else []:
                response = self.call(MANAGER + '/set_hardware_component_state', SetHardwareComponentState,
                    SetHardwareComponentState.Request(name=hardware['name'], target_state=State(id=3, label='active')))
                if not response.ok:
                    raise ValueError(hardware['name'] + ': hardware activation rejected; inspect actual state')
        response = self.call(MANAGER + '/switch_controller', SwitchController,
            SwitchController.Request(activate_controllers=activate, deactivate_controllers=deactivate, strictness=2, activate_asap=False), timeout=12)
        after = self.snapshot()
        states = {r['name']: r['state'] for r in after['controllers']}
        if not response.ok or any(states.get(n) != 'active' for n in activate) or any(states.get(n) != 'inactive' for n in deactivate):
            raise ValueError('Switch did not reach all requested states; inspect actual state')


def cache():
    return Path.home() / '.cache/robot-console/manager' / os.environ.get('ROS_DOMAIN_ID', '0')


def identity(pid):
    root = Path('/proc') / str(pid)
    return dict(pid=pid, start=root.joinpath('stat').read_text().split(') ', 1)[1].split()[19],
                exe=os.readlink(root / 'exe'), domain=os.environ.get('ROS_DOMAIN_ID', '0'))


def processes_for(suffix):
    result = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            if not os.readlink(entry / 'exe').endswith(suffix):
                continue
            env = dict(item.split(b'=', 1) for item in (entry / 'environ').read_bytes().split(b'\0') if b'=' in item)
            if env.get(b'ROS_DOMAIN_ID', b'0').decode() == os.environ.get('ROS_DOMAIN_ID', '0'):
                result.append(identity(int(entry.name)))
        except (OSError, ValueError, IndexError):
            continue
    return sorted(result, key=lambda p:p['pid'])


def manager_processes():
    return processes_for('/controller_manager/ros2_control_node')


def owned_process(filename='process.json'):
    try:
        saved = json.loads((cache() / filename).read_text())
        return saved if identity(saved['pid']) == saved else None
    except (OSError, ValueError, KeyError, IndexError):
        return None


def stage(phase, message):
    print('ARM_STAGE|' + phase + '|' + message, flush=True)


def model_geometry(description):
    import xml.etree.ElementTree as ET
    root = ET.fromstring(description)
    if root.tag != 'robot' or not root.findall('link'):
        raise ValueError('Invalid robot_description model')
    # Controller-specific parameters do not change the rendered robot geometry.
    for child in root.findall('ros2_control'):
        root.remove(child)
    return ET.canonicalize(ET.tostring(root, encoding='unicode'), strip_text=True)


def ensure_state_publisher(ros, description):
    model_geometry(description)
    if ros.description_ready(description):
        stage('startup', '复用现有 /robot_description 发布者，URDF 已核验')
        return
    # The shared arm-mode lock serializes our starts. An existing but not yet
    # discovered/remapped process must never trigger a second local publisher.
    if processes_for('/robot_state_publisher/robot_state_publisher'):
        if ros.description_ready(description, timeout=5):
            return
        raise ValueError('robot_state_publisher process exists but /robot_description is unavailable; inspect its remapping/log')
    from ament_index_python.packages import get_package_prefix
    import yaml
    root = cache(); root.mkdir(parents=True, exist_ok=True, mode=0o700)
    params = root / 'state-publisher.yaml'
    params.write_text(yaml.safe_dump({'robot_state_publisher': {'ros__parameters': {
        'robot_description': description, 'use_sim_time': False}}}))
    executable = Path(get_package_prefix('robot_state_publisher')) / 'lib/robot_state_publisher/robot_state_publisher'
    stage('startup', '启动 robot_state_publisher，等待 /robot_description')
    with (root / 'state-publisher.log').open('ab', buffering=0) as log:
        child = subprocess.Popen([str(executable), '--ros-args', '--params-file', str(params)],
            stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    (root / 'state-publisher-process.json').write_text(json.dumps(identity(child.pid)))
    if not ros.description_ready(description, timeout=5):
        raise RuntimeError('robot_state_publisher did not publish URDF; see ' + str(root / 'state-publisher.log'))
    if child.poll() is not None:
        raise RuntimeError('robot_state_publisher exited during startup; inspect its log')


def stop_state_publisher():
    filename = 'state-publisher-process.json'
    saved = owned_process(filename)
    if not saved:
        return  # Reused external publishers are never stopped.
    fd = os.pidfd_open(saved['pid'])
    try:
        if owned_process(filename) != saved:
            raise ValueError('robot_state_publisher process identity changed')
        signal.pidfd_send_signal(fd, signal.SIGINT)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and owned_process(filename):
            time.sleep(.1)
        if owned_process(filename):
            raise RuntimeError('Owned robot_state_publisher stop unconfirmed')
    finally:
        os.close(fd)


def start_manager(ros):
    if ros.snapshot()['available']:
        ensure_state_publisher(ros, ros.params(MANAGER, ['robot_description'])[0].string_value)
        return  # Preserve the Manager and all hardware/controller states.
    if manager_processes():
        raise ValueError('A Manager process exists in this domain but service is unavailable; inspect its log before starting another')
    from ament_index_python.packages import get_package_share_directory, get_package_prefix
    import yaml
    import xml.etree.ElementTree as ET
    share = Path(get_package_share_directory('microros_stm32h723_bridge'))
    config = share / 'config/arm_controllers.yaml'
    description = subprocess.check_output(['xacro', str(share / 'urdf/rebotarm.arm.micro_ros.xacro'), 'enable_gripper:=true'], text=True, timeout=10)
    hardware = [c.attrib['name'] for c in ET.fromstring(description).findall('ros2_control')]
    if not hardware:
        raise ValueError('Robot description contains no ros2_control hardware')
    ensure_state_publisher(ros, description)
    params = yaml.safe_load(config.read_text())
    manager = params['controller_manager']['ros__parameters']
    manager['robot_description'] = description
    manager['hardware_components_initial_state'] = {'inactive': hardware}
    root = cache(); root.mkdir(parents=True, exist_ok=True, mode=0o700)
    (root / 'parameters.yaml').write_text(yaml.safe_dump(params))
    executable = Path(get_package_prefix('controller_manager')) / 'lib/controller_manager/ros2_control_node'
    with (root / 'manager.log').open('ab', buffering=0) as log:
        process = subprocess.Popen([str(executable), '--ros-args', '--params-file', str(root / 'parameters.yaml')], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    (root / 'process.json').write_text(json.dumps(identity(process.pid)))
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError('Manager exited; see ' + str(root / 'manager.log'))
        if ros.snapshot()['available']:
            return
        time.sleep(.2)
    raise TimeoutError('Manager startup result unknown; inspect process before retry')


def stop_manager(ros, request):
    snapshot = ros.snapshot()
    if snapshot['fingerprint'] != request.get('expected'):
        raise ValueError('Manager changed; refresh and confirm again')
    if any(r['state'] == 'active' for r in snapshot['controllers']):
        raise ValueError('Deactivate all Controllers before stopping Manager')
    saved = owned_process()
    if not saved:
        raise ValueError('Manager is externally owned; only its original launcher may stop it')
    ros.fresh_hardware(request['statusTopic'])
    ros.fresh_mit(request['commandTopic'].rsplit('/', 1)[0] + '/motor_control_status', disabled=True, require_v2=request.get('requireV2', False))
    fd = os.pidfd_open(saved['pid'])
    try:
        if owned_process() != saved:
            raise ValueError('Manager process identity changed')
        signal.pidfd_send_signal(fd, signal.SIGINT)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and owned_process():
            time.sleep(.1)
        if owned_process() or ros.snapshot()['available']:
            raise RuntimeError('Manager stop unconfirmed')
        stop_state_publisher()
    finally:
        os.close(fd)


def operation_receipt(action, errors, after):
    receipt = dict(action=action, ok=not errors, fingerprint=after['fingerprint'], message='; '.join(errors)[:400])
    while len(json.dumps(receipt, ensure_ascii=True)) > 900:
        receipt['message'] = receipt['message'][:-1]
    return receipt


def main():
    request = json.loads(sys.argv[1])
    action = request['action']
    if action not in ('snapshot', 'start', 'load', 'switch', 'stop'):
        raise ValueError('Unsupported manager operation')
    ros = Ros()
    if action == 'snapshot':
        print(json.dumps(ros.snapshot())); return
    import fcntl
    root = Path.home() / '.cache/robot-console'; root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root / 'arm-mode.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        errors = []
        try:
            if action in ('start', 'load'):
                start_manager(ros)
                errors = ros.load()
            elif action == 'switch':
                ros.switch(request)
            elif action == 'stop':
                stop_manager(ros, request)
        except ValueError as error:
            errors = [str(error)]
        after = ros.snapshot()
        # Known partial load failures are terminal; timeouts/errors above are not.
        receipt = operation_receipt(action, errors, after)
        print('ROBOT_CONSOLE_MANAGER_RECEIPT=' + json.dumps(receipt), flush=True)


if __name__ == '__main__':
    main()
