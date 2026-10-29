#!/usr/bin/env bash
# Read-only telemetry recorder. Does not start controllers or move the arm.
set -eo pipefail
source /opt/ros/humble/setup.bash
source "$HOME/Project/rebotarm-ros2-stack/install/setup.bash"
tool_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$tool_dir/monitor_motion.py" record "$@"
