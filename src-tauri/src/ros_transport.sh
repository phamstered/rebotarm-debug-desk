if [ -z "${FASTRTPS_DEFAULT_PROFILES_FILE:-}${FASTDDS_DEFAULT_PROFILES_FILE:-}" ] && [ -f "$HOME/easy_debug_bridge/install/easy_debug_bridge/share/easy_debug_bridge/config/fastdds_udp.xml" ]; then
    export FASTRTPS_DEFAULT_PROFILES_FILE="$HOME/easy_debug_bridge/install/easy_debug_bridge/share/easy_debug_bridge/config/fastdds_udp.xml"
fi;
