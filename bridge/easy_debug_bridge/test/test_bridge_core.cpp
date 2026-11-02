#include "easy_debug_bridge/bridge_core.hpp"
#include "easy_debug_bridge/position_motion_core.hpp"
#include "easy_debug_bridge/motion_timing.hpp"
#include "easy_debug_bridge/motion_arrival.hpp"
#include "easy_debug_bridge/group_hold_core.hpp"
#include "easy_debug_bridge/position_group_core.hpp"
#include "easy_debug_bridge/gripper_motion_core.hpp"
#include "easy_debug_bridge/rgbd_core.hpp"
#include "easy_debug_bridge/controller_health.hpp"

#include "easy_debug_bridge/motion_log.hpp"
#include <cassert>
#include <cmath>
#include <cstdint>

using easy_debug_bridge::CommandFields;
using easy_debug_bridge::CommandValidation;

int main() {
  {
    using namespace easy_debug_bridge;
    GroupHoldRecovery recovery;
    assert(recovery.observe(0, 0, true) == GroupHoldResult::ready); // Entry already verified 200ms.
    assert(recovery.observe(1, 1, false) == GroupHoldResult::recovering);
    assert(recovery.observe(1.1, 1.1, true) == GroupHoldResult::recovering);
    assert(recovery.observe(1.4, 1.1, true) == GroupHoldResult::recovering); // Replaying a frame cannot prove stability.
    assert(recovery.observe(1.41, 1.29, true) == GroupHoldResult::recovering);
    assert(recovery.observe(1.42, 1.3, true) == GroupHoldResult::ready);
    assert(recovery.observe(2, 2, false) == GroupHoldResult::recovering);
    assert(recovery.observe(6.9, 6.9, true) == GroupHoldResult::recovering);
    assert(recovery.observe(7, 7, true) == GroupHoldResult::velocity_timeout);
    assert(recovery.stable_for_ms() > 99 && recovery.stable_for_ms() < 101);
    GroupHoldRecovery jitter;
    jitter.observe(0, 0, false);
    jitter.observe(4.8, 4.8, true);
    jitter.observe(4.9, 4.9, false);
    assert(jitter.observe(5, 5, true) == GroupHoldResult::velocity_timeout);
    GroupHoldRecovery late;
    late.observe(0, 0, false); late.observe(4.9, 4.9, true);
    assert(late.observe(5.1, 5.1, true) == GroupHoldResult::velocity_timeout);
    assert(late.stable_for_ms() > 99 && late.stable_for_ms() < 101);
    GroupHoldRecovery late_unstable;
    late_unstable.observe(0, 0, false); late_unstable.observe(4.9, 4.9, true);
    assert(late_unstable.observe(5.1, 5.1, false) == GroupHoldResult::velocity_timeout);
    assert(late_unstable.stable_for_ms() == 0);
    GroupHoldRecovery exact;
    exact.observe(0, 0, false); exact.observe(4.8, 4.8, true);
    assert(exact.observe(5, 5, true) == GroupHoldResult::ready);
    GroupHoldRecovery gap;
    gap.observe(0, 0, false); gap.observe(.1, .1, true);
    assert(gap.observe(1.2, 1.2, true) == GroupHoldResult::recovering);
    assert(gap.observe(1.4, 1.4, true) == GroupHoldResult::ready);
    PositionGroupTimeline timeline; timeline.last_s = 0; timeline.segment_complete(0, 3);
    timeline.hold_blocked = true; timeline.advance(1); assert(timeline.hold_remaining_s == 3);
    timeline.pause(2); timeline.advance(10); assert(timeline.hold_remaining_s == 3);
    timeline.resume(11); timeline.advance(12); assert(timeline.hold_remaining_s == 3);
    timeline.hold_blocked = false; timeline.advance(13); assert(timeline.hold_remaining_s == 2);
    assert(group_hold_position_valid({"joint4"}, {0}, {.02}));
    assert(!group_hold_position_valid({"joint4"}, {0}, {.020001}));
    assert(group_hold_position_valid({gripper_motion_joint()}, {0}, {.001}));
    assert(!group_hold_position_valid({gripper_motion_joint()}, {0}, {.001001}));
    assert(!group_hold_position_valid({"joint4"}, {0}, {NAN}));
    assert(!group_hold_position_valid({"joint4"}, {}, {0}));
    const auto failure = GroupHoldFailure{"velocity_timeout", "paused", 1000, 20, 100,
        motion_arrival_errors({"joint4"}, {.04}, {.041}, {.05})};
    const auto json = group_hold_failure_json(failure);
    assert(json.find("\"reason\":\"velocity_timeout\"") != std::string::npos);
    assert(json.find("\"target\":0.04") != std::string::npos);
    assert(json.find("\"required_stable_ms\":200") != std::string::npos);
  }
  {
    using namespace easy_debug_bridge;
    auto names = arm_motion_joints();
    std::vector<double> target(6, 0), actual(6, 0), velocity(6, 0);
    actual[3] = -.043679;
    const auto errors = motion_arrival_errors(names, target, actual, velocity);
    assert(errors[3].joint_name == "joint4" && errors[3].unit == "rad");
    assert(errors[3].position_error == -.043679 && errors[3].position_tolerance == .02);
    assert(errors[3].velocity_tolerance == .03 && errors[3].target == 0 && errors[3].actual == -.043679);
    assert(motion_arrival_json(errors).find("\"joint_name\":\"joint4\"") != std::string::npos);
    assert(motion_completion_stopped(names, actual, velocity)); // Endpoint error is diagnostic only.
    assert(!motion_target_reached(names, target, actual, velocity)); // Original drift tolerance remains.
    assert(motion_target_reached(names, actual, actual, velocity)); // Hold from measured endpoint.
    auto drifted = actual; drifted[3] += .021;
    assert(!motion_target_reached(names, actual, drifted, velocity));
    velocity[3] = .03; assert(motion_completion_stopped(names, actual, velocity));
    velocity[3] = .03001; assert(!motion_completion_stopped(names, actual, velocity));
    velocity[3] = NAN; assert(!motion_completion_stopped(names, actual, velocity));
    velocity[3] = 0; actual[3] = NAN; assert(!motion_completion_stopped(names, actual, velocity));
    auto rejects = [](auto f) { try { f(); } catch (const std::exception &) { return true; } return false; };
    assert(rejects([&] { motion_arrival_errors(names, target, actual, velocity); }));
    actual[3] = 0; target[0] = INFINITY;
    assert(rejects([&] { motion_arrival_errors(names, target, actual, velocity); }));
    target[0] = 0; names[0] = "unknown";
    assert(rejects([&] { motion_arrival_errors(names, target, actual, velocity); }));
    names[0] = "joint2";
    assert(rejects([&] { motion_arrival_errors(names, target, actual, velocity); }));
    assert(rejects([&] { motion_arrival_errors(arm_motion_joints(), {}, actual, velocity); }));
    const auto grip = motion_arrival_errors({gripper_motion_joint()}, {.02}, {.025}, {.001}).front();
    assert(grip.unit == "m" && grip.position_tolerance == .001 && grip.velocity_tolerance == .001);
    validate_arm_planning_limits(2, 2, true, true);
    for (double invalid : {0., -1., 2.00001, double(NAN), double(INFINITY)}) {
      assert(rejects([&] { validate_arm_planning_limits(invalid, 2, true, true); }));
      assert(rejects([&] { validate_arm_planning_limits(2, invalid, true, true); }));
    }
    assert(rejects([&] { validate_arm_planning_limits(2, 2, false, true); }));
    PositionMotionModel model; model.lower = std::vector<double>(6, -1); model.upper = std::vector<double>(6, 1);
    std::vector<TimedMotionPoint> path{{std::vector<double>(6, 0), std::vector<double>(6, 2), {}, {}, 0},
        {std::vector<double>(6, 1), std::vector<double>(6, 2), {}, {}, 500000000}};
    assert(stretch_motion(path, .5, model).back().velocities[0] == 2);
    path[0].velocities[0] = 2.01;
    assert(rejects([&] { stretch_motion(path, .5, model); }));
    path[0].velocities[0] = 2;
    path[0].accelerations = std::vector<double>(6, 0); path[1].accelerations = std::vector<double>(6, 0);
    path[0].accelerations[0] = 2.01;
    assert(rejects([&] { stretch_motion(path, .5, model); }));
  }
  {
    using namespace easy_debug_bridge;
    PositionMotionModel model; model.lower = std::vector<double>(6, -1); model.upper = std::vector<double>(6, 1);
    PositionGroupSpec spec{"group", "test", 2, {{"a", "A", std::vector<double>(6, 0), {}, 0, 1}, {"b", "B", std::vector<double>(6, .1), .03, 3, 2}}, true};
    validate_position_group(spec, model, true, 0, .05);
    auto rejects = [&](auto mutate) {
      auto invalid = spec; mutate(invalid); bool rejected = false;
      try { validate_position_group(invalid, model, true, 0, .05); } catch (const std::exception &) { rejected = true; }
      assert(rejected);
    };
    rejects([](auto &s) { s.steps[1].positions[5] = 2; }); // Future steps validated before preparation.
    rejects([](auto &s) { s.steps[1].gripper_position = .06; });
    rejects([](auto &s) { s.steps[0].motion_duration_s = 1; });
    rejects([](auto &s) { s.steps[1].motion_duration_s = 0; });
    rejects([](auto &s) { s.steps[1].hold_duration_s = -1; });
    rejects([](auto &s) { s.steps[1].hold_duration_s = std::numeric_limits<double>::infinity(); });
    rejects([](auto &s) { s.preparation_duration_s = std::numeric_limits<double>::quiet_NaN(); });
    rejects([](auto &s) { s.steps[1].id = "a"; });
    rejects([](auto &s) { s.steps[1].label = std::string(513, 'x'); });
    rejects([](auto &s) { s.steps.resize(101, s.steps[0]); });
    rejects([](auto &s) { s.steps.clear(); });
    rejects([](auto &s) { s.steps[0].hold_duration_s = 7 * 86400; });
    bool rejected = false;
    try { validate_position_group(spec, model, false, 0, .05); } catch (...) { rejected = true; }
    assert(rejected);
    PositionGroupTimeline t; t.last_s = 10;
    t.pause(11); assert(t.phase == "preparing" && t.pause_requested);
    t.segment_complete(12, 3); assert(t.phase == "paused" && t.elapsed_s == 0);
    t.advance(100); assert(t.elapsed_s == 0 && t.hold_remaining_s == 3);
    t.resume(101); t.advance(102); assert(t.elapsed_s == 1 && t.hold_remaining_s == 2);
    t.pause(103); assert(t.elapsed_s == 2 && t.hold_remaining_s == 1);
    t.advance(110); assert(t.elapsed_s == 2 && t.hold_remaining_s == 1);
    t.resume(111); t.advance(112); assert(t.elapsed_s == 3 && t.hold_remaining_s == 0);
    t.next(112); assert(t.index == 1 && t.phase == "moving");
    t.pause(113); assert(t.phase == "moving");
    t.segment_complete(114, 0); assert(t.phase == "paused" && t.elapsed_s == 5);
    t.resume(120); assert(t.hold_remaining_s == 0 && t.elapsed_s == 5);
  }
  {
    using easy_debug_bridge::closest_rgbd_pair;
    // Prefer the synchronized older pair over a 33ms cross-frame match; when
    // equally close, choose the most recent pair and keep input storage bounded.
    const auto exact = closest_rgbd_pair({1000000000, 1033000000}, {1000000000});
    assert(exact && exact->first == 0 && exact->second == 0);
    const auto newest = closest_rgbd_pair({1000000000, 1033000000}, {1000000000, 1033000000});
    assert(newest && newest->first == 1 && newest->second == 1);
    assert(!closest_rgbd_pair({0, -1}, {1000000000}));
    assert(!closest_rgbd_pair({1000000000}, {1050000001}));
    assert(closest_rgbd_pair({1000000000}, {1050000000}));
    assert(!closest_rgbd_pair({}, {1000000000}));
  }
  {
    using easy_debug_bridge::ControllerHealthPoll;
    using namespace std::chrono_literals;
    ControllerHealthPoll poll;
    auto now = ControllerHealthPoll::Time{};
    assert(poll.due(now));
    const auto first = poll.start(now);
    assert(poll.pending() && !poll.due(now + 10s));
    assert(!poll.expired(now + 1999ms) && poll.expired(now + 2s));
    bool duplicate_rejected = false;
    try { poll.start(now + 100ms); } catch (const std::logic_error &) { duplicate_rejected = true; }
    assert(duplicate_rejected);
    assert(poll.matches(first));
    assert(std::abs(poll.latency(now + 1300ms) - 1.3) < 1e-9);
    poll.succeeded(now + 1300ms);
    assert(!poll.matches(first));
    assert(!poll.due(now + 2299ms) && poll.due(now + 2300ms));
    now += 2300ms;
    // Persistent failures back off 1/2/4/8 seconds, without accumulating requests.
    for (const auto delay : {1s, 2s, 4s, 8s, 8s}) {
      const auto old = poll.start(now);
      now += 2s;
      assert(poll.expired(now));
      poll.failed(now);
      assert(!poll.pending() && !poll.matches(old));
      assert(!poll.due(now + delay - 1ms) && poll.due(now + delay));
      now += delay;
    }
    // Recovery restores normal scheduling; a service disappearance also backs off.
    poll.start(now); poll.succeeded(now);
    assert(!poll.due(now + 999ms) && poll.due(now + 1s));
    now += 1s;
    poll.failed(now);
    assert(!poll.due(now + 999ms) && poll.due(now + 1s));
  }
  {
    using namespace easy_debug_bridge;
    const GripperCalibration c{-.008612826752, .004282757541, 0, .05};
    auto rejects = [](auto f) { try { f(); } catch (const std::exception &) { return true; } return false; };
    assert(std::abs(calibrated_gripper_value({gripper_motion_joint()}, {.497253418}, c)) < 1e-8);
    assert(std::abs(calibrated_gripper_value({gripper_motion_joint()}, {-5.308041573}, c) - .05) < 1e-8);
    assert(std::abs(calibrated_gripper_value({gripper_motion_joint()}, {2}, c, true) - 2*c.scale) < 1e-12);
    for (const auto &invalid : {GripperCalibration{0, 0, 0, .05}, GripperCalibration{NAN, 0, 0, .05},
        GripperCalibration{1, INFINITY, 0, .05}, GripperCalibration{1, 0, -.01, .05},
        GripperCalibration{1, 0, 0, .0715}, GripperCalibration{1, 0, .05, .05}})
      assert(rejects([&] { validate_gripper_calibration(invalid); }));
    assert(rejects([&] { calibrated_gripper_value({"joint7"}, {0}, c); }));
    assert(rejects([&] { calibrated_gripper_value({gripper_motion_joint(), gripper_motion_joint()}, {0, 0}, c); }));
    assert(rejects([&] { calibrated_gripper_value({gripper_motion_joint()}, {NAN}, c); }));
    assert(!same_motion_joints({"joint1", "joint1"}, {"joint1", "joint1"}));
    const PositionMotionModel arm{std::vector<double>(6, -1), std::vector<double>(6, 1), std::vector<double>(6, 0)};
    const auto gripper = gripper_motion_model(arm, c, false);
    const auto combined = gripper_motion_model(arm, c, true);
    assert(gripper.joint_names == std::vector<std::string>{gripper_motion_joint()});
    assert(combined.joint_names.size() == 7 && combined.lower.back() == 0 && combined.upper.back() == .05);
    assert(edited_motion_target({.025}, {{gripper_motion_joint(), .04}}, gripper) == std::vector<double>{.04});
    const std::vector<double> actual{.1, .2, .3, .4, .5, .6, .025};
    const auto target = edited_motion_target(actual, {{"joint2", -.2}, {gripper_motion_joint(), .04}}, combined);
    assert((target == std::vector<double>{.1, -.2, .3, .4, .5, .6, .04}));
    assert(rejects([&] { edited_motion_target(actual, {{gripper_motion_joint(), .06}}, combined); }));
    assert(rejects([&] { edited_motion_target(actual, {{gripper_motion_joint(), NAN}}, combined); }));
    assert(rejects([&] { edited_motion_target(actual, {{gripper_motion_joint(), 0}, {gripper_motion_joint(), .01}}, combined); }));
    assert(rejects([&] { edited_motion_target(actual, {{"joint7", 0}}, combined); }));
    assert(rejects([&] { edited_motion_target(actual, {}, combined); }));
    assert(motion_target_reached(gripper.joint_names, {.025}, {.0255}, {0}));
    assert(!motion_target_reached(gripper.joint_names, {.025}, {.027}, {0}));
    assert(!motion_target_reached(gripper.joint_names, {.025}, {.025}, {.002}));
    assert(!motion_target_reached(gripper.joint_names, {NAN}, {.025}, {0}));
    assert(!motion_stopped(gripper.joint_names, {NAN}));
    const std::vector<TimedMotionPoint> path{{{0}, {0}, {0}, {}, 0}, {{.05}, {0}, {0}, {}, 10000000000}};
    assert(stretch_motion(path, 10, gripper, {.02}, {.04}).back().positions.front() == .05);
    assert(rejects([&] { stretch_motion(path, .1, gripper, {.02}, {.04}); }));
    auto malformed = path; malformed.back().velocities.push_back(0);
    assert(rejects([&] { stretch_motion(malformed, 10, gripper, {.02}, {.04}); }));
    auto overshoot = path;
    overshoot.front().velocities = {-.001};
    // Every knot and derivative limit passes, but interpolation drives past the closed stop.
    assert(rejects([&] { stretch_motion(overshoot, 10, gripper, {.02}, {.04}); }));
    overshoot.front().accelerations.clear(); overshoot.back().accelerations.clear();
    assert(rejects([&] { stretch_motion(overshoot, 10, gripper, {.02}, {.04}); }));
    malformed = path; malformed.front().velocities.clear();
    assert(rejects([&] { stretch_motion(malformed, 20, gripper, {.02}, {.04}); }));
  }
  {
    easy_debug_bridge::MotionLog log;
    log.append(1, "secret", "planning", "private target", "info");
    log.append(0, "", "health", "global warning\nwith quotes \"", "warn");
    assert(log.page(2, 0).find("private target") == std::string::npos);
    assert(log.page(1, 0).find("private target") != std::string::npos);
    assert(log.page(2, 0).find("global warning\\nwith quotes \\\"") != std::string::npos);
    assert(log.page(1, 2).find("\"motion_logs\":[]") != std::string::npos);
    for (int i = 0; i < 2100; ++i) log.append(1, "id", "feedback", "data", "info");
    assert(log.page(1, 1).find("\"motion_log_truncated\":true") != std::string::npos);
    assert(log.page(1, 1).find("\"motion_log_cursor\":310") != std::string::npos);
    assert(log.page(2, 0).find("\"motion_log_cursor\":2102") != std::string::npos);
  }
  {
    using namespace easy_debug_bridge;
    const PositionMotionModel model{{-1, -1, -1, -1, -1, -1}, {1, 1, 1, 1, 1, 1}, {0, 0, 0, 0, 0, 0}};
    assert(arm_joint_set({"joint6", "joint5", "joint4", "joint3", "joint2", "joint1"}));
    assert(!arm_joint_set({"joint1", "joint1", "joint3", "joint4", "joint5", "joint6"}));
    const auto ordered = ordered_arm_values({"joint6", "joint1", "joint2", "joint3", "joint4", "joint5"}, {6, 1, 2, 3, 4, 5});
    assert((ordered == std::vector<double>{1, 2, 3, 4, 5, 6}));
    auto rejected = [](auto operation) { try { operation(); } catch (...) { return true; } return false; };
    assert(rejected([] { ordered_arm_values({"joint1", "joint1"}, {0, 0}); }));
    assert(rejected([] { ordered_arm_values({"joint1"}, {0}); }));
    assert(rejected([&] { ordered_arm_values(arm_motion_joints(), {0, 0, NAN, 0, 0, 0}); }));
    assert(rejected([&] { ordered_arm_values(arm_motion_joints(), {0, 0, 0, 0, 0}); }));
    assert(rejected([&] { validate_position_target({0, 0, 0, 0, 0, 2}, model); }));
    assert(rejected([&] { validate_position_target({0, 0, 0, 0, 0, NAN}, model); }));
    validate_position_target(model.home, model);
    assert(position_target_reached(model.home, model.home, model.home));
    assert(!position_target_reached(model.home, {0, 0, 0, 0, 0, .03}, model.home));
    assert(!position_target_reached(model.home, model.home, {0, 0, 0, 0, 0, .1}));
    assert(!position_target_reached(model.home, model.home, {0, 0, 0, 0, 0, NAN}));
    const auto actual = std::vector<double>{.1, .2, .3, .4, .5, .6};
    assert((combined_joint_target(actual, {{"joint1", -.2}, {"joint6", -.6}}, model) ==
        std::vector<double>{-.2, .2, .3, .4, .5, -.6}));
    assert(rejected([&] { combined_joint_target(actual, {}, model); }));
    assert(rejected([&] { combined_joint_target(actual, {{"joint1", 0}, {"joint1", .1}}, model); }));
    assert(rejected([&] { combined_joint_target(actual, {{"joint7", 0}}, model); }));
    assert(rejected([&] { combined_joint_target(actual, {{"joint1", NAN}}, model); }));
    assert(rejected([&] { combined_joint_target(actual, {{"joint1", 2}}, model); }));
    for (double seconds : {double(NAN), double(INFINITY), -.1, 0., 2147483648.})
      assert(rejected([&] { validate_motion_duration(seconds); }));
    validate_motion_duration(.001); validate_motion_duration(121);
    const std::vector<TimedMotionPoint> path{
        {model.home, std::vector<double>(6, .4), std::vector<double>(6, .8), {}, 0},
        {actual, std::vector<double>(6, .4), std::vector<double>(6, .8), {}, 2000000000}};
    const auto stretched = stretch_motion(path, 4, model);
    assert(stretched.back().time_ns == 4000000000 && stretched.front().time_ns == 0);
    assert(stretched.back().positions == actual);
    assert(stretch_motion(path, 5.125, model).back().time_ns == 5125000000);
    assert(stretched.back().velocities == std::vector<double>(6, .2));
    assert(stretched.back().accelerations == std::vector<double>(6, .2));
    // Endpoint derivatives alone are insufficient: this spline exceeds the
    // limit inside the segment at its original duration.
    assert(rejected([&] { stretch_motion(path, 2, model, std::vector<double>(6, 1), std::vector<double>(6, 1)); }));
    const std::vector<TimedMotionPoint> safe_path{
        {model.home, model.home, model.home, {}, 0},
        {std::vector<double>(6,.1), model.home, model.home, {}, 2000000000}};
    assert(stretch_motion(safe_path, 1., model).back().time_ns == 1000000000);
    assert(rejected([&] { stretch_motion(safe_path, .05, model); }));
    assert(rejected([&] { stretch_motion(path, .2, model); }));
    assert(rejected([&] { stretch_motion({}, 5, model); }));
    auto invalid_path = path; invalid_path.back().time_ns = 0;
    assert(rejected([&] { stretch_motion(invalid_path, 5, model); }));
    invalid_path = path; invalid_path.back().positions[0] = NAN;
    assert(rejected([&] { stretch_motion(invalid_path, 5, model); }));
    invalid_path = path; invalid_path.back().accelerations[0] = NAN;
    assert(rejected([&] { stretch_motion(invalid_path, 5, model); }));
    invalid_path = path; invalid_path.back().velocities.pop_back();
    assert(rejected([&] { stretch_motion(invalid_path, 5, model); }));
    std::vector<std::string> claims;
    for (const auto &joint : arm_motion_joints()) claims.push_back(joint + "/position");
    assert(!arm_position_velocity_claimed(claims));
    for (const auto &joint : arm_motion_joints()) claims.push_back(joint + "/velocity");
    assert(arm_position_velocity_claimed(claims));
    claims.pop_back(); assert(!arm_position_velocity_claimed(claims));
  }

  const auto now = std::chrono::steady_clock::now();
  assert(easy_debug_bridge::should_report_rgbd_tf_failure({}, now));
  assert(!easy_debug_bridge::should_report_rgbd_tf_failure(now - std::chrono::milliseconds(300), now));
  assert(easy_debug_bridge::should_report_rgbd_tf_failure(now - std::chrono::milliseconds(500), now));
  easy_debug_bridge::ImageInterests interests;
  interests.add("/image", 1); interests.add("/image", 1); interests.add("/image", 2);
  assert(interests.clients("/image").size() == 2);
  assert(!interests.remove("/image", 1));
  assert(interests.clients("/image").count(2));
  interests.add("/other_image", 2);
  const auto empty = interests.disconnect(2);
  assert(empty.size() == 2);
  assert(interests.clients("/image").empty());
  assert(!interests.remove("/missing", 1));
  const auto resource = easy_debug_bridge::binary_resource_frame("{}", {1, 2, 3});
  assert(resource.size() == 13 && resource[2] == 'R' && resource[7] == 2 && resource[10] == 1);
  CommandFields command;
  command.mode = 1;
  command.position = 0.6;
  command.velocity = 0.2;
  command.kp = 80.0;
  command.kd = 12.0;
  command.effort = 0.5;
  command.confirmation = "ARMED";
  assert(easy_debug_bridge::validate_command(command) == CommandValidation::Ok);
  assert(easy_debug_bridge::requested_command_mask(command) == 0x01U);

  command.confirmation = "";
  assert(easy_debug_bridge::validate_command(command) == CommandValidation::NotArmed);
  command.confirmation = "ARMED";
  command.mode = 4;
  assert(easy_debug_bridge::validate_command(command) == CommandValidation::InvalidMode);
  command.mode = 1;
  command.position = std::nan("");
  assert(easy_debug_bridge::validate_command(command) == CommandValidation::NonFinite);
  command.position = 0.0;
  command.effort = 1.01;
  assert(easy_debug_bridge::validate_command(command) == CommandValidation::EffortLimit);
  command.effort = 0.5;
  command.mask_specified = true;
  command.requested_joint_mask = 0;
  assert(easy_debug_bridge::validate_command(command) == CommandValidation::EmptyJointMask);
  command.requested_joint_mask = 0x05U;
  command.positions = {0.1, 0.0, 0.2};
  assert(easy_debug_bridge::validate_command(command) == CommandValidation::Ok);
  command.positions[1] = std::nan("");
  assert(easy_debug_bridge::validate_command(command) == CommandValidation::NonFinite);
  command.positions[1] = 0.0;

  assert(easy_debug_bridge::resolve_command_mask(0x01U, 0x01U) == 0x01U);
  assert(easy_debug_bridge::resolve_command_mask(0x05U, 0x01U) == 0);
  assert(easy_debug_bridge::resolve_command_mask(0x05U, 0x07U) == 0x05U);
  assert(easy_debug_bridge::resolve_command_mask(0U, 0xFFU) == 0);

  double position[4] = {9, 9, 9, 9};
  double velocity[4] = {9, 9, 9, 9};
  double kp[4] = {9, 9, 9, 9};
  double kd[4] = {9, 9, 9, 9};
  double effort[4] = {9, 9, 9, 9};
  easy_debug_bridge::fill_joint_command_channels(
      0x05U, command, 4, position, velocity, kp, kd, effort);
  assert(position[0] == 0.1 && position[1] == 0.0 && position[2] == 0.2 && position[3] == 0.0);
  assert(velocity[0] == 0.2 && velocity[1] == 0.0 && velocity[2] == 0.2 && velocity[3] == 0.0);
  assert(kp[0] == 80.0 && kp[2] == 80.0 && kp[1] == 0.0);
  assert(kd[0] == 12.0 && effort[0] == 0.5 && effort[1] == 0.0);

  CommandFields legacy;
  legacy.mode = 1;
  legacy.position = 0.35;
  legacy.velocity = 0.0;
  legacy.kp = 8.0;
  legacy.kd = 2.0;
  legacy.effort = 0.0;
  legacy.confirmation = "ARMED";
  double legacy_position[2] = {};
  double legacy_velocity[2] = {};
  double legacy_kp[2] = {};
  double legacy_kd[2] = {};
  double legacy_effort[2] = {};
  easy_debug_bridge::fill_joint_command_channels(
      0x01U, legacy, 2, legacy_position, legacy_velocity, legacy_kp, legacy_kd, legacy_effort);
  assert(legacy_position[0] == 0.35 && legacy_position[1] == 0.0);
  assert(legacy_kp[0] == 8.0 && legacy_kp[1] == 0.0);

  uint32_t sequence = 41;
  const auto track = easy_debug_bridge::allocate_sequences(sequence, 1);
  assert((track == std::vector<uint32_t>{42}));
  const auto disable = easy_debug_bridge::allocate_sequences(sequence, 3);
  assert((disable == std::vector<uint32_t>{43, 44, 45}));
  assert(sequence == 45);

  assert(easy_debug_bridge::fully_qualified_node_name("/", "controller_manager") ==
         "/controller_manager");
  assert(easy_debug_bridge::fully_qualified_node_name("/robot", "driver") ==
         "/robot/driver");
  assert(easy_debug_bridge::fully_qualified_node_name("robot", "driver") ==
         "/robot/driver");
  assert(easy_debug_bridge::is_valid_graph_name("/stm32/joint_commands"));
  assert(easy_debug_bridge::is_valid_graph_name("/arm/follow_joint_trajectory/_action/status"));
  assert(!easy_debug_bridge::is_valid_graph_name("stm32/joint_commands"));
  assert(!easy_debug_bridge::is_valid_graph_name("/stm32//status"));
  assert(!easy_debug_bridge::is_valid_graph_name("/stm32/status/"));
  assert(!easy_debug_bridge::is_valid_graph_name("/stm32/status;rm"));
  assert(easy_debug_bridge::is_robot_description_topic("/robot_description"));
  assert(easy_debug_bridge::is_robot_description_topic("/arm/robot_description"));
  assert(!easy_debug_bridge::is_robot_description_topic("/robot_description_semantic"));
  assert(!easy_debug_bridge::is_robot_description_topic("/debug/robot_description_copy"));

  const std::filesystem::path package_root("/opt/robot/share/rebotarm_gazebo");
  assert(easy_debug_bridge::package_resource_path(package_root, "meshes/base_link.STL") ==
         package_root / "meshes/base_link.STL");
  assert(easy_debug_bridge::package_resource_path(package_root, "meshes/../textures/base.png") ==
         package_root / "textures/base.png");
  assert(!easy_debug_bridge::package_resource_path(package_root, "../secret.txt"));
  assert(!easy_debug_bridge::package_resource_path(package_root, "/etc/passwd"));
  assert(!easy_debug_bridge::package_resource_path(package_root, "."));

  using easy_debug_bridge::TrajectoryCommand;
  using easy_debug_bridge::TrajectoryPointSpec;
  using easy_debug_bridge::TrajectoryValidation;

  assert(easy_debug_bridge::is_trajectory_topic("/arm/trajectory_controller/joint_trajectory"));
  assert(easy_debug_bridge::is_trajectory_topic("/joint_trajectory"));
  assert(!easy_debug_bridge::is_trajectory_topic("/arm/trajectory_controller/joint_trajectory/"));
  assert(!easy_debug_bridge::is_trajectory_topic("arm/joint_trajectory"));
  assert(!easy_debug_bridge::is_trajectory_topic("/arm//joint_trajectory"));
  assert(!easy_debug_bridge::is_trajectory_topic("/arm/joint trajectory"));
  assert(!easy_debug_bridge::is_trajectory_topic("/stm32/joint_commands"));

  TrajectoryCommand trajectory;
  trajectory.topic = "/arm/trajectory_controller/joint_trajectory";
  trajectory.joint_names = {"joint1", "joint2"};
  trajectory.points = {{ {0.1, 0.2}, {}, 0.1 }, { {0.3, 0.4}, {0.0, 0.0}, 0.5 }};
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::Ok);
  assert(easy_debug_bridge::trajectory_validation_message(TrajectoryValidation::Ok).empty());

  trajectory.topic = "/stm32/joint_commands";
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::InvalidTopic);
  trajectory.topic = "/arm/trajectory_controller/joint_trajectory";

  trajectory.joint_names.clear();
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::EmptyJoints);
  trajectory.joint_names.assign(33, "joint");
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::TooManyJoints);
  trajectory.joint_names = {"joint1", "joint2"};
  trajectory.joint_names[1] = "joint 2";
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::InvalidJointName);
  trajectory.joint_names = {"joint1", "joint1"};
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::DuplicateJointName);
  trajectory.joint_names = {"joint1", "joint2"};

  const auto points = trajectory.points;
  trajectory.points.clear();
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::EmptyPoints);
  trajectory.points.assign(65, TrajectoryPointSpec{{0.0, 0.0}, {}, 1.0});
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::TooManyPoints);

  trajectory.points = {{ {0.1}, {}, 0.1 }, { {0.3, 0.4}, {}, 0.5 }};
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::SizeMismatch);
  trajectory.points = {{ {0.1, 0.2}, {0.0}, 0.1 }, { {0.3, 0.4}, {}, 0.5 }};
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::SizeMismatch);

  trajectory.points = {{ {0.1, std::nan("")}, {}, 0.1 }, { {0.3, 0.4}, {}, 0.5 }};
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::NonFinite);
  trajectory.points = {{ {0.1, 0.2}, {}, 0.0 }, { {0.3, 0.4}, {}, 0.5 }};
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::NonPositiveTime);
  trajectory.points = {{ {0.1, 0.2}, {}, 0.4 }, { {0.3, 0.4}, {}, 0.4 }};
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::NonMonotonicTime);

  trajectory.points = points;
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::Ok);
  assert(!easy_debug_bridge::trajectory_validation_message(TrajectoryValidation::SizeMismatch).empty());
  assert(!easy_debug_bridge::trajectory_validation_message(TrajectoryValidation::NonMonotonicTime).empty());

  const auto lead = easy_debug_bridge::duration_fields(0.1);
  assert(lead.first == 0 && lead.second == 100000000);
  const auto total = easy_debug_bridge::duration_fields(1.25);
  assert(total.first == 1 && total.second == 250000000);

  assert(easy_debug_bridge::base64_encode({}) == "");
  assert(easy_debug_bridge::base64_encode({1, 2, 3}) == "AQID");
  assert(easy_debug_bridge::base64_encode({255, 0, 128, 64}) == "/wCAQA==");
  const auto image_frame = easy_debug_bridge::binary_image_frame("{\"width\":2}", {1, 2, 3});
  assert(std::string(image_frame.begin(), image_frame.begin() + 4) == "RCI1");
  assert(image_frame[4] == 0 && image_frame[5] == 0 && image_frame[6] == 0 && image_frame[7] == 11);
  assert(std::string(image_frame.begin() + 8, image_frame.begin() + 19) == "{\"width\":2}");
  assert((std::vector<uint8_t>(image_frame.begin() + 19, image_frame.end()) ==
          std::vector<uint8_t>{1, 2, 3}));
  sequence = UINT32_MAX;
  const auto wrapped = easy_debug_bridge::allocate_sequences(sequence, 1);
  assert(wrapped.front() == 0);

  {
    using easy_debug_bridge::GravityIdGoalFields;
    using easy_debug_bridge::GravityIdGoalValidation;
    GravityIdGoalFields goal;
    goal.confirmation = "ARMED";
    assert(easy_debug_bridge::validate_gravity_id_goal(goal) == GravityIdGoalValidation::Ok);
    assert(easy_debug_bridge::gravity_id_effective_mask(0) == 0x3Fu);
    assert(easy_debug_bridge::gravity_id_effective_mask(0x15) == 0x15u);
    goal.confirmation = "";
    assert(easy_debug_bridge::validate_gravity_id_goal(goal) == GravityIdGoalValidation::NotArmed);
    goal.confirmation = "ARMED";
    goal.mode = 9;
    assert(easy_debug_bridge::validate_gravity_id_goal(goal) == GravityIdGoalValidation::InvalidMode);
    goal.mode = 1;
    assert(easy_debug_bridge::validate_gravity_id_goal(goal) == GravityIdGoalValidation::PayloadRejected);
    goal.mode = 0;
    goal.settle_time_s = std::nan("");
    assert(easy_debug_bridge::validate_gravity_id_goal(goal) == GravityIdGoalValidation::NonFinite);
    goal.settle_time_s = 1.0;
    goal.max_effort_nm = -0.1;
    assert(easy_debug_bridge::validate_gravity_id_goal(goal) == GravityIdGoalValidation::Negative);
    assert(!easy_debug_bridge::gravity_id_goal_validation_message(GravityIdGoalValidation::NotArmed).empty());
  }


  {
    const auto frame = easy_debug_bridge::binary_rgbd_frame("{}", {9, 8, 7});
    assert(frame.size() == 13 && frame[2] == 'D' && frame[10] == 9);
    assert(easy_debug_bridge::bytes_per_pixel("rgb8") == 3);
    assert(easy_debug_bridge::bytes_per_pixel("16UC1") == 2);
    assert(easy_debug_bridge::bytes_per_pixel("32FC1") == 4);
    assert(easy_debug_bridge::stamps_within_tolerance(1, 0, 1, 40'000'000, 50'000'000));
    assert(!easy_debug_bridge::stamps_within_tolerance(1, 0, 1, 60'000'000, 50'000'000));
    const auto size = easy_debug_bridge::choose_preview_size(640, 480, 320, 240);
    assert(size.width == 320 && size.height == 240);
    double k[9] = {200, 0, 100, 0, 200, 50, 0, 0, 1};
    const auto sk = easy_debug_bridge::scale_intrinsics(k, 640, 480, 320, 240);
    assert(std::abs(sk[0] - 100.0) < 1e-9);
    assert(std::abs(sk[2] - 50.0) < 1e-9);
    // 2x2 rgb8 → 1x1 nearest
    const uint8_t src[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12};
    const auto ds = easy_debug_bridge::downsample_image_nn(
        src, sizeof(src), 2, 2, 6, "rgb8", 0, 1, 1);
    assert(ds && ds->width == 1 && ds->height == 1 && ds->data.size() == 3);
    assert(ds->data[0] == 1 && ds->data[1] == 2 && ds->data[2] == 3);
    // Truncated buffer: step ok but nbytes < h*step → reject (no OOB)
    const auto truncated = easy_debug_bridge::downsample_image_nn(
        src, 6, 2, 2, 6, "rgb8", 0, 1, 1);
    assert(!truncated);
    easy_debug_bridge::LatestFrameGroupQueue<int> queue;
    queue.push(1);
    queue.push(2);
    assert(queue.dropped_count() == 1);
    const auto taken = queue.take();
    assert(taken && *taken == 2);
  }

  return 0;
}
