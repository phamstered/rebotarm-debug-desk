#pragma once
#include "position_motion_core.hpp"

namespace easy_debug_bridge {
inline const std::string &gripper_motion_joint() {
  static const std::string name = "gripper_finger_left_joint";
  return name;
}
struct GripperCalibration {
  double scale{}, offset{}, lower{}, upper{};
};
inline void validate_gripper_calibration(const GripperCalibration &c) {
  if (!std::isfinite(c.scale) || std::abs(c.scale) < 1e-12 || !std::isfinite(c.offset) ||
      !std::isfinite(c.lower) || !std::isfinite(c.upper) || c.lower < 0 || c.lower >= c.upper || c.upper > .05)
    throw std::runtime_error("夹爪标定参数或有效行程无效");
}
inline std::vector<double> ordered_motion_values(const std::vector<std::string> &wanted,
    const std::vector<std::string> &names, const std::vector<double> &values) {
  if (names.size() != values.size()) throw std::runtime_error("关节反馈数组长度不匹配");
  std::map<std::string, double> by_name;
  for (size_t i = 0; i < names.size(); ++i)
    if (!std::isfinite(values[i]) || !by_name.emplace(names[i], values[i]).second)
      throw std::runtime_error("关节反馈名称重复或数值无效");
  std::vector<double> result;
  for (const auto &name : wanted) {
    if (!by_name.count(name)) throw std::runtime_error("关节反馈不完整：" + name);
    result.push_back(by_name.at(name));
  }
  return result;
}
inline double calibrated_gripper_value(const std::vector<std::string> &names,
    const std::vector<double> &values, const GripperCalibration &c, bool velocity = false) {
  validate_gripper_calibration(c);
  const auto raw = ordered_motion_values({gripper_motion_joint()}, names, values).front();
  const auto result = raw * c.scale + (velocity ? 0 : c.offset);
  if (!std::isfinite(result)) throw std::runtime_error("夹爪标定反馈无效");
  if (!velocity && result >= c.lower - 1e-8 && result <= c.upper + 1e-8)
    return std::max(c.lower, std::min(c.upper, result));
  return result;
}
inline bool same_motion_joints(std::vector<std::string> a, std::vector<std::string> b) {
  std::sort(a.begin(), a.end()); std::sort(b.begin(), b.end());
  return a == b && std::adjacent_find(a.begin(), a.end()) == a.end();
}
inline double motion_goal_tolerance(const std::string &name) {
  return name == gripper_motion_joint() ? .0005 : .005;
}
inline double motion_hold_tolerance(const std::string &name) {
  return name == gripper_motion_joint() ? .0001 : joint_rotation_hold_tolerance;
}
inline double motion_stop_velocity(const std::string &name) {
  return name == gripper_motion_joint() ? .001 : .03;
}
inline bool motion_stopped(const std::vector<std::string> &names, const std::vector<double> &velocity) {
  if (names.empty() || velocity.size() != names.size()) return false;
  for (size_t i = 0; i < names.size(); ++i)
    if (!std::isfinite(velocity[i]) || std::abs(velocity[i]) > motion_stop_velocity(names[i])) return false;
  return true;
}
inline bool motion_target_reached(const std::vector<std::string> &names, const std::vector<double> &target,
    const std::vector<double> &actual, const std::vector<double> &velocity) {
  if (!motion_stopped(names, velocity) || actual.size() != names.size() || target.size() != names.size()) return false;
  for (size_t i = 0; i < names.size(); ++i)
    if (!std::isfinite(actual[i]) || !std::isfinite(target[i]) ||
        std::abs(actual[i] - target[i]) > (names[i] == gripper_motion_joint() ? .001 : .02)) return false;
  return true;
}
inline PositionMotionModel gripper_motion_model(const PositionMotionModel &arm,
    const GripperCalibration &c, bool arm_included) {
  validate_gripper_calibration(c);
  PositionMotionModel result = arm_included ? arm : PositionMotionModel{{}, {}, {}, {}};
  result.joint_names.push_back(gripper_motion_joint()); result.lower.push_back(c.lower); result.upper.push_back(c.upper);
  return result;
}
inline std::vector<double> edited_motion_target(const std::vector<double> &actual,
    const std::vector<std::pair<std::string, double>> &edits, const PositionMotionModel &model) {
  validate_position_target(actual, model);
  if (edits.empty() || edits.size() > model.joint_names.size()) throw std::runtime_error("关节目标数量无效");
  auto target = actual;
  std::vector<std::string> seen;
  for (const auto &edit : edits) {
    const auto found = std::find(model.joint_names.begin(), model.joint_names.end(), edit.first);
    if (found == model.joint_names.end() || std::find(seen.begin(), seen.end(), edit.first) != seen.end())
      throw std::runtime_error("关节目标名称无效或重复：" + edit.first);
    seen.push_back(edit.first); target[found - model.joint_names.begin()] = edit.second;
  }
  validate_position_target(target, model);
  return target;
}
}
