#pragma once
#include "easy_debug_bridge/position_motion_core.hpp"
#include "easy_debug_bridge/motion_timing.hpp"
#include <optional>
#include "easy_debug_bridge/capture_core.hpp"
#include <set>

namespace easy_debug_bridge {
struct PositionGroupStep {
  std::string id, label;
  std::vector<double> positions;
  std::optional<double> gripper_position;
  double motion_duration_s{}, hold_duration_s{};
  std::vector<CaptureSpec> captures;
};
struct PositionGroupSpec {
  std::string id, label;
  double preparation_duration_s{};
  std::vector<PositionGroupStep> steps;
  bool uses_gripper{false};
};
inline void validate_position_group(const PositionGroupSpec &spec, const PositionMotionModel &model,
    bool gripper_supported, double gripper_lower, double gripper_upper) {
  if (spec.id.empty() || spec.id.size() > 128 || spec.label.empty() || spec.label.size() > 512)
    throw std::runtime_error("动作组名称或 id 无效");
  validate_motion_duration(spec.preparation_duration_s);
  if (spec.steps.empty() || spec.steps.size() > 100) throw std::runtime_error("动作组须包含 1–100 个步骤");
  double total = spec.preparation_duration_s;
  std::set<std::string> ids;
  size_t capture_count = 0;
  for (size_t i = 0; i < spec.steps.size(); ++i) {
    const auto &step = spec.steps[i];
    if (step.id.empty() || step.id.size() > 128 || !ids.insert(step.id).second || step.label.empty() || step.label.size() > 512)
      throw std::runtime_error("动作组步骤名称或 id 无效/重复");
    validate_position_target(step.positions, model);
    if (step.gripper_position && (!gripper_supported || !std::isfinite(*step.gripper_position)
        || !std::isfinite(gripper_lower) || !std::isfinite(gripper_upper) || gripper_lower > gripper_upper
        || *step.gripper_position < gripper_lower || *step.gripper_position > gripper_upper))
      throw std::runtime_error("动作组夹爪目标缺少有效模型或超过标定行程");
    if (i == 0) {
      if (step.motion_duration_s != 0) throw std::runtime_error("动作组首项 motion_duration_s 必须为 0");
    } else validate_motion_duration(step.motion_duration_s);
    if (!std::isfinite(step.hold_duration_s) || step.hold_duration_s < 0) throw std::runtime_error("动作组停留时长无效");
    capture_count += step.captures.size();
    if (capture_count > 100) throw std::runtime_error("拍照 Action 过多");
    for (const auto &capture : step.captures) {
      validate_capture(capture);
      if (!ids.insert(capture.id).second) throw std::runtime_error("Action ID 重复");
      total += capture.timeout_s;
    }
    total += step.motion_duration_s + step.hold_duration_s;
    if (!std::isfinite(total) || total > 7 * 86400) throw std::runtime_error("动作组总时长超过 7 天");
  }
}

// Seconds are supplied by the executor's steady clock, never by source stamps
// or desktop wall time. Preparing does not contribute to the group timeline.
struct PositionGroupTimeline {
  size_t index{0};
  std::string phase{"preparing"};
  bool started{false}, pause_requested{false};
  bool hold_blocked{false};
  double elapsed_s{}, hold_remaining_s{}, last_s{};
  void advance(double now) {
    const double delta = std::max(0., now - last_s);
    if (started && phase != "paused") elapsed_s += delta;
    if (phase == "holding" && !hold_blocked) hold_remaining_s = std::max(0., hold_remaining_s - delta);
    last_s = now;
  }
  void segment_complete(double now, double hold) {
    advance(now); started = true; hold_remaining_s = hold; hold_blocked = false;
    phase = pause_requested ? "paused" : "holding";
  }
  void pause(double now) {
    advance(now); pause_requested = true;
    if (phase == "holding") phase = "paused";
  }
  void resume(double now) {
    advance(now); pause_requested = false;
    if (phase == "paused") phase = "holding";
  }
  void next(double now) { advance(now); ++index; phase = "moving"; }
};
}
