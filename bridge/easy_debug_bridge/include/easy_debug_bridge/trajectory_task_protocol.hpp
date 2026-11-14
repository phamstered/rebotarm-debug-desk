#pragma once
#include "easy_debug_bridge/trajectory_task_core.hpp"
#include "easy_debug_bridge/position_motion_core.hpp"
#include <boost/property_tree/ptree.hpp>
#include <set>

namespace easy_debug_bridge {
inline void trajectory_fields(const boost::property_tree::ptree &tree, const std::set<std::string> &allowed) {
  if (!tree.data().empty()) throw std::runtime_error("轨迹请求必须是对象");
  std::set<std::string> seen;
  for (const auto &field : tree)
    if (!allowed.count(field.first) || !seen.insert(field.first).second)
      throw std::runtime_error("轨迹请求包含未知或重复字段：" + field.first);
}
inline TrajectoryCommand parse_task_trajectory(const boost::property_tree::ptree &request) {
  trajectory_fields(request, {"op", "request_id", "command_id", "topic", "joint_names", "trajectory_points"});
  for (const auto *key : {"op", "request_id", "command_id", "topic"})
    if (const auto value = request.get_child_optional(key); value && !value->empty())
      throw std::runtime_error("轨迹标识字段必须是标量");
  TrajectoryCommand command;
  command.topic = request.get<std::string>("topic");
  const auto &names = request.get_child("joint_names");
  if (!names.data().empty() || names.size() > 32) throw std::runtime_error("轨迹关节数组无效");
  for (const auto &entry : names) {
    if (!entry.first.empty() || !entry.second.empty()) throw std::runtime_error("轨迹关节数组无效");
    command.joint_names.push_back(entry.second.get_value<std::string>());
  }
  const auto &points = request.get_child("trajectory_points");
  if (!points.data().empty() || points.size() > 64) throw std::runtime_error("轨迹点数组无效");
  for (const auto &entry : points) {
    if (!entry.first.empty()) throw std::runtime_error("轨迹点必须是数组");
    trajectory_fields(entry.second, {"positions", "velocities", "time_from_start"});
    TrajectoryPointSpec point;
    auto read = [&](const char *key, std::vector<double> &out) {
      if (const auto values = entry.second.get_child_optional(key)) {
        if (!values->data().empty() || values->size() > 32) throw std::runtime_error("轨迹数值数组无效");
        for (const auto &value : *values) {
          if (!value.first.empty() || !value.second.empty()) throw std::runtime_error("轨迹数值数组无效");
          out.push_back(value.second.get_value<double>());
        }
      }
    };
    read("positions", point.positions); read("velocities", point.velocities);
    const auto &duration = entry.second.get_child("time_from_start");
    if (!duration.empty()) throw std::runtime_error("轨迹时间必须是标量");
    point.time_from_start = duration.get_value<double>();
    command.points.push_back(std::move(point));
  }
  const auto validation = validate_trajectory_command(command);
  if (validation != TrajectoryValidation::Ok) throw std::runtime_error(trajectory_validation_message(validation));
  return command;
}

inline std::string trajectory_task_event(const std::string &id, const std::string &phase,
    bool terminal, const std::string &evidence = "", const std::string &message = "") {
  return "{\"op\":\"trajectory_task_state\",\"command_id\":" + position_json_quote(id) +
    ",\"task_phase\":" + position_json_quote(phase) + ",\"terminal\":" + (terminal ? "true" : "false") +
    ",\"evidence\":" + position_json_quote(evidence) + ",\"message\":" + position_json_quote(message) + "}";
}
inline std::string trajectory_task_event(const TrajectoryTaskCore::Result &result) {
  return trajectory_task_event(result.id, result.phase, true, result.evidence);
}
inline std::string trajectory_control_id(const boost::property_tree::ptree &request) {
  trajectory_fields(request,{"op","request_id","command_id"});
  for (const auto &field:request) if (!field.second.empty()) throw std::runtime_error("轨迹任务查询字段必须为标量");
  const auto id=request.get<std::string>("command_id","");
  if (!valid_motion_command_id(id)) throw std::runtime_error("command_id 无效");
  return id;
}
}
