#pragma once
#include "tcp_pose_core.hpp"
#include <boost/property_tree/xml_parser.hpp>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>

namespace easy_debug_bridge {
struct TcpPoseJoint {
  std::string name, parent, child;
  TcpPose origin;
  std::array<double, 3> axis{1., 0., 0.};
  // -1 denotes a fixed joint; arm joint1..6 use indices 0..5.
  int arm_index{-1};
};
struct TcpPoseModel {
  std::string root_link, arm_tip_link, tcp_link;
  TcpPose arm_tip_to_tcp;
  std::vector<TcpPoseJoint> chain;
};

namespace tcp_pose_detail {
using Tree = boost::property_tree::ptree;
inline std::array<double, 3> triple(const std::string &text) {
  std::istringstream input(text);
  std::array<double, 3> result{};
  for (auto &value : result)
    if (!(input >> value) || !std::isfinite(value)) throw std::runtime_error("URDF 位姿/轴必须包含三个有限数值");
  input >> std::ws;
  if (!input.eof()) throw std::runtime_error("URDF 位姿/轴必须恰好包含三个数值");
  return result;
}
inline void unique_attributes(const Tree &tree) {
  if (const auto attrs = tree.get_child_optional("<xmlattr>")) {
    std::set<std::string> names;
    for (const auto &attr : *attrs)
      if (!names.insert(attr.first).second) throw std::runtime_error("URDF 包含重复属性");
  }
  for (const auto &entry : tree)
    if (entry.first != "<xmlattr>") unique_attributes(entry.second);
}
inline std::string name(const std::string &value) {
  if (value.empty() || value.find_first_of(" \t\r\n") != std::string::npos)
    throw std::runtime_error("URDF link/joint 名称无效");
  for (unsigned char c : value)
    if (c < 0x20 || c == 0x7f) throw std::runtime_error("URDF link/joint 名称无效");
  return value;
}
inline void unique_children(const Tree &tree) {
  for (const auto &key : {"parent", "child", "origin", "axis", "limit", "mimic"})
    if (tree.count(key) > 1) throw std::runtime_error("URDF joint 包含重复字段");
}
inline TcpPose origin(const Tree &joint) {
  TcpPose pose;
  pose.position = triple(joint.get<std::string>("origin.<xmlattr>.xyz", "0 0 0"));
  const auto rpy = triple(joint.get<std::string>("origin.<xmlattr>.rpy", "0 0 0"));
  const double cr = std::cos(rpy[0]/2), sr = std::sin(rpy[0]/2);
  const double cp = std::cos(rpy[1]/2), sp = std::sin(rpy[1]/2);
  const double cy = std::cos(rpy[2]/2), sy = std::sin(rpy[2]/2);
  // URDF fixed-axis RPY is Rz(yaw)*Ry(pitch)*Rx(roll).
  pose.orientation = {sr*cp*cy-cr*sp*sy, cr*sp*cy+sr*cp*sy,
      cr*cp*sy-sr*sp*cy, cr*cp*cy+sr*sp*sy};
  return validate_tcp_pose(pose);
}
}

inline TcpPoseModel parse_tcp_pose_model(const std::string &urdf, const std::string &requested_tcp_link,
    const std::string &requested_frame = "") {
  using namespace tcp_pose_detail;
  Tree document;
  std::istringstream input(urdf);
  read_xml(input, document, boost::property_tree::xml_parser::no_comments);
  if (document.size() != 1 || document.count("robot") != 1) throw std::runtime_error("URDF 必须包含唯一 robot 根节点");
  const auto &robot = document.get_child("robot");
  unique_attributes(robot);
  std::set<std::string> links;
  struct ParsedJoint { TcpPoseJoint value; std::string type, mimic; };
  std::map<std::string, ParsedJoint> joints;
  std::map<std::string, std::string> parents;
  for (const auto &entry : robot) {
    if (entry.first == "link") {
      const auto link = name(entry.second.get<std::string>("<xmlattr>.name", ""));
      if (!links.insert(link).second) throw std::runtime_error("URDF link 名称重复");
    }
    if (entry.first != "joint") continue;
    unique_children(entry.second);
    ParsedJoint joint;
    joint.value.name = name(entry.second.get<std::string>("<xmlattr>.name", ""));
    joint.value.parent = name(entry.second.get<std::string>("parent.<xmlattr>.link", ""));
    joint.value.child = name(entry.second.get<std::string>("child.<xmlattr>.link", ""));
    joint.type = entry.second.get<std::string>("<xmlattr>.type", "");
    if (joint.type != "fixed" && joint.type != "revolute" && joint.type != "continuous" && joint.type != "prismatic")
      throw std::runtime_error("URDF 包含不支持的关节类型");
    joint.value.origin = origin(entry.second);
    joint.value.axis = triple(entry.second.get<std::string>("axis.<xmlattr>.xyz", "1 0 0"));
    if (joint.type != "fixed") {
      const auto &axis = joint.value.axis;
      const double length = std::hypot(std::hypot(axis[0], axis[1]), axis[2]);
      if (!std::isfinite(length) || length < 1e-12) throw std::runtime_error("URDF 可动关节轴无效");
      for (auto &v : joint.value.axis) v /= length;
    }
    if (entry.second.get_child_optional("mimic")) {
      joint.mimic = name(entry.second.get<std::string>("mimic.<xmlattr>.joint", ""));
      for (const auto &field : {"multiplier", "offset"})
        if (!std::isfinite(entry.second.get<double>("mimic.<xmlattr>." + std::string(field), field == std::string("multiplier") ? 1. : 0.)))
          throw std::runtime_error("URDF mimic 参数无效");
    }
    if (!parents.emplace(joint.value.child, joint.value.name).second)
      throw std::runtime_error("URDF link 存在多个父关节");
    if (!joints.emplace(joint.value.name, joint).second) throw std::runtime_error("URDF joint 名称重复");
  }
  if (links.empty() || links.size() > 4096 || joints.size() > 4096) throw std::runtime_error("URDF link/joint 数量无效");
  for (const auto &item : joints) {
    const auto &joint = item.second;
    if (!links.count(joint.value.parent) || !links.count(joint.value.child) || joint.value.parent == joint.value.child)
      throw std::runtime_error("URDF joint 引用了未知 link 或自身");
    if (!joint.mimic.empty() && !joints.count(joint.mimic)) throw std::runtime_error("URDF mimic 引用了未知关节");
  }
  std::vector<std::string> roots;
  for (const auto &link : links) if (!parents.count(link)) roots.push_back(link);
  if (roots.size() != 1) throw std::runtime_error("URDF 必须是唯一根 link 的连通树");
  TcpPoseModel model;
  model.root_link = roots.front();
  model.tcp_link = requested_tcp_link;
  if (!requested_frame.empty() && requested_frame != model.root_link) throw std::runtime_error("TCP 目标 frame 必须是 URDF 根坐标系：" + model.root_link);
  if (!links.count(model.tcp_link)) throw std::runtime_error("TCP link 不存在");
  // Validate the entire tree, including disconnected cycles outside the selected chain.
  for (const auto &link : links) {
    std::set<std::string> seen;
    auto current = link;
    while (current != model.root_link) {
      if (!seen.insert(current).second || !parents.count(current)) throw std::runtime_error("URDF 含循环或不连通 link");
      current = joints.at(parents.at(current)).value.parent;
    }
  }
  std::vector<ParsedJoint> reverse_chain;
  auto link = model.tcp_link;
  while (link != model.root_link) {
    const auto &joint = joints.at(parents.at(link));
    reverse_chain.push_back(joint);
    link = joint.value.parent;
  }
  std::reverse(reverse_chain.begin(), reverse_chain.end());
  size_t arm_index = 0;
  for (auto &joint : reverse_chain) {
    if (joint.type != "fixed") {
      if (arm_index >= 6 || joint.type != "revolute" || !joint.mimic.empty() || joint.value.name != "joint" + std::to_string(arm_index + 1))
        throw std::runtime_error("TCP 运动链必须依次包含独立 joint1–joint6，工具偏移只能包含 fixed joint");
      joint.value.arm_index = static_cast<int>(arm_index++);
      if (arm_index == 6) model.arm_tip_link = joint.value.child;
    } else {
      if (!joint.mimic.empty()) throw std::runtime_error("TCP fixed joint 不能包含 mimic");
      if (arm_index == 6) model.arm_tip_to_tcp = tcp_pose_compose(model.arm_tip_to_tcp, joint.value.origin);
    }
    model.chain.push_back(joint.value);
  }
  if (arm_index != 6) throw std::runtime_error("TCP link 未包含完整六轴机械臂运动链");
  return model;
}

inline TcpPose tcp_forward_pose(const TcpPoseModel &model, const std::vector<double> &arm_q) {
  if (arm_q.size() != 6 || !std::all_of(arm_q.begin(), arm_q.end(), [](double q) { return std::isfinite(q); }))
    throw std::runtime_error("TCP FK 需要按 joint1–joint6 排列的六个有限关节值");
  TcpPose pose;
  for (const auto &joint : model.chain) {
    pose = tcp_pose_compose(pose, joint.origin);
    if (joint.arm_index < 0) continue;
    if (joint.arm_index >= 6) throw std::runtime_error("TCP FK 关节模型无效");
    const double half = arm_q[static_cast<size_t>(joint.arm_index)] / 2.;
    const double s = std::sin(half);
    TcpPose rotation;
    rotation.orientation = {joint.axis[0]*s, joint.axis[1]*s, joint.axis[2]*s, std::cos(half)};
    pose = tcp_pose_compose(pose, rotation);
  }
  return pose;
}

inline TcpPose tcp_target_to_arm_tip(const TcpPoseModel &model, const TcpPose &target) {
  return tcp_pose_compose(validate_tcp_pose(target), tcp_pose_inverse(model.arm_tip_to_tcp));
}
}
