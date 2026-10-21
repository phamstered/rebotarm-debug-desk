"""Exercise the shipped lifecycle shell with simulated ROS and process responses."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

HELPER = Path(__file__).resolve().parents[1] / "src/arm_mode_lifecycle.sh"


class LifecycleTests(unittest.TestCase):
    def run_shell(self, body, *, mode=3, fault=0, controller=0, reject=0):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "phase").write_text("initial")
            (root / "pid").write_text("123")
            (root / "log").write_text("")
            (root / "polls").write_text("0")
            mock = r'''
                source "$HELPER"
                timeout() { shift; "$@"; }
                pgrep() { [[ "$CONTROLLER" == 1 ]]; }
                sleep() { SECONDS=$((SECONDS + 1)); }
                kill() { echo "signal:$*" >> "$EVENTS"; }
                ros2() {
                    if [[ "$1" == service ]]; then
                        echo "service:$3" >> "$EVENTS"
                        echo requested > "$ROOT/phase"
                        if [[ "$REJECT" == 1 ]]; then echo 'success=False'; else echo 'success=True'; fi
                    else
                        local value="$MODE" phase
                        phase=$(cat "$ROOT/phase")
                        if [[ "$phase" == requested ]]; then
                            value=2
                            echo returning > "$ROOT/phase"
                        elif [[ "$phase" == returning && "${NEVER_DISABLE:-0}" != 1 ]]; then
                            value=3
                        elif [[ "$phase" == returning ]]; then
                            value=2
                        fi
                        echo "status:$value" >> "$EVENTS"
                        printf 'mode: %s\nfault_code: %s\nlast_command_sequence: 50\n' "$value" "$FAULT"
                    fi
                }
                alive_pid() {
                    local n
                    n=$(cat "$ROOT/polls")
                    echo $((n + 1)) > "$ROOT/polls"
                    if (( n < 26 )); then echo 1; else echo 0; fi
                }
            '''
            env = dict(os.environ, HELPER=str(HELPER), ROOT=str(root), EVENTS=str(root / "events"),
                       MODE=str(mode), FAULT=str(fault), CONTROLLER=str(controller), REJECT=str(reject))
            result = subprocess.run(["bash", "-c", mock + "\n" + body], env=env,
                                    text=True, capture_output=True, timeout=5)
            return result, (root / "events").read_text() if (root / "events").exists() else "", (root / "pid").exists()

    def test_initial_disabled_does_not_publish_or_request_hold(self):
        result, events, _ = self.run_shell("arm_safe_stop")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, "status:3\n")

    def test_process_probe_does_not_match_its_own_embedded_shell_command(self):
        result, events, _ = self.run_shell("unset -f pgrep; arm_safe_stop")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, "status:3\n")

    def test_stack_cleanup_pattern_does_not_match_embedded_ssh_command(self):
        result, _, _ = self.run_shell("unset -f pgrep; pgrep -f '/controller_manager/'ros2_control_node >/dev/null && exit 44; arm_safe_stop")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_status_read_does_not_require_daemon_type_discovery(self):
        result, _, _ = self.run_shell('''ros2() {
            [[ "$*" == *"microros_stm32h723_bridge/msg/HardwareStatus --once --no-daemon"* ]] || return 1;
            printf 'mode: 3\nfault_code: 0\nlast_command_sequence: 50\n';
        }; arm_safe_stop''')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_latched_fault_requires_on_site_reset(self):
        result, events, _ = self.run_shell("arm_safe_stop", mode=0, fault=11, controller=1)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("COMMAND_LOSS_LATCHED", result.stderr)
        self.assertNotIn("service", events)

    def test_active_commands_without_safe_stop_owner_are_preserved(self):
        result, events, _ = self.run_shell("arm_safe_stop", mode=0)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("signal", events)

    def test_rejected_safe_stop_never_signals_or_removes_pid(self):
        result, events, pid_exists = self.run_shell('arm_safe_stop && stop_pg "$ROOT/pid" start_arm_teleop',
                                                   mode=1, controller=1, reject=1)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("signal", events)
        self.assertTrue(pid_exists)

    def test_unconfirmed_disable_never_signals_or_removes_pid(self):
        result, events, pid_exists = self.run_shell('NEVER_DISABLE=1; arm_safe_stop && stop_pg "$ROOT/pid" start_arm_teleop',
                                                   mode=1, controller=1)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("did not confirm DISABLE", result.stderr)
        self.assertNotIn("signal", events)
        self.assertTrue(pid_exists)

    def test_repeated_stop_waits_for_disable_then_only_signals_supervisor(self):
        for _ in range(5):
            result, events, pid_exists = self.run_shell('arm_safe_stop && stop_pg "$ROOT/pid" start_arm_teleop',
                                                       mode=1, controller=1)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(events.splitlines(), ["status:1", "service:/microros_stm32h723_hardware/safe_stop", "status:2", "status:3", "signal:-TERM 123"])
            self.assertFalse(pid_exists)

    def test_explicit_disable_uses_controller_owned_service(self):
        result, events, _ = self.run_shell("arm_safe_stop disable", mode=1, controller=1)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("service:/microros_stm32h723_hardware/disable", events)

    def test_controller_shutdown_requires_disable_and_matches_domain(self):
        mocks = '''pgrep() { echo 123; }; arm_controller_domain() { echo 0; };
                   kill() { [[ "$1" != -0 ]] || return 1; echo "signal:$*" >> "$EVENTS"; };'''
        result, events, _ = self.run_shell(mocks + "arm_stop_controller", mode=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("signal:-INT 123", events)
        result, events, _ = self.run_shell(mocks + "arm_stop_controller", mode=1)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("signal", events)
        result, events, _ = self.run_shell(mocks + "arm_controller_domain() { echo 197; }; arm_stop_controller", mode=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, "")

    def test_controller_timeout_does_not_escalate(self):
        mocks = '''pgrep() { echo 123; }; arm_controller_domain() { echo 0; };
                   ps() { echo S; };
                   kill() { [[ "$1" != -0 ]] || return 0; echo "signal:$*" >> "$EVENTS"; };'''
        result, events, _ = self.run_shell(mocks + "arm_stop_controller")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no forced termination", result.stderr)
        self.assertEqual(events.splitlines(), ["status:3", "signal:-INT 123"])

    def test_stuck_cleanup_keeps_pid_without_escalating(self):
        result, events, pid_exists = self.run_shell('alive_pid() { echo 1; }; stop_pg "$ROOT/pid" start_arm_teleop')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events, "signal:-TERM 123\n")
        self.assertTrue(pid_exists)

    def test_startup_requires_self_check_and_fresh_active_ack(self):
        result, _, _ = self.run_shell('echo "End-to-end self-check passed:" > "$ROOT/log"; wait_arm_ready 123 "$ROOT/log" "End-to-end self-check passed:"', mode=1)
        self.assertEqual(result.returncode, 0, result.stderr)
        result, _, _ = self.run_shell('echo "End-to-end self-check passed:" > "$ROOT/log"; wait_arm_ready 123 "$ROOT/log" "End-to-end self-check passed:"', mode=3)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not accepting active commands", result.stderr)

    def test_early_exit_and_timeout_do_not_report_ready(self):
        result, _, _ = self.run_shell('echo "startup failure" > "$ROOT/log"; alive_pid() { echo 0; }; wait_arm_ready 123 "$ROOT/log" "End-to-end self-check passed:"')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("startup failure", result.stderr)
        result, _, pid_exists = self.run_shell('alive_pid() { echo 1; }; wait_arm_ready 123 "$ROOT/log" "End-to-end self-check passed:"')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("startup timed out", result.stderr)
        self.assertTrue(pid_exists)

    def test_missing_or_malformed_hardware_status_is_rejected(self):
        result, _, _ = self.run_shell('ros2() { echo "bad response"; }; arm_safe_stop')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Invalid STM32", result.stderr)
        result, _, _ = self.run_shell('ros2() { return 1; }; arm_safe_stop')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Cannot read fresh", result.stderr)

    def test_stale_sequence_is_recoverable_only_while_disabled(self):
        result, _, _ = self.run_shell("arm_safe_stop", fault=4)
        self.assertEqual(result.returncode, 0, result.stderr)
        result, _, _ = self.run_shell("arm_safe_stop", mode=1, fault=4)
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
