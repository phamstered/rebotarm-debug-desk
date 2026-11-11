import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export function dockerArgs(argv, env = process.env) {
  const [action, ...rest] = argv;
  const image = env.BRIDGE_DOCKER_IMAGE || 'rebotarm-bridge:humble';
  const root = fileURLToPath(new URL('..', import.meta.url));
  if (action === 'build') return ['build', '--build-arg', `STACK_IMAGE=${env.STACK_DOCKER_IMAGE || 'rebotarm-stack:humble'}`, '-f', resolve(root, 'docker/jetson/Dockerfile'), '-t', image, root, ...rest];
  if (action !== 'run') throw new Error('Usage: node scripts/docker-bridge.mjs build | run [COMMAND ARG ...]');
  const domain = Number(env.ROS_DOMAIN_ID ?? 0);
  const port = Number(env.BRIDGE_DOCKER_PORT ?? 8765);
  if (!Number.isInteger(domain) || domain < 0 || domain > 232) throw new Error('Invalid ROS_DOMAIN_ID');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid BRIDGE_DOCKER_PORT');
  const args = ['run', '--rm', '--init', '--network', 'host', '--env', `ROS_DOMAIN_ID=${domain}`];
  if (env.ROBOT_EXTERNAL_ROOT) {
    if (!env.ROBOT_EXTERNAL_ROOT.startsWith('/') || env.ROBOT_EXTERNAL_ROOT.includes(':') || !env.ROBOT_EXTERNAL_SETUP) throw new Error('External overlay requires an absolute root and setup path');
    args.push('--volume', `${env.ROBOT_EXTERNAL_ROOT}:${env.ROBOT_EXTERNAL_ROOT}:ro`, '--env', `ROBOT_EXTERNAL_SETUP=${env.ROBOT_EXTERNAL_SETUP}`);
  } else if (env.ROBOT_EXTERNAL_SETUP) throw new Error('ROBOT_EXTERNAL_SETUP requires ROBOT_EXTERNAL_ROOT');
  args.push(image, ...(rest.length ? rest : ['ros2', 'run', 'easy_debug_bridge', 'bridge_node', '--ros-args', '-p', `port:=${port}`]));
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = spawnSync('docker', dockerArgs(process.argv.slice(2)), { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
