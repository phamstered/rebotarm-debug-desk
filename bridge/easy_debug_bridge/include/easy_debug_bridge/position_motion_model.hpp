#pragma once
#include "position_motion_core.hpp"
#include "gripper_motion_core.hpp"
#include <boost/property_tree/xml_parser.hpp>
namespace easy_debug_bridge {
inline void validate_gripper_motion_model(const std::string &urdf, const std::string &srdf,
    const GripperCalibration &calibration) {
  validate_gripper_calibration(calibration);
  boost::property_tree::ptree robot, semantic;
  std::istringstream u(urdf), s(srdf);
  read_xml(u, robot); read_xml(s, semantic);
  size_t found = 0;
  for (const auto &entry : robot.get_child("robot")) {
    if (entry.first != "joint" || entry.second.get<std::string>("<xmlattr>.name", "") != gripper_motion_joint()) continue;
    const auto &joint = entry.second;
    const double lower = joint.get<double>("limit.<xmlattr>.lower"), upper = joint.get<double>("limit.<xmlattr>.upper");
    if (++found != 1 || joint.get<std::string>("<xmlattr>.type", "") != "prismatic" || joint.get_child_optional("mimic") ||
        !std::isfinite(lower) || !std::isfinite(upper) || lower > calibration.lower || upper < calibration.upper)
      throw std::runtime_error("夹爪 URDF 类型、独立自由度或行程不匹配");
  }
  if (found != 1) throw std::runtime_error("模型缺少夹爪独立关节");
  bool gripper = false, combined = false;
  for (const auto &entry : semantic.get_child("robot")) {
    if (entry.first != "group") continue;
    const auto name = entry.second.get<std::string>("<xmlattr>.name", "");
    if (name != "gripper" && name != "arm_with_gripper") continue;
    std::vector<std::string> names;
    for (const auto &joint : entry.second) {
      if (joint.first == "<xmlattr>") continue;
      if (joint.first != "joint") throw std::runtime_error("夹爪规划组必须显式声明独立关节");
      names.push_back(joint.second.get<std::string>("<xmlattr>.name"));
    }
    if (name == "gripper") {
      if (gripper || !same_motion_joints(names, {gripper_motion_joint()})) throw std::runtime_error("gripper 组关节不匹配");
      gripper = true;
    } else {
      auto expected = arm_motion_joints(); expected.push_back(gripper_motion_joint());
      if (combined || !same_motion_joints(names, expected)) throw std::runtime_error("arm_with_gripper 组关节不匹配");
      combined = true;
    }
  }
  if (!gripper || !combined) throw std::runtime_error("缺少 gripper/arm_with_gripper 规划组");
}
inline PositionMotionModel position_motion_model(const std::string &urdf, const std::string &srdf) {
  using boost::property_tree::ptree;
  ptree robot, semantic;
  std::istringstream urdf_stream(urdf), srdf_stream(srdf);
  read_xml(urdf_stream, robot); read_xml(srdf_stream, semantic);
  PositionMotionModel result;
  std::vector<std::string> home_names, group_names;
  std::vector<double> home_values;
  for (const auto &name : arm_motion_joints()) {
    bool found = false;
    for (const auto &entry : robot.get_child("robot")) {
      if (entry.first != "joint" || entry.second.get<std::string>("<xmlattr>.name", "") != name) continue;
      if (found || entry.second.get<std::string>("<xmlattr>.type", "") != "revolute")
        throw std::runtime_error("arm 模型关节类型或名称无效");
      const double lo = entry.second.get<double>("limit.<xmlattr>.lower");
      const double hi = entry.second.get<double>("limit.<xmlattr>.upper");
      if (!std::isfinite(lo) || !std::isfinite(hi) || lo >= hi) throw std::runtime_error("模型关节限位无效");
      result.lower.push_back(lo); result.upper.push_back(hi); found = true;
    }
    if (!found) throw std::runtime_error("MoveIt 模型缺少关节：" + name);
  }
  for (const auto &entry : semantic.get_child("robot")) {
    if (entry.first == "group" && entry.second.get<std::string>("<xmlattr>.name", "") == "arm") {
      if (!group_names.empty()) throw std::runtime_error("重复 arm 组");
      for (const auto &joint : entry.second) {
        if (joint.first == "<xmlattr>") continue;
        if (joint.first != "joint") throw std::runtime_error("arm 必须显式声明六关节");
        group_names.push_back(joint.second.get<std::string>("<xmlattr>.name"));
      }
    }
    if (entry.first == "group_state" && entry.second.get<std::string>("<xmlattr>.name", "") == "home"
        && entry.second.get<std::string>("<xmlattr>.group", "") == "arm") {
      if (!home_names.empty()) throw std::runtime_error("重复 HOME 定义");
      for (const auto &joint : entry.second) if (joint.first == "joint") {
        home_names.push_back(joint.second.get<std::string>("<xmlattr>.name"));
        home_values.push_back(joint.second.get<double>("<xmlattr>.value"));
      }
    }
  }
  if (!arm_joint_set(group_names) || !arm_joint_set(home_names)) throw std::runtime_error("SRDF arm/home 未完整定义六个关节");
  result.home = ordered_arm_values(home_names, home_values);
  for (size_t i = 0; i < 6; ++i) if (result.home[i] < result.lower[i] || result.home[i] > result.upper[i])
    throw std::runtime_error("HOME 超过模型关节限位");
  return result;
}
}
