#pragma once
#include "easy_debug_bridge/gripper_motion_core.hpp"
#include <set>

namespace easy_debug_bridge {
struct MotionArrivalError {
  std::string joint_name;
  double target{}, actual{}, position_error{}, position_tolerance{}, velocity{}, velocity_tolerance{};
  std::string unit;
};
inline std::vector<MotionArrivalError> motion_arrival_errors(const std::vector<std::string> &names,
    const std::vector<double> &target, const std::vector<double> &actual, const std::vector<double> &velocity) {
  if (names.empty() || names.size() != target.size() || names.size() != actual.size() || names.size() != velocity.size())
    throw std::runtime_error("到位诊断关节数组不完整");
  std::set<std::string> seen;
  std::vector<MotionArrivalError> result;
  for (size_t i = 0; i < names.size(); ++i) {
    const bool gripper = names[i] == gripper_motion_joint();
    if ((!gripper && std::find(arm_motion_joints().begin(), arm_motion_joints().end(), names[i]) == arm_motion_joints().end()) ||
        !seen.insert(names[i]).second || !std::isfinite(target[i]) || !std::isfinite(actual[i]) || !std::isfinite(velocity[i]) ||
        !std::isfinite(actual[i] - target[i])) throw std::runtime_error("到位诊断包含未知/重复关节或非有限值");
    result.push_back({names[i], target[i], actual[i], actual[i] - target[i], gripper ? .001 : .02,
                      velocity[i], motion_stop_velocity(names[i]), gripper ? "m" : "rad"});
  }
  return result;
}
inline std::string motion_arrival_json(const std::vector<MotionArrivalError> &errors) {
  std::ostringstream out; out << '[' << std::setprecision(17);
  for (size_t i = 0; i < errors.size(); ++i) {
    if (i) out << ',';
    const auto &e = errors[i];
    out << "{\"joint_name\":" << position_json_quote(e.joint_name) << ",\"target\":" << e.target << ",\"actual\":" << e.actual
        << ",\"position_error\":" << e.position_error << ",\"position_tolerance\":" << e.position_tolerance
        << ",\"velocity\":" << e.velocity << ",\"velocity_tolerance\":" << e.velocity_tolerance
        << ",\"unit\":" << position_json_quote(e.unit) << '}';
  }
  return out.str() + ']';
}
// Only the joint endpoint error is diagnostic. Pose constraints and fresh,
// finite feedback, hardware/clock/controller gates remain with the caller.
inline bool motion_completion_stopped(const std::vector<std::string> &names,
    const std::vector<double> &actual, const std::vector<double> &velocity) {
  return actual.size() == names.size() && std::all_of(actual.begin(), actual.end(), [](double value) { return std::isfinite(value); }) &&
      motion_stopped(names, velocity);
}
inline void validate_arm_planning_limits(double velocity, double acceleration, bool velocity_enabled, bool acceleration_enabled) {
  if (!std::isfinite(velocity) || velocity <= 0 || velocity > 2 || !std::isfinite(acceleration) || acceleration <= 0 || acceleration > 2 ||
      !velocity_enabled || !acceleration_enabled)
    throw std::runtime_error("MoveIt 必须启用不超过 2 rad/s、2 rad/s² 的速度/加速度限幅，请使用 real_move_group.launch.py");
}
}
