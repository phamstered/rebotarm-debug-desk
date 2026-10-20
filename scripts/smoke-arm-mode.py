"""Run exported native arm commands on a robot AFTER on-site safety confirmation.

Export the actual Tauri shell commands first:
  ROBOT_CONSOLE_ARM_SMOKE_DIR=/tmp/robot-console-arm-smoke cargo test \
    --manifest-path src-tauri/Cargo.toml arm_commands_are_valid_shell
Then run this script with --host, --commands, --cycles and --confirmed-safe.
The final successful state is stopped, STM32 DISABLE with fault_code=0.
"""
import argparse
import json
from pathlib import Path
import re
import shlex
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--commands", type=Path, required=True)
    parser.add_argument("--cycles", type=int, default=3)
    parser.add_argument("--confirmed-safe", action="store_true")
    parser.add_argument("--supported-disable", action="store_true", help="Arm is supported on site; explicitly release outputs when stopping")
    args = parser.parse_args()
    if not args.confirmed_safe or not 1 <= args.cycles <= 10:
        parser.error("On-site safety confirmation and 1–10 cycles are required")

    def ssh(command, limit=240):
        result = subprocess.run(["ssh", "-o", "BatchMode=yes", args.host, "bash -s"],
                                input=command, text=True, capture_output=True, timeout=limit)
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)
        return result.stdout.strip()

    # Reuse the exact setup/domain selection emitted by the native status command.
    status_body = shlex.split((args.commands / "status.sh").read_text())[2]
    setup = status_body.split('mkdir -p "$HOME/.cache/robot-console";', 1)[0]

    def snapshot(phase, expected_mode=None):
        output = ssh(setup + "timeout 6 ros2 topic echo /stm32/status microros_stm32h723_bridge/msg/HardwareStatus --once --no-daemon")
        values = {}
        for line in output.splitlines():
            if line.startswith(("mode:", "fault_code:", "last_command_sequence:", "active_joint_mask:")):
                key, value = line.split(":", 1)
                values[key] = int(value.strip())
        print(json.dumps({"phase": phase, **values}), flush=True)
        if values.get("fault_code") != 0 or values.get("active_joint_mask") != 127:
            raise RuntimeError("HardwareStatus is missing or unhealthy")
        if expected_mode is not None and values.get("mode") != expected_mode:
            raise RuntimeError(f"Expected mode {expected_mode}")
        return values

    for cycle in range(1, args.cycles + 1):
        snapshot(f"{cycle}:before", 3)
        print(f"Cycle {cycle}: starting Teleop", flush=True)
        try:
            print(ssh((args.commands / "teleop.sh").read_text()), flush=True)
            first = snapshot(f"{cycle}:running")
            if first["mode"] == 3:
                raise RuntimeError("Teleop remained disabled")
            controllers = re.sub(r"\x1b\[[0-9;]*m", "", ssh(setup + "timeout 8 ros2 control list_controllers"))
            print(controllers, flush=True)
            for name in ("arm_teleop_controller", "gravity_compensation_controller", "gripper_teleop_controller"):
                if not any(line.split()[0] == name and line.split()[-1] == "active"
                           for line in controllers.splitlines() if line.split()):
                    raise RuntimeError(f"Controller {name} is not active")
            time.sleep(3)
            second = snapshot(f"{cycle}:steady")
            if second["last_command_sequence"] == first["last_command_sequence"]:
                raise RuntimeError("Command sequence stopped advancing")
        finally:
            print(f"Cycle {cycle}: requesting confirmed safe stop", flush=True)
            print(ssh((args.commands / ("disable-stop.sh" if args.supported_disable else "stop.sh")).read_text()), flush=True)
        time.sleep(1)
        snapshot(f"{cycle}:stopped", 3)
        controllers_left = ssh(setup + "pgrep -f '^/opt/ros/humble/lib/controller_manager/ros2_control_node( |$)' || true")
        if controllers_left:
            raise RuntimeError(f"Controller process survived Stop: {controllers_left}")
    print(f"PASS: {args.cycles} live Teleop start/stop cycles", flush=True)


if __name__ == "__main__":
    main()
