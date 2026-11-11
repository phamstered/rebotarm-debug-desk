#!/bin/bash
set -eo pipefail
root="${BRIDGE_WORKSPACE:-/opt/easy_debug_bridge}"
domain="${ROS_DOMAIN_ID:-222}"
[[ "$domain" =~ ^[0-9]+$ ]] && ((domain >= 220 && domain <= 232)) || { echo 'Verification requires isolated ROS_DOMAIN_ID 220..232' >&2; exit 2; }
export ROS_DOMAIN_ID="$domain" ROS_LOCALHOST_ONLY=1
source /opt/ros/humble/setup.bash
source "${STACK_SETUP:-/opt/rebotarm/install/setup.bash}"
source "$root/install/setup.bash"
cd "$root"
colcon test --packages-select easy_debug_bridge --event-handlers console_direct+ --return-code-on-test-failure
colcon test-result --verbose
