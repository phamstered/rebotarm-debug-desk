#!/bin/bash
set -eo pipefail
source /opt/ros/humble/setup.bash
if [[ -n "${ROBOT_EXTERNAL_SETUP:-}" ]]; then
    [[ -r "$ROBOT_EXTERNAL_SETUP" ]] || { echo "Missing external overlay: $ROBOT_EXTERNAL_SETUP" >&2; exit 2; }
    source "$ROBOT_EXTERNAL_SETUP"
fi
source /opt/rebotarm/install/setup.bash
source /opt/easy_debug_bridge/install/setup.bash
if [[ -z "${FASTRTPS_DEFAULT_PROFILES_FILE:-}${FASTDDS_DEFAULT_PROFILES_FILE:-}" ]]; then
    export FASTRTPS_DEFAULT_PROFILES_FILE=/opt/easy_debug_bridge/install/easy_debug_bridge/share/easy_debug_bridge/config/fastdds_udp.xml
fi
exec "$@"
