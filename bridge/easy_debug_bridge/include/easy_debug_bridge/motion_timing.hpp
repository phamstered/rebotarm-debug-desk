#pragma once
#include "easy_debug_bridge/position_motion_core.hpp"
#include <cstdint>

namespace easy_debug_bridge {
inline void validate_motion_duration(double seconds) {
  if (!std::isfinite(seconds) || seconds < .1 || seconds > 120)
    throw std::runtime_error("运动时长须为 0.1–120 秒");
}
struct TimedMotionPoint {
  std::vector<double> positions, velocities, accelerations, effort;
  int64_t time_ns{};
};
// Preserve the collision-checked path, and only slow the safe MoveIt timing.
inline std::vector<TimedMotionPoint> stretch_motion(std::vector<TimedMotionPoint> points,
    double seconds, const PositionMotionModel &model) {
  validate_motion_duration(seconds);
  if (points.size() < 2 || points.size() > 10000) throw std::runtime_error("规划轨迹点数无效");
  int64_t previous = -1;
  for (const auto &point : points) {
    validate_position_target(point.positions, model);
    for (const auto *values : {&point.velocities, &point.accelerations, &point.effort})
      if ((!values->empty() && values->size() != 6) ||
          !std::all_of(values->begin(), values->end(), [](double v) { return std::isfinite(v); }))
        throw std::runtime_error("规划轨迹速度/加速度/力矩数组无效");
    if (point.time_ns < 0 || point.time_ns <= previous) throw std::runtime_error("规划轨迹时间必须递增");
    previous = point.time_ns;
  }
  const auto target_ns = static_cast<int64_t>(std::llround(seconds * 1e9));
  if (previous <= 0) throw std::runtime_error("规划轨迹时长无效");
  if (target_ns < previous) {
    std::ostringstream message;
    message << "指定运动时长过短，安全规划至少需要 " << std::fixed << std::setprecision(3)
            << previous / 1e9 << " 秒；请增加运动时长";
    throw std::runtime_error(message.str());
  }
  const double scale = static_cast<double>(target_ns) / previous;
  previous = -1;
  for (auto &point : points) {
    point.time_ns = static_cast<int64_t>(std::llround(point.time_ns * scale));
    if (point.time_ns <= previous) throw std::runtime_error("调整后的轨迹时间无效");
    previous = point.time_ns;
    for (auto &v : point.velocities) v /= scale;
    for (auto &a : point.accelerations) a /= scale * scale;
  }
  points.back().time_ns = target_ns;
  return points;
}
inline std::vector<double> combined_joint_target(const std::vector<double> &actual,
    const std::vector<std::pair<std::string, double>> &edits, const PositionMotionModel &model) {
  validate_position_target(actual, model);
  if (edits.empty() || edits.size() > 6) throw std::runtime_error("请指定 1–6 个关节目标");
  auto target = actual;
  std::vector<std::string> names;
  for (const auto &edit : edits) {
    if (std::find(names.begin(), names.end(), edit.first) != names.end()) throw std::runtime_error("关节目标名称重复");
    names.push_back(edit.first);
    target[arm_joint_index(edit.first)] = edit.second;
  }
  validate_position_target(target, model);
  return target;
}
}  // namespace easy_debug_bridge
