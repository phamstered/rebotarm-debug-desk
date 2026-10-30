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
            (root / "stamp").write_text("0")
            mock = r'''
                source "$HELPER"
                timeout() { shift; "$@"; }
                pgrep() { [[ "$CONTROLLER" == 1 ]] && echo 123; }
                arm_controller_domain() { echo 0; }
                sleep() { SECONDS=$((SECONDS + 1)); }
                kill() { echo "signal:$*" >> "$EVENTS"; }
                ros2() {
                    if [[ "$1" == service ]]; then
                        echo "service:$3" >> "$EVENTS"
                        echo requested > "$ROOT/phase"
                        if [[ "$REJECT" == 1 ]]; then echo 'success=False'; else echo 'success=True'; fi
                    else
                        local value="$MODE" phase stamp
                        stamp=$(cat "$ROOT/stamp")
                        echo $((stamp + 1)) > "$ROOT/stamp"
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
                        printf 'header:\n  stamp:\n    sec: 100\n    nanosec: %s\n' "$((stamp + 1))"
                        printf 'mode: %s\nfault_code: %s\nlast_command_sequence: 50\n' "$value" "$FAULT"
                    fi
                }
                alive_pid() {
                    local n
                    n=$(cat "$ROOT/polls")
                    echo $((n + 1)) > "$ROOT/polls"
                    if (( n < 8 )); then echo 1; else echo 0; fi
                }
            '''
            env = dict(os.environ, HELPER=str(HELPER), ROOT=str(root), EVENTS=str(root / "events"),
                       MODE=str(mode), FAULT=str(fault), CONTROLLER=str(controller), REJECT=str(reject))
            # Sleep is simulated, but each poll still touches the filesystem.
            # The repeated-stop case polls until the fake supervisor exits;
            # 5s of wall clock is tight on a loaded CI runner.
            result = subprocess.run(["bash", "-c", mock + "\n" + body], env=env,
                                    text=True, capture_output=True, timeout=20)
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



    def test_owns_ros2_via_child_or_log_and_unknown(self):
        result, _, _ = self.run_shell(
            'alive_pid() { echo 1; }; '
            'pgrep() { if [[ "$*" == *"-P"* ]]; then echo "999 python3 stm32h723_arm.launch.py"; fi; }; '
            'out=$(owns_ros2 123 "$ROOT/log" start_arm_teleop); echo "owns=$out"'
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("owns=1", result.stdout)

        result, _, _ = self.run_shell(
            'alive_pid() { echo 1; }; '
            'pgrep() { return 1; }; '
            'echo "Starting STM32H723 arm ros2_control" > "$ROOT/log"; '
            'out=$(owns_ros2 123 "$ROOT/log" start_arm_teleop); echo "owns=$out"'
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("owns=1", result.stdout)

        result, _, _ = self.run_shell(
            'alive_pid() { echo 1; }; '
            'pgrep() { return 1; }; '
            'out=$(owns_ros2 123 "$ROOT/log" start_arm_teleop); echo "owns=$out"'
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("owns=0", result.stdout)

        result, _, _ = self.run_shell(
            'alive_pid() { echo 0; }; '
            'out=$(owns_ros2 123 "$ROOT/log" start_arm_teleop); echo "owns=$out"'
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("owns=0", result.stdout)

    def test_mode_cleanup_orders_safe_stop_before_process_cleanup_and_verification(self):
        body = r'''teleop_pid_file=teleop; traj_pid_file=trajectory
        arm_safe_stop() { echo "safe:$1" >> "$EVENTS"; }
        arm_stop_controller() { echo controller >> "$EVENTS"; }
        stop_pg() { echo "stop:$1:$2" >> "$EVENTS"; }
        arm_stop_orphans() { echo orphans >> "$EVENTS"; }
        arm_verify_clean() { echo verify >> "$EVENTS"; }
        arm_clean_environment disable'''
        result, events, _ = self.run_shell(body)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events.splitlines(), ["safe:disable", "controller", "stop:teleop:start_arm_teleop", "stop:trajectory:start_arm_teleop", "orphans", "verify"])

    def test_mode_cleanup_failure_never_advances_to_next_stage(self):
        for failure in ("safe", "controller", "supervisor", "orphans", "verify"):
            body = r'''teleop_pid_file=teleop; traj_pid_file=trajectory
            arm_safe_stop() { echo safe >> "$EVENTS"; [[ "$FAILURE" != safe ]]; }
            arm_stop_controller() { echo controller >> "$EVENTS"; [[ "$FAILURE" != controller ]]; }
            stop_pg() { echo supervisor >> "$EVENTS"; [[ "$FAILURE" != supervisor ]]; }
            arm_stop_orphans() { echo orphans >> "$EVENTS"; [[ "$FAILURE" != orphans ]]; }
            arm_verify_clean() { echo verify >> "$EVENTS"; [[ "$FAILURE" != verify ]]; }
            FAILURE=FAIL_VALUE
            arm_clean_environment || exit 17
            echo started >> "$EVENTS"'''.replace("FAIL_VALUE", failure)
            result, events, _ = self.run_shell(body)
            self.assertEqual(result.returncode, 17, (failure, result.stderr))
            self.assertNotIn("started", events)
            self.assertEqual(events.splitlines()[-1], failure)

    def test_orphan_command_owner_blocks_same_domain_but_not_other_domains(self):
        for domain, expected in (("0", 1), ("225", 0)):
            body = r'''pgrep() { echo 123; }
            arm_controller_domain() { echo DOMAIN_VALUE; }
            ps() { echo S; }
            arm_verify_clean'''.replace("DOMAIN_VALUE", domain)
            result, _, _ = self.run_shell(body)
            self.assertEqual(result.returncode, expected, result.stderr)
            if expected:
                self.assertIn("refusing dirty mode startup", result.stderr)

    def test_unreadable_owner_blocks_clean_verification(self):
        result, _, _ = self.run_shell('pgrep() { echo 123; }; arm_controller_domain() { return 1; }; arm_verify_clean')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Cannot verify arm owner", result.stderr)

    def test_vla_switch_requires_gravity_exclusivity_and_fault_free_track(self):
        for state, expected in (("valid", 0), ("missing_gravity", 1), ("conflict", 1), ("hold", 1), ("fault", 1)):
            body = r'''ros2() {
                if [[ "$1" == topic ]]; then printf 'mode: %s\nfault_code: %s\nlast_command_sequence: 50\n' "$MODE" "$FAULT"; return 0; fi
                if [[ "$2" == switch_controllers ]]; then echo switched >> "$EVENTS"; return 0; fi
                printf 'vla_position_controller type active\narm_trajectory_controller type inactive\n'
                [[ "$CASE" == missing_gravity ]] || echo 'gravity_compensation_controller type active'
                [[ "$CASE" != conflict ]] || echo 'arm_teleop_controller type active'
            }
            CASE=CASE_VALUE
            arm_start_vla'''.replace("CASE_VALUE", state)
            result, events, _ = self.run_shell(body, mode=0 if state == "hold" else 1, fault=6 if state == "fault" else 0)
            self.assertEqual(result.returncode, expected, result.stderr)
            self.assertIn("switched", events)

    def test_vla_rejected_switch_never_reports_ready(self):
        result, _, _ = self.run_shell('ros2() { return 1; }; arm_start_vla')
        self.assertNotEqual(result.returncode, 0)

    def test_reset_disabled_session_recovers_after_rejected_or_missing_service(self):
        for failure in ("rejected", "timeout"):
            body = r'''original_ros2=$(declare -f ros2)
            eval "${original_ros2/ros2 ()/mock_ros2 ()}"
            ros2() {
                if [[ "$1" == service ]]; then
                    touch "$ROOT/reset"
                    echo 'hardware is not active'
                    [[ "$CASE" != timeout ]] || return 124
                    echo 'success=False'; return 0
                fi
                [[ ! -f "$ROOT/reset" ]] || MODE=3
                mock_ros2 "$@"
            }
            CASE=CASE_VALUE
            arm_safe_stop'''.replace("CASE_VALUE", failure)
            result, events, _ = self.run_shell(body, mode=1, controller=1)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(events.splitlines(), ["status:1"] + ["status:3"] * 3)
            self.assertIn("without enabling outputs", result.stdout)
            self.assertNotIn("signal", events)

    def test_reset_disabled_firmware_never_requests_return_from_old_active_controller(self):
        result, events, _ = self.run_shell('arm_safe_stop', controller=1)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events.splitlines(), ["status:3"] * 4)
        self.assertNotIn("service", events)
        self.assertIn("will not request RETURN", result.stdout)

    def test_recovery_requires_progressing_fault_free_disable_samples(self):
        for case in ("stale", "backward", "missing", "track", "fault", "lost", "invalid_nsec"):
            body = r'''ros2() {
                local n
                n=$(cat "$ROOT/stamp"); echo $((n+1)) > "$ROOT/stamp"
                [[ "$CASE" != lost || "$n" == 0 ]] || return 124
                local sec=100 nano=$((n+1)) mode=3 fault=0
                [[ "$CASE" != stale ]] || nano=1
                [[ "$CASE" != backward || "$n" == 0 ]] || sec=99
                [[ "$CASE" != invalid_nsec ]] || nano=1000000000
                [[ "$CASE" != track || "$n" == 0 ]] || mode=1
                [[ "$CASE" != fault || "$n" == 0 ]] || fault=11
                if [[ "$CASE" != missing ]]; then printf 'header:\n  stamp:\n    sec: %s\n    nanosec: %s\n' "$sec" "$nano"; fi
                printf 'mode: %s\nfault_code: %s\nlast_command_sequence: 0\n' "$mode" "$fault"
            }
            CASE=CASE_VALUE
            arm_confirm_disabled && echo recovered >> "$EVENTS"'''.replace("CASE_VALUE", case)
            result, events, _ = self.run_shell(body)
            self.assertNotEqual(result.returncode, 0, (case, result.stdout, result.stderr))
            self.assertNotIn("recovered", events)
            self.assertNotIn("signal", events)

    def test_recovery_accepts_second_boundary_and_zero_sequence(self):
        body = r'''ros2() {
            local n sec=100 nano=999999999
            n=$(cat "$ROOT/stamp"); echo $((n+1)) > "$ROOT/stamp"
            if (( n > 0 )); then sec=101; nano=$((n-1)); fi
            printf 'header:\n  stamp:\n    sec: %s\n    nanosec: %s\nmode: 3\nfault_code: 0\nlast_command_sequence: 0\n' "$sec" "$nano"
        }; arm_confirm_disabled'''
        result, _, _ = self.run_shell(body)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_status_recovery_never_reads_transient_cached_feedback(self):
        body = r'''ros2() {
            [[ "$*" == *"--qos-reliability best_effort --qos-durability volatile"* ]] || return 1
            printf 'mode: 3\nfault_code: 0\nlast_command_sequence: 0\n'
        }; arm_status'''
        result, _, _ = self.run_shell(body)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_other_domain_controller_does_not_invoke_local_safe_stop(self):
        result, events, _ = self.run_shell('arm_controller_domain() { echo 225; }; arm_safe_stop', controller=1)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, "status:3\n")
        result, events, _ = self.run_shell('arm_controller_domain() { return 1; }; arm_safe_stop', controller=1)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("service", events)

    def test_orphan_identity_checks_exact_command_uid_and_start_ticks(self):
        body = r'''ps() {
            if [[ "$*" == *args=* ]]; then echo "$COMMAND"; else echo "$OWNER"; fi
        }
        id() { echo 1000; }
        awk() { echo 123456; }
        COMMAND='/usr/bin/python3 /opt/ros/humble/bin/ros2 launch microros_stm32h723_bridge stm32h723_arm.launch.py'
        OWNER=1000
        arm_owner_identity 123 || exit 10
        OWNER=1001; arm_owner_identity 123 && exit 11
        OWNER=1000; COMMAND='/usr/bin/python3 /opt/ros/humble/bin/ros2 launch rebotarm_gazebo left_wrist_camera.launch.py'
        arm_owner_identity 123 && exit 12
        COMMAND='/opt/ros/humble/lib/controller_manager/ros2_control_node'; arm_owner_identity 123 || exit 13
        COMMAND='/home/jialiang/easy_debug_bridge/install/easy_debug_bridge/lib/easy_debug_bridge/bridge_node'
        arm_owner_identity 123 && exit 14
        exit 0'''
        result, _, _ = self.run_shell(body)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("123456", result.stdout)

    ORPHAN_MOCK = r'''
        pgrep() {
            [[ "$*" != *"[c]ontroller_manager"* ]] || return 1
            [[ -f "$ROOT/gone" ]] || echo 39930
        }
        ps() { [[ -f "$ROOT/gone" ]] || echo S; }
        arm_owner_identity() {
            [[ ! -f "$ROOT/gone" ]] || return 1
            printf '123456\n/usr/bin/python3 /opt/ros/humble/bin/ros2 launch microros_stm32h723_bridge stm32h723_arm.launch.py\n'
        }
        kill() {
            echo "signal:$*" >> "$EVENTS"
            [[ "${HANG:-0}" == 1 ]] || touch "$ROOT/gone"
        }
    '''

    def test_orphan_launch_without_pid_file_is_cleaned_then_verified(self):
        body = self.ORPHAN_MOCK + r'''
            teleop_pid_file="$ROOT/missing-teleop"; traj_pid_file="$ROOT/missing-trajectory"
            alive_pid() { echo 0; }
            arm_clean_environment
        '''
        result, events, _ = self.run_shell(body)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events.splitlines(), ["status:3"] * 4 + ["signal:-INT 39930"])
        self.assertIn("verified clean", result.stdout)

    def test_orphan_cleanup_rejects_active_fault_and_hanging_owner(self):
        for mode, fault, hang in ((1, 0, 0), (3, 11, 0), (3, 4, 0), (3, 0, 1)):
            result, events, _ = self.run_shell(self.ORPHAN_MOCK + f'HANG={hang}; arm_stop_orphans', mode=mode, fault=fault)
            self.assertNotEqual(result.returncode, 0, result.stderr)
            if hang:
                self.assertIn("no forced termination", result.stderr)
                self.assertEqual([line for line in events.splitlines() if line.startswith("signal:")], ["signal:-INT 39930"])
            else:
                self.assertNotIn("signal", events)

    def test_orphan_cleanup_preserves_other_domain_and_unreadable_owner(self):
        result, events, _ = self.run_shell(self.ORPHAN_MOCK + 'arm_controller_domain() { echo 225; }; arm_stop_orphans')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, "")
        result, events, _ = self.run_shell(self.ORPHAN_MOCK + 'arm_owner_identity() { return 1; }; arm_stop_orphans')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("signal", events)

    def test_orphan_changed_pid_or_domain_during_confirmation_is_not_signalled(self):
        for change in ("identity", "domain"):
            body = self.ORPHAN_MOCK + r'''
                arm_confirm_disabled() { touch "$ROOT/changed"; }
                arm_owner_identity() {
                    if [[ "$CHANGE" == identity && -f "$ROOT/changed" ]]; then echo reused; else echo original; fi
                }
                arm_controller_domain() {
                    if [[ "$CHANGE" == domain && -f "$ROOT/changed" ]]; then echo 225; else echo 0; fi
                }
                CHANGE=CHANGE_VALUE
                arm_stop_orphans
            '''.replace("CHANGE_VALUE", change)
            result, events, _ = self.run_shell(body)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("signal", events)

    def test_orphan_that_exits_during_confirmation_needs_no_signal(self):
        body = self.ORPHAN_MOCK + 'arm_confirm_disabled() { touch "$ROOT/gone"; }; arm_stop_orphans'
        result, events, _ = self.run_shell(body)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("signal", events)

    def test_orphan_supervisor_uses_existing_term_cleanup_trap(self):
        body = self.ORPHAN_MOCK + r'''
            arm_owner_identity() { printf '123456\nbash /home/jialiang/Project/rebotarm-ros2-stack/scripts/start_arm_teleop.sh --clean=true\n'; }
            arm_stop_orphans
        '''
        result, events, _ = self.run_shell(body)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("signal:-TERM 39930", events)



if __name__ == "__main__":
    unittest.main()
