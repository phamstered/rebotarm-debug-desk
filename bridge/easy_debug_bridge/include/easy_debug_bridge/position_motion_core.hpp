#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <map>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace easy_debug_bridge {
inline std::string position_json_quote(const std::string &value) {
  std::ostringstream out;
  out << '"';
  for (unsigned char c : value) {
    switch (c) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\b': out << "\\b"; break;
      case '\f': out << "\\f"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (c < 0x20) {
          out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<int>(c)
              << std::dec;
        } else {
          out << c;
        }
    }
  }
  out << '"';
  return out.str();
}

inline const std::vector<std::string> &arm_motion_joints() {
  static const std::vector<std::string> names{"joint1", "joint2", "joint3", "joint4", "joint5", "joint6"};
  return names;
}
inline bool arm_joint_set(const std::vector<std::string> &names) {
  auto sorted = names;
  std::sort(sorted.begin(), sorted.end());
  return sorted == arm_motion_joints();
}
inline bool arm_position_velocity_claimed(const std::vector<std::string> &interfaces) {
  for (const auto &joint : arm_motion_joints())
    for (const auto &type : {"position", "velocity"})
      if (std::find(interfaces.begin(), interfaces.end(), joint + "/" + type) == interfaces.end()) return false;
  return true;
}
// A new MoveIt trajectory starts at measured state at t=0. Do not accept it
// while the controller still holds a substantially different reference.
inline void validate_position_start(const std::vector<double> &reference,
                                    const std::vector<double> &reference_velocity,
                                    const std::vector<double> &actual) {
  if (reference.size() != 6 || reference_velocity.size() != 6 || actual.size() != 6)
    throw std::runtime_error("轨迹控制器起点参考不完整");
  for (size_t i = 0; i < 6; ++i) {
    if (!std::isfinite(reference[i]) || !std::isfinite(reference_velocity[i]) || !std::isfinite(actual[i]))
      throw std::runtime_error("轨迹控制器起点参考包含非有限值");
    if (std::abs(reference_velocity[i]) > 0.01)
      throw std::runtime_error("轨迹控制器参考尚未停稳：" + arm_motion_joints()[i]);
    if (std::abs(reference[i] - actual[i]) > 0.005) {
      std::ostringstream message;
      message << "启动连续性检查失败：" << arm_motion_joints()[i] << " 保持参考与实际位置偏差 "
              << std::fixed << std::setprecision(4) << std::abs(reference[i] - actual[i])
              << " rad > 0.005 rad；请检查低速跟踪/重力补偿后重试";
      throw std::runtime_error(message.str());
    }
  }
}
inline std::vector<double> ordered_arm_values(const std::vector<std::string> &names,
                                             const std::vector<double> &values) {
  if (names.size() != values.size()) throw std::runtime_error("关节反馈数组长度不匹配");
  std::map<std::string, double> by_name;
  for (size_t i = 0; i < names.size(); ++i) {
    if (!std::isfinite(values[i]) || !by_name.emplace(names[i], values[i]).second)
      throw std::runtime_error("关节数据包含重复名称或非有限数值");
  }
  std::vector<double> result;
  for (const auto &name : arm_motion_joints()) {
    if (!by_name.count(name)) throw std::runtime_error("关节反馈不完整：" + name);
    result.push_back(by_name.at(name));
  }
  return result;
}
struct PositionMotionModel {
  std::vector<double> lower, upper, home;
};
inline void validate_position_target(const std::vector<double> &values, const PositionMotionModel &model) {
  if (values.size() != 6 || model.lower.size() != 6 || model.upper.size() != 6)
    throw std::runtime_error("目标必须包含六个关节");
  for (size_t i = 0; i < 6; ++i) {
    if (!std::isfinite(values[i]) || values[i] < model.lower[i] || values[i] > model.upper[i])
      throw std::runtime_error("目标超过限位或不是有限值：" + arm_motion_joints()[i]);
  }
}
inline bool position_target_reached(const std::vector<double> &target, const std::vector<double> &actual,
                                    const std::vector<double> &velocity) {
  if (target.size() != 6 || actual.size() != 6 || velocity.size() != 6) return false;
  for (size_t i = 0; i < 6; ++i) if (!std::isfinite(actual[i]) || !std::isfinite(velocity[i])
      || std::abs(actual[i] - target[i]) > 0.02 || std::abs(velocity[i]) > 0.03) return false;
  return true;
}
}  // namespace easy_debug_bridge
