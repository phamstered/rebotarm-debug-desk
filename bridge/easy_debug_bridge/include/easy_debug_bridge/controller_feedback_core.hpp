#pragma once
#include "gripper_motion_core.hpp"
#include <cstdint>
#include <iomanip>
#include <sstream>

namespace easy_debug_bridge {
// Broadcaster timestamps use the controller host clock, independently of MCU clock health.
inline bool broadcaster_stamp_fresh(int32_t sec, uint32_t nanosec, int64_t now_ns) {
  if (sec < 0 || nanosec >= 1000000000u || (sec == 0 && nanosec == 0) || now_ns < 0) return false;
  const int64_t stamp = int64_t(sec) * 1000000000LL + nanosec;
  return stamp - now_ns <= 50000000LL && now_ns - stamp < 1000000000LL;
}

// Both inputs are already in ros2_control units (rad for arm, m for gripper).
inline std::string controller_feedback_consistency(
    const std::vector<std::string> &wanted,
    const std::vector<std::string> &broadcaster_names, const std::vector<double> &broadcaster_positions,
    const std::vector<std::string> &controller_names, const std::vector<double> &controller_positions,
    double tolerance, const std::string &unit) {
  try {
    const auto broadcast = ordered_motion_values(wanted, broadcaster_names, broadcaster_positions);
    const auto actual = ordered_motion_values(wanted, controller_names, controller_positions);
    for (size_t i = 0; i < wanted.size(); ++i) {
      if (std::abs(actual[i] - broadcast[i]) <= tolerance) continue;
      std::ostringstream detail;
      detail << "JTC actual 与 JointState Broadcaster /joint_states 不一致：" << wanted[i]
             << "，差值=" << std::setprecision(6) << actual[i] - broadcast[i] << ' ' << unit;
      return detail.str();
    }
  } catch (const std::exception &e) {
    return std::string("JointState Broadcaster /joint_states 或 JTC actual 反馈无效：") + e.what();
  }
  return "";
}
}
