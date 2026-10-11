#pragma once

#include <cmath>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace easy_debug_bridge {

inline std::string base64_encode(const std::vector<uint8_t> &data) {
  static constexpr char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string result;
  result.reserve(((data.size() + 2) / 3) * 4);
  for (size_t i = 0; i < data.size(); i += 3) {
    const uint32_t value = (static_cast<uint32_t>(data[i]) << 16) |
                           (i + 1 < data.size() ? static_cast<uint32_t>(data[i + 1]) << 8 : 0) |
                           (i + 2 < data.size() ? static_cast<uint32_t>(data[i + 2]) : 0);
    result.push_back(alphabet[(value >> 18) & 0x3f]);
    result.push_back(alphabet[(value >> 12) & 0x3f]);
    result.push_back(i + 1 < data.size() ? alphabet[(value >> 6) & 0x3f] : '=');
    result.push_back(i + 2 < data.size() ? alphabet[value & 0x3f] : '=');
  }
  return result;
}

inline std::vector<uint8_t> binary_image_frame(
    const std::string &metadata_json, const std::vector<uint8_t> &pixels) {
  if (metadata_json.size() > UINT32_MAX) return {};
  const uint32_t metadata_size = static_cast<uint32_t>(metadata_json.size());
  std::vector<uint8_t> frame;
  frame.reserve(8 + metadata_json.size() + pixels.size());
  frame.insert(frame.end(), {'R', 'C', 'I', '1'});
  frame.push_back(static_cast<uint8_t>((metadata_size >> 24) & 0xff));
  frame.push_back(static_cast<uint8_t>((metadata_size >> 16) & 0xff));
  frame.push_back(static_cast<uint8_t>((metadata_size >> 8) & 0xff));
  frame.push_back(static_cast<uint8_t>(metadata_size & 0xff));
  frame.insert(frame.end(), metadata_json.begin(), metadata_json.end());
  frame.insert(frame.end(), pixels.begin(), pixels.end());
  return frame;
}

struct CommandFields {
  int mode;
  double position;
  double velocity;
  double kp;
  double kd;
  double effort;
  std::string confirmation;
};

enum class CommandValidation { Ok, InvalidMode, NotArmed, NonFinite, EffortLimit };

inline CommandValidation validate_command(const CommandFields &command) {
  if (command.mode < 0 || command.mode > 3) return CommandValidation::InvalidMode;
  if (command.mode != 3 && command.confirmation != "ARMED") return CommandValidation::NotArmed;
  if (!std::isfinite(command.position) || !std::isfinite(command.velocity) ||
      !std::isfinite(command.kp) || !std::isfinite(command.kd) ||
      !std::isfinite(command.effort)) return CommandValidation::NonFinite;
  if (std::abs(command.effort) > 1.0) return CommandValidation::EffortLimit;
  return CommandValidation::Ok;
}

inline std::vector<uint32_t> allocate_sequences(uint32_t &current, unsigned count) {
  std::vector<uint32_t> values;
  values.reserve(count);
  for (unsigned index = 0; index < count; ++index) values.push_back(++current);
  return values;
}

inline std::string fully_qualified_node_name(const std::string &node_namespace,
                                             const std::string &node_name) {
  std::string result = node_namespace.empty() ? "/" : node_namespace;
  if (result.front() != '/') result.insert(result.begin(), '/');
  if (result.back() != '/') result.push_back('/');
  result += node_name;
  while (result.size() > 1 && result.back() == '/') result.pop_back();
  return result;
}

inline bool is_robot_description_topic(const std::string &topic) {
  constexpr char basename[] = "/robot_description";
  if (topic.size() < sizeof(basename) - 1) return false;
  return topic.compare(topic.size() - (sizeof(basename) - 1), sizeof(basename) - 1, basename) == 0;
}

// ROS 2 的 symlink-install 会把 package share 目录内的资源链接回源码树。
// 安全边界因此必须针对用户请求的词法路径检查，不能对最终文件 canonicalize 后再比较，
// 否则合法的 package:// mesh 会因为符号链接目标位于源码树而被误判为目录穿越。
inline std::optional<std::filesystem::path> package_resource_path(
    const std::filesystem::path &package_root, const std::filesystem::path &relative_path) {
  if (relative_path.empty() || relative_path.is_absolute()) return std::nullopt;

  const auto root = package_root.lexically_normal();
  const auto relative = relative_path.lexically_normal();
  if (relative.empty() || relative == ".") return std::nullopt;
  const auto candidate = (root / relative).lexically_normal();
  if (candidate == root) return std::nullopt;
  auto root_part = root.begin();
  auto candidate_part = candidate.begin();
  for (; root_part != root.end(); ++root_part, ++candidate_part) {
    if (candidate_part == candidate.end() || *root_part != *candidate_part) return std::nullopt;
  }
  return candidate;
}

// --- JointTrajectory 指令 ----------------------------------------------------

struct TrajectoryPointSpec {
  std::vector<double> positions;
  std::vector<double> velocities;
  double time_from_start{0.0};
};

struct TrajectoryCommand {
  std::string topic;
  std::vector<std::string> joint_names;
  std::vector<TrajectoryPointSpec> points;
};

enum class TrajectoryValidation {
  Ok,
  InvalidTopic,
  EmptyJoints,
  TooManyJoints,
  InvalidJointName,
  DuplicateJointName,
  EmptyPoints,
  TooManyPoints,
  SizeMismatch,
  NonFinite,
  NonPositiveTime,
  NonMonotonicTime,
};

// 轨迹指令只会发往 JointTrajectoryController 的 ~/joint_trajectory 订阅，
// 用 Topic 后缀做白名单，避免 Bridge 变成任意 Topic 发布器。
inline bool is_trajectory_topic(const std::string &topic) {
  constexpr char suffix[] = "/joint_trajectory";
  const size_t suffix_length = sizeof(suffix) - 1;
  if (topic.size() < suffix_length) return false;
  if (topic.compare(topic.size() - suffix_length, suffix_length, suffix) != 0) return false;
  if (topic.front() != '/') return false;
  if (topic.find("//") != std::string::npos) return false;
  for (const char character : topic) {
    const bool allowed = (character >= 'a' && character <= 'z') ||
                         (character >= 'A' && character <= 'Z') ||
                         (character >= '0' && character <= '9') ||
                         character == '_' || character == '/';
    if (!allowed) return false;
  }
  return true;
}

inline TrajectoryValidation validate_trajectory_command(const TrajectoryCommand &command) {
  if (!is_trajectory_topic(command.topic)) return TrajectoryValidation::InvalidTopic;
  if (command.joint_names.empty()) return TrajectoryValidation::EmptyJoints;
  if (command.joint_names.size() > 32) return TrajectoryValidation::TooManyJoints;
  for (size_t index = 0; index < command.joint_names.size(); ++index) {
    const std::string &name = command.joint_names[index];
    if (name.empty() || name.find_first_of(" \t\n\r") != std::string::npos) {
      return TrajectoryValidation::InvalidJointName;
    }
    for (size_t previous = 0; previous < index; ++previous) {
      if (command.joint_names[previous] == name) return TrajectoryValidation::DuplicateJointName;
    }
  }
  if (command.points.empty()) return TrajectoryValidation::EmptyPoints;
  if (command.points.size() > 64) return TrajectoryValidation::TooManyPoints;

  double previous_time = 0.0;
  for (const auto &point : command.points) {
    if (point.positions.size() != command.joint_names.size()) return TrajectoryValidation::SizeMismatch;
    if (!point.velocities.empty() && point.velocities.size() != command.joint_names.size()) {
      return TrajectoryValidation::SizeMismatch;
    }
    for (const double value : point.positions) {
      if (!std::isfinite(value)) return TrajectoryValidation::NonFinite;
    }
    for (const double value : point.velocities) {
      if (!std::isfinite(value)) return TrajectoryValidation::NonFinite;
    }
    if (!std::isfinite(point.time_from_start) || point.time_from_start <= 0.0) {
      return TrajectoryValidation::NonPositiveTime;
    }
    if (point.time_from_start <= previous_time) return TrajectoryValidation::NonMonotonicTime;
    previous_time = point.time_from_start;
  }
  return TrajectoryValidation::Ok;
}

inline std::string trajectory_validation_message(TrajectoryValidation validation) {
  switch (validation) {
    case TrajectoryValidation::Ok: return "";
    case TrajectoryValidation::InvalidTopic: return "轨迹 Topic 必须以 /joint_trajectory 结尾";
    case TrajectoryValidation::EmptyJoints: return "轨迹指令缺少 joint_names";
    case TrajectoryValidation::TooManyJoints: return "轨迹指令关节数超过 32";
    case TrajectoryValidation::InvalidJointName: return "轨迹关节名为空或含空白字符";
    case TrajectoryValidation::DuplicateJointName: return "轨迹关节名重复";
    case TrajectoryValidation::EmptyPoints: return "轨迹指令缺少 points";
    case TrajectoryValidation::TooManyPoints: return "轨迹点数超过 64";
    case TrajectoryValidation::SizeMismatch: return "轨迹点的 positions/velocities 长度与 joint_names 不一致";
    case TrajectoryValidation::NonFinite: return "轨迹指令包含非有限数值";
    case TrajectoryValidation::NonPositiveTime: return "轨迹点 time_from_start 必须为正";
    case TrajectoryValidation::NonMonotonicTime: return "轨迹点 time_from_start 必须严格递增";
  }
  return "未知轨迹校验结果";
}

// 把秒数拆成 builtin_interfaces/Duration 的 sec/nanosec，避免依赖具体 rclcpp 版本的转换 API。
inline std::pair<int32_t, uint32_t> duration_fields(double seconds) {
  int64_t whole = static_cast<int64_t>(std::floor(seconds));
  int64_t nanoseconds = std::llround((seconds - static_cast<double>(whole)) * 1e9);
  if (nanoseconds >= 1000000000LL) {
    nanoseconds -= 1000000000LL;
    whole += 1;
  }
  return {static_cast<int32_t>(whole), static_cast<uint32_t>(nanoseconds)};
}

}  // namespace easy_debug_bridge
