import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dockerArgs } from './docker-bridge.mjs';

test('Bridge uses host networking and explicit loopback server port, without hardware privileges', () => {
  const args = dockerArgs(['run'], { ROS_DOMAIN_ID: '221', BRIDGE_DOCKER_PORT: '18766' });
  assert.deepEqual(args.slice(0, 8), ['run', '--rm', '--init', '--network', 'host', '--env', 'ROS_DOMAIN_ID=221', 'rebotarm-bridge:humble']);
  assert.equal(args.at(-1), 'port:=18766');
  assert.ok(!args.includes('--privileged'));
  assert.ok(!args.includes('--pid'));
});
test('custom commands remain separate argv entries', () => {
  assert.deepEqual(dockerArgs(['run', 'bash', '-c', 'echo "$HOME"'], {}).slice(-3), ['bash', '-c', 'echo "$HOME"']);
});
test('invalid port/domain and incomplete overlays fail before Docker', () => {
  for (const env of [{ ROS_DOMAIN_ID: '-1' }, { ROS_DOMAIN_ID: '233' }, { ROS_DOMAIN_ID: 'x' }, { BRIDGE_DOCKER_PORT: '0' }, { BRIDGE_DOCKER_PORT: '1.2' }, { ROBOT_EXTERNAL_SETUP: '/x' }, { ROBOT_EXTERNAL_ROOT: 'relative', ROBOT_EXTERNAL_SETUP: '/x' }]) {
    assert.throws(() => dockerArgs(['run'], env));
  }
  assert.throws(() => dockerArgs(['delete'], {}));
});
test('external overlay preserves absolute resource and symlink paths read-only', () => {
  const args = dockerArgs(['run'], { ROBOT_EXTERNAL_ROOT: '/opt/robot', ROBOT_EXTERNAL_SETUP: '/opt/robot/install/setup.bash' });
  assert.ok(args.includes('/opt/robot:/opt/robot:ro'));
  assert.ok(args.includes('ROBOT_EXTERNAL_SETUP=/opt/robot/install/setup.bash'));
});
