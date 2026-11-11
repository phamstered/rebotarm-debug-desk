# Jetson Docker runtime (Humble)

Build the paired ROS stack runtime first (`rebotarm-stack:humble`, stack
`scripts/docker-runtime.sh build`). On the same Jetson, in this checkout:

```bash
npm run docker:bridge -- build
ROS_DOMAIN_ID=222 npm run docker:bridge -- run verify-bridge-runtime
BRIDGE_DOCKER_PORT=8766 npm run docker:bridge -- run
```

The Bridge image includes the stack install and its resources, custom messages,
Boost, OpenCV and PCL. It builds a separate `/opt/easy_debug_bridge` workspace;
no host build/install directories are overwritten. `STACK_DOCKER_IMAGE` selects
the stack base, and `BRIDGE_DOCKER_IMAGE` selects the output/runtime image.

The runner uses host networking; Bridge still binds only `127.0.0.1`. No Docker
port publishing is needed. Use a separate port when retaining a host Bridge.
Access through an SSH tunnel as before, for example:

```bash
ssh -N -L 18766:127.0.0.1:8766 TARGET_JETSON
node scripts/smoke-bridge.mjs 18766
```

`ROS_DOMAIN_ID` must match the intended stack. Default runtime domain is 0;
the verification entrypoint requires a reserved domain 220–232 and forces localhost discovery. Individual CTest fixtures select their own isolated domains 213–226; reserve that range too.
Never validate motion by connecting test nodes to the production arm domain.
The container runs in the foreground; Ctrl-C stops only this container. It does
not stop a host Bridge, launch controllers or issue motor commands. Its PID
namespace is separate and it needs no device privileges.

For external resources, set `ROBOT_EXTERNAL_ROOT` and `ROBOT_EXTERNAL_SETUP`.
The directory is mounted read-only at the original absolute path; include all
source targets used by symlink-install. The stack runtime has a separate
privileged device opt-in for camera/serial/CAN nodes.

Host parity: use the existing `npm run deploy:bridge` workflow, then run the same
Bridge colcon suite on Jetson:

```bash
BRIDGE_WORKSPACE="$HOME/easy_debug_bridge" \
STACK_SETUP="$HOME/Project/rebotarm-ros2-stack/install/setup.bash" \
ROS_DOMAIN_ID=222 bash docker/jetson/verify.sh
```

Record source revisions, architecture, build IDs, colcon results, runtime port
and actual WebSocket smoke output for each path. The Docker files alone are not
evidence of successful Jetson execution. The existing desktop's automatic
Bridge start/upgrade and stack systemd operations still execute on the SSH host;
these stack commands must not be used to manage a container runtime. In the
connection profile advanced settings, clear “连接时启动 host Bridge” before
connecting to the container port. This opens only the SSH tunnel and leaves
the managed Bridge running. Host upgrade is rejected in this mode; rebuild
and restart the container explicitly. Existing profiles retain host auto-start.

Release images keep C++ test assertions enabled and enforce bounded CTest
timeouts. `assertions_enabled` fails if a test build removes assertions.
