# Sourced by the fixed arm-mode SSH command. Never publish a one-shot HOLD:
# firmware requires an uninterrupted stream until DISABLE is acknowledged.
arm_status() {
    local sample
    sample=$(timeout 5 ros2 topic echo /stm32/status microros_stm32h723_bridge/msg/HardwareStatus --once --no-daemon 2>&1) || {
        echo "Cannot read fresh STM32 HardwareStatus: $sample" >&2
        return 1
    }
    arm_mode=$(awk '/^mode:/ {print $2; exit}' <<<"$sample")
    arm_fault=$(awk '/^fault_code:/ {print $2; exit}' <<<"$sample")
    arm_sequence=$(awk '/^last_command_sequence:/ {print $2; exit}' <<<"$sample")
    if [[ ! "$arm_mode" =~ ^[0-3]$ || ! "$arm_fault" =~ ^[0-9]+$ || ! "$arm_sequence" =~ ^[0-9]+$ ]]; then
        echo "Invalid STM32 HardwareStatus: $sample" >&2
        return 1
    fi
    if [[ "$arm_fault" == 11 ]]; then
        echo "STM32 COMMAND_LOSS_LATCHED (11): reset STM32 on site before retrying." >&2
        return 1
    fi
    # The stack can resume after STALE_SEQUENCE only while already disabled.
    if [[ "$arm_fault" != 0 && !( "$arm_fault" == 4 && "$arm_mode" == 3 ) ]]; then
        echo "STM32 fault_code=$arm_fault mode=$arm_mode; refusing arm-mode change." >&2
        return 1
    fi
}

arm_safe_stop() {
    local response deadline service="${1:-safe_stop}"
    arm_status || return 1
    if pgrep -f '^/opt/ros/humble/lib/[c]ontroller_manager/ros2_control_node( |$)' >/dev/null 2>&1; then
        # Keep ros2_control alive throughout its existing RETURN -> DISABLE flow.
        response=$(timeout 10 ros2 service call "/microros_stm32h723_hardware/$service" std_srvs/srv/Trigger '{}') || return 1
        if ! grep -Eq 'success=(True|true)|success:[[:space:]]*true' <<<"$response"; then
            echo "Hardware safe-stop rejected; command processes were preserved: $response" >&2
            return 1
        fi
        deadline=$((SECONDS + 30))
        while (( SECONDS < deadline )); do
            arm_status || return 1
            if [[ "$arm_mode" == 3 && "$arm_fault" == 0 ]]; then
                echo "STM32 confirmed DISABLE sequence=$arm_sequence before stopping processes."
                return 0
            fi
            sleep 0.2
        done
        echo "STM32 did not confirm DISABLE; command processes were preserved." >&2
        return 1
    fi
    if [[ "$arm_mode" != 3 ]]; then
        echo "STM32 is not DISABLE and no ros2_control safe-stop owner is running; refusing to interrupt commands." >&2
        return 1
    fi
}

arm_controller_domain() {
    local environment
    environment=$(tr '\0' '\n' < "/proc/$1/environ") || return 1
    sed -n 's/^ROS_DOMAIN_ID=//p' <<<"$environment"
}

arm_stop_controller() {
    local pid domain deadline state
    for pid in $(pgrep -f '^/opt/ros/humble/lib/[c]ontroller_manager/ros2_control_node( |$)'); do
        domain=$(arm_controller_domain "$pid") || return 1
        [[ "${domain:-0}" == "${ROS_DOMAIN_ID:-0}" ]] || continue
        arm_status || return 1
        if [[ "$arm_mode" != 3 || "$arm_fault" != 0 ]]; then
            echo "Refusing to stop controller $pid without fault-free DISABLE acknowledgement." >&2
            return 1
        fi
        # The script can exit while its separately grouped controller survives.
        # Stop this domain's confirmed-disabled publisher before the supervisor.
        kill -INT "$pid" || return 1
        deadline=$((SECONDS + 20))
        while kill -0 "$pid" 2>/dev/null; do
            state=$(ps -p "$pid" -o stat=)
            [[ "$state" == Z* ]] && break
            if (( SECONDS >= deadline )); then
                echo "Controller $pid did not exit; no forced termination, PID file preserved." >&2
                return 1
            fi
            sleep 0.25
        done
    done
}

stop_pg() {
    local file="$1" marker="$2" pid deadline
    pid=$(cat "$file" 2>/dev/null || true)
    if [[ "$(alive_pid "$pid" "$marker")" == 1 ]]; then
        # Signal only the supervisor. Its children have separate process groups;
        # a group signal or short escalation can interrupt its cleanup trap.
        kill -TERM "$pid" || return 1
        deadline=$((SECONDS + 90))
        while [[ "$(alive_pid "$pid" "$marker")" == 1 ]]; do
            if (( SECONDS >= deadline )); then
                echo "Arm supervisor $pid is still cleaning up; PID file preserved, no forced termination." >&2
                return 1
            fi
            sleep 0.25
        done
    fi
    rm -f "$file"
}

wait_arm_ready() {
    local pid="$1" log="$2" marker="$3" deadline
    deadline=$((SECONDS + 180))
    while (( SECONDS < deadline )); do
        if [[ "$(alive_pid "$pid" "start_arm_teleop")" != 1 ]]; then
            cat "$log" >&2
            echo "Arm startup exited before its end-to-end self-check passed." >&2
            return 1
        fi
        if grep -Fq "$marker" "$log"; then
            arm_status || return 1
            if [[ "$arm_fault" != 0 || "$arm_mode" == 3 || "$arm_sequence" == 0 ]]; then
                echo "Arm self-check completed but STM32 is not accepting active commands (mode=$arm_mode fault=$arm_fault sequence=$arm_sequence)." >&2
                return 1
            fi
            return 0
        fi
        sleep 0.5
    done
    tail -n 60 "$log" >&2
    echo "Arm startup timed out; inspect its log and use Stop to request a confirmed safe shutdown." >&2
    return 1
}
