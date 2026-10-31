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
        # Stop this domain confirmed-disabled publisher before the supervisor.
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

# 0=not owns, 1=owns, 2=unknown (pid alive but unreadable). Used by Start VLA fail-closed.
owns_ros2() {
    local pid="$1" log="$2" marker="$3"
    if [ "$(alive_pid "$pid" "$marker")" != 1 ]; then
        echo 0
        return
    fi
    case "$pid" in *[!0-9]*|""|0)
        echo 2
        return
        ;;
    esac
    if pgrep -P "$pid" -a 2>/dev/null | grep -Fq 'stm32h723_arm.launch.py'; then
        echo 1
        return
    fi
    if [ -f "$log" ] && grep -Fq 'Starting STM32H723 arm ros2_control' "$log" 2>/dev/null; then
        echo 1
        return
    fi
    echo 0
}

# Check only arm command owners in this ROS domain. Unknown/unreadable owners
# block startup; do not force-kill arbitrary ROS processes to claim cleanliness.
arm_verify_clean() {
    local pid domain
    local pattern='^((/usr/bin/python3( -u)? )?(/opt/ros/humble/lib/controller_manager/ros2_control_node|/[^ ]*/joint_state_relay/(relay_node|leader_driver)|/[^ ]*/robo_driver/driver)|bash [^ ]*/scripts/start_arm_teleop.sh|/usr/bin/python3 /opt/ros/humble/bin/ros2 launch (microros_stm32h723_bridge stm32h723_arm.launch.py|joint_state_relay relay_to_microros_arm.launch.py))( |$)'
    for pid in $(pgrep -f "$pattern"); do
        domain=$(arm_controller_domain "$pid") || {
            echo "Cannot verify arm owner $pid; refusing new mode." >&2
            return 1
        }
        [[ "${domain:-0}" == "${ROS_DOMAIN_ID:-0}" ]] || continue
        # Zombie processes cannot own a publisher or hardware interface.
        [[ "$(ps -p "$pid" -o stat=)" == Z* ]] && continue
        echo "Previous arm owner $pid still exists in ROS_DOMAIN_ID=${ROS_DOMAIN_ID:-0}; refusing dirty mode startup." >&2
        return 1
    done
}

arm_clean_environment() {
    local service="${1:-safe_stop}"
    echo "[mode] safe stop and confirm DISABLE"
    arm_safe_stop "$service" || return 1
    arm_stop_controller || return 1
    echo "[mode] cleaning previous arm supervisors"
    stop_pg "$teleop_pid_file" "start_arm_teleop" || return 1
    stop_pg "$traj_pid_file" "start_arm_teleop" || return 1
    arm_verify_clean || return 1
    echo "[mode] previous control environment verified clean"
}

# Called under the same native mode-switch lock after fresh trajectory bring-up.
arm_start_vla() {
    local state
    timeout 10 ros2 control switch_controllers --strict --activate vla_position_controller --deactivate arm_trajectory_controller || return 1
    state=$(timeout 10 ros2 control list_controllers | sed -E 's/\x1B\[[0-9;]*[mK]//g') || return 1
    for controller in vla_position_controller gravity_compensation_controller; do
        if ! awk -v name="$controller" '$1 == name && $3 == "active" {found=1} END {exit !found}' <<<"$state"; then
            echo "VLA startup verification failed: $controller is not active." >&2
            return 1
        fi
    done
    if awk '$1 ~ /^(arm_teleop_controller|arm_trajectory_controller)$/ && $3 == "active" {found=1} END {exit !found}' <<<"$state"; then
        echo "VLA startup left a conflicting position controller active." >&2
        return 1
    fi
    arm_status || return 1
    [[ "$arm_mode" == 1 && "$arm_fault" == 0 ]] || {
        echo "VLA startup requires fault-free TRACK feedback." >&2
        return 1
    }
}
