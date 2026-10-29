#pragma once
#include "position_motion_core.hpp"
#include <boost/property_tree/xml_parser.hpp>
namespace easy_debug_bridge {
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
