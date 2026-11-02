#pragma once
#include "easy_debug_bridge/position_group_core.hpp"
#include <boost/property_tree/ptree.hpp>

namespace easy_debug_bridge {
inline void validate_group_tree(const boost::property_tree::ptree &tree, size_t &bytes, size_t depth = 0) {
  if (depth > 8) throw std::runtime_error("动作组字段嵌套过深");
  bytes += tree.data().size() + 8;
  if (bytes > 256 * 1024) throw std::runtime_error("动作组请求超过 256 KiB");
  for (const auto &child : tree) {
    bytes += child.first.size();
    validate_group_tree(child.second, bytes, depth + 1);
  }
}
inline void group_fields(const boost::property_tree::ptree &tree, const std::set<std::string> &allowed) {
  std::set<std::string> seen;
  if (!tree.data().empty()) throw std::runtime_error("动作组字段必须为对象");
  for (const auto &child : tree)
    if (!allowed.count(child.first) || !seen.insert(child.first).second)
      throw std::runtime_error("动作组包含未知或重复字段：" + child.first);
}
inline std::string group_string(const boost::property_tree::ptree &tree, const std::string &key, size_t limit) {
  const auto &field = tree.get_child(key);
  if (!field.empty() || field.data().empty() || field.data().size() > limit)
    throw std::runtime_error("动作组 " + key + " 为空或过长");
  return field.data();
}
inline double group_number(const boost::property_tree::ptree &tree, const std::string &key) {
  const auto &field = tree.get_child(key);
  if (!field.empty() || field.data().empty()) throw std::runtime_error("动作组 " + key + " 必须为数值");
  const auto value = field.get_value<double>();
  if (!std::isfinite(value)) throw std::runtime_error("动作组 " + key + " 必须为有限数值");
  return value;
}
inline PositionGroupSpec read_position_group(const boost::property_tree::ptree &tree,
    const PositionMotionModel &model, bool gripper_supported, double gripper_lower, double gripper_upper) {
  size_t bytes = 0; validate_group_tree(tree, bytes);
  group_fields(tree, {"op", "request_id", "command_id", "confirmation", "group_id", "label", "preparation_duration_s", "steps"});
  PositionGroupSpec spec;
  spec.id = group_string(tree, "group_id", 128); spec.label = group_string(tree, "label", 512);
  spec.preparation_duration_s = group_number(tree, "preparation_duration_s");
  validate_motion_duration(spec.preparation_duration_s);
  const auto &steps = tree.get_child("steps");
  if (!steps.data().empty() || steps.empty() || steps.size() > 100) throw std::runtime_error("动作组须包含 1–100 个步骤");
  double total = spec.preparation_duration_s;
  std::set<std::string> ids;
  for (const auto &item : steps) {
    if (!item.first.empty()) throw std::runtime_error("动作组 steps 必须为数组");
    const auto &entry = item.second;
    group_fields(entry, {"id", "label", "positions", "gripper_position", "motion_duration_s", "hold_duration_s"});
    PositionGroupStep step;
    step.id = group_string(entry, "id", 128); step.label = group_string(entry, "label", 512);
    if (!ids.insert(step.id).second) throw std::runtime_error("动作组步骤 id 重复");
    const auto &positions = entry.get_child("positions");
    if (!positions.data().empty() || positions.size() != 6) throw std::runtime_error("动作组 positions 必须为六轴数组");
    for (const auto &position : positions) {
      if (!position.first.empty() || !position.second.empty()) throw std::runtime_error("动作组 positions 必须为数值数组");
      step.positions.push_back(position.second.get_value<double>());
    }
    validate_position_target(step.positions, model);
    if (entry.get_child_optional("gripper_position")) {
      const auto value = group_number(entry, "gripper_position");
      if (!gripper_supported || !std::isfinite(gripper_lower) || !std::isfinite(gripper_upper)
          || gripper_lower > gripper_upper || value < gripper_lower || value > gripper_upper)
        throw std::runtime_error("动作组夹爪目标缺少有效模型或超过标定行程");
      step.gripper_position = value; spec.uses_gripper = true;
    }
    step.motion_duration_s = group_number(entry, "motion_duration_s");
    if (spec.steps.empty()) {
      if (step.motion_duration_s != 0) throw std::runtime_error("动作组首项 motion_duration_s 必须为 0，准备时长单独指定");
    } else validate_motion_duration(step.motion_duration_s);
    step.hold_duration_s = group_number(entry, "hold_duration_s");
    if (step.hold_duration_s < 0) throw std::runtime_error("动作组停留时长不能为负数");
    total += step.motion_duration_s + step.hold_duration_s;
    if (!std::isfinite(total) || total > 7 * 86400) throw std::runtime_error("动作组总时长超过 7 天");
    spec.steps.push_back(std::move(step));
  }
  if (total > 7 * 86400) throw std::runtime_error("动作组总时长超过 7 天");
  validate_position_group(spec, model, gripper_supported, gripper_lower, gripper_upper);
  return spec;
}

}
