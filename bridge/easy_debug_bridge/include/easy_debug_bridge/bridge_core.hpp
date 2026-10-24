#pragma once

#include <cmath>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <map>
#include <set>
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

inline std::vector<uint8_t> binary_payload_frame(
    const std::string &metadata_json, const std::vector<uint8_t> &pixels, char kind) {
  if (metadata_json.size() > UINT32_MAX) return {};
  const uint32_t metadata_size = static_cast<uint32_t>(metadata_json.size());
  std::vector<uint8_t> frame;
  frame.reserve(8 + metadata_json.size() + pixels.size());
  frame.insert(frame.end(), {'R', 'C', static_cast<uint8_t>(kind), '1'});
  frame.push_back(static_cast<uint8_t>((metadata_size >> 24) & 0xff));
  frame.push_back(static_cast<uint8_t>((metadata_size >> 16) & 0xff));
  frame.push_back(static_cast<uint8_t>((metadata_size >> 8) & 0xff));
  frame.push_back(static_cast<uint8_t>(metadata_size & 0xff));
  frame.insert(frame.end(), metadata_json.begin(), metadata_json.end());
  frame.insert(frame.end(), pixels.begin(), pixels.end());
  return frame;
}

inline std::vector<uint8_t> binary_image_frame(const std::string &metadata, const std::vector<uint8_t> &pixels) {
  return binary_payload_frame(metadata, pixels, 'I');
}
inline std::vector<uint8_t> binary_resource_frame(const std::string &metadata, const std::vector<uint8_t> &bytes) {
  return binary_payload_frame(metadata, bytes, 'R');
}

// Guarded by BridgeNode's subscription mutex. Only image delivery is session-scoped.
class ImageInterests {
 public:
  void add(const std::string &topic, uint64_t client) { topics_[topic].insert(client); }
  bool remove(const std::string &topic, uint64_t client) {
    auto it = topics_.find(topic);
    if (it == topics_.end()) return false;
    it->second.erase(client);
    if (!it->second.empty()) return false;
    topics_.erase(it); return true;
  }
  std::vector<std::string> disconnect(uint64_t client) {
    std::vector<std::string> empty;
    for (auto it = topics_.begin(); it != topics_.end();) {
      it->second.erase(client);
      if (it->second.empty()) { empty.push_back(it->first); it = topics_.erase(it); }
      else ++it;
    }
    return empty;
  }
  std::set<uint64_t> clients(const std::string &topic) const {
    const auto it = topics_.find(topic);
    return it == topics_.end() ? std::set<uint64_t>{} : it->second;
  }
 private:
  std::map<std::string, std::set<uint64_t>> topics_;
};

struct CommandFields {
  int mode;
  /** Legacy scalar position used when `positions` is empty (joint index 0). */
  double position;
  /** Optional per-joint positions matching JointCommand array index. */
  std::vector<double> positions;
  double velocity;
  double kp;
  double kd;
  double effort;
  /** Joints the client wants to command. Ignored when `mask_specified` is false. */
  uint32_t requested_joint_mask = 0;
  bool mask_specified = false;
  std::string confirmation;
};

enum class CommandValidation {
  Ok, InvalidMode, NotArmed, NonFinite, EffortLimit, EmptyJointMask
};

inline CommandValidation validate_command(const CommandFields &command) {
  if (command.mode < 0 || command.mode > 3) return CommandValidation::InvalidMode;
  if (command.mode != 3 && command.confirmation != "ARMED") return CommandValidation::NotArmed;
  if (!std::isfinite(command.position) || !std::isfinite(command.velocity) ||
      !std::isfinite(command.kp) || !std::isfinite(command.kd) ||
      !std::isfinite(command.effort)) return CommandValidation::NonFinite;
  for (const double value : command.positions) {
    if (!std::isfinite(value)) return CommandValidation::NonFinite;
  }
  if (std::abs(command.effort) > 1.0) return CommandValidation::EffortLimit;
  if (command.mode != 3 && command.mask_specified && command.requested_joint_mask == 0) {
    return CommandValidation::EmptyJointMask;
  }
  return CommandValidation::Ok;
}

/** Legacy clients omit the mask and still target joint1 (bit 0). */
inline uint32_t requested_command_mask(const CommandFields &command) {
  if (command.mask_specified) return command.requested_joint_mask;
  return 0x01U;
}

/**
 * Require every requested joint to be present in the firmware active mask.
 * Returns 0 when the request is empty or not fully covered (caller should reject).
 */
inline uint32_t resolve_command_mask(uint32_t requested, uint32_t firmware_active) {
  if (requested == 0) return 0;
  if ((requested & firmware_active) != requested) return 0;
  return requested;
}

inline double joint_position_value(const CommandFields &command, size_t index) {
  if (index < command.positions.size()) return command.positions[index];
  if (command.positions.empty() && index == 0) return command.position;
  return 0.0;
}

/**
 * Fill per-joint command channels. Unselected joints stay zero so firmware
 * does not see INACTIVE_JOINT_COMMAND on inactive axes.
 */
inline void fill_joint_command_channels(
    uint32_t effective_mask, const CommandFields &command, size_t joint_count,
    double *position, double *velocity, double *kp, double *kd, double *effort) {
  for (size_t index = 0; index < joint_count; ++index) {
    position[index] = 0.0;
    velocity[index] = 0.0;
    kp[index] = 0.0;
    kd[index] = 0.0;
    effort[index] = 0.0;
    if (index >= 32) continue;
    if ((effective_mask & (uint32_t{1} << index)) == 0) continue;
    position[index] = joint_position_value(command, index);
    velocity[index] = command.velocity;
    kp[index] = command.kp;
    kd[index] = command.kd;
    effort[index] = command.effort;
  }
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

inline bool is_valid_graph_name(const std::string &name) {
  if (name.size() < 2 || name.size() > 255 || name.front() != '/' || name.back() == '/') return false;
  bool previous_slash = true;
  for (size_t index = 1; index < name.size(); ++index) {
    const unsigned char ch = static_cast<unsigned char>(name[index]);
    if (ch == '/') {
      if (previous_slash) return false;
      previous_slash = true;
    } else {
      if (!std::isalnum(ch) && ch != '_') return false;
      previous_slash = false;
    }
  }
  return true;
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


// --- GravityIdentification (/StartGravityID) ---------------------------------

struct GravityIdGoalFields {
  uint32_t joint_mask = 0x3Fu;
  uint8_t mode = 0;
  std::vector<std::string> pose_set_id;
  double settle_time_s = 1.5;
  double capture_window_s = 1.0;
  bool write_yaml = true;
  bool hot_reload = true;
  std::string output_yaml_path;
  double max_effort_nm = 10.0;
  double max_velocity_rad_s = 0.15;
  double command_timeout_ms = 100.0;
  bool lock_gripper = true;
  std::string confirmation;
};

enum class GravityIdGoalValidation {
  Ok,
  NotArmed,
  InvalidMode,
  PayloadRejected,
  NonFinite,
  Negative,
};

inline constexpr uint32_t GRAVITY_ID_DEFAULT_JOINT_MASK = 0x3Fu;
inline constexpr uint8_t GRAVITY_ID_MODE_FULL_ARM = 0;
inline constexpr uint8_t GRAVITY_ID_MODE_PAYLOAD = 1;

inline uint32_t gravity_id_effective_mask(uint32_t joint_mask) {
  if (joint_mask == 0) return GRAVITY_ID_DEFAULT_JOINT_MASK;
  return joint_mask & GRAVITY_ID_DEFAULT_JOINT_MASK;
}

inline GravityIdGoalValidation validate_gravity_id_goal(const GravityIdGoalFields &goal) {
  if (goal.confirmation != "ARMED") return GravityIdGoalValidation::NotArmed;
  if (goal.mode == GRAVITY_ID_MODE_PAYLOAD) {
    return GravityIdGoalValidation::PayloadRejected;
  }
  if (goal.mode != GRAVITY_ID_MODE_FULL_ARM) {
    return GravityIdGoalValidation::InvalidMode;
  }
  if (!std::isfinite(goal.settle_time_s) || !std::isfinite(goal.capture_window_s) ||
      !std::isfinite(goal.max_effort_nm) || !std::isfinite(goal.max_velocity_rad_s) ||
      !std::isfinite(goal.command_timeout_ms)) {
    return GravityIdGoalValidation::NonFinite;
  }
  if (goal.settle_time_s < 0.0 || goal.capture_window_s < 0.0 || goal.max_effort_nm < 0.0 ||
      goal.max_velocity_rad_s < 0.0 || goal.command_timeout_ms < 0.0) {
    return GravityIdGoalValidation::Negative;
  }
  return GravityIdGoalValidation::Ok;
}

inline std::string gravity_id_goal_validation_message(GravityIdGoalValidation validation) {
  switch (validation) {
    case GravityIdGoalValidation::Ok: return "";
    case GravityIdGoalValidation::NotArmed: return "控制面板尚未解锁";
    case GravityIdGoalValidation::InvalidMode: return "无效的 GravityIdentification.mode";
    case GravityIdGoalValidation::PayloadRejected:
      return "Rejecting PAYLOAD_SUBMODE: v1 only supports FULL_ARM_GRAVITY "
             "(use joint4_calibration_controller for payload)";
    case GravityIdGoalValidation::NonFinite: return "GravityIdentification Goal 包含非有限数值";
    case GravityIdGoalValidation::Negative: return "GravityIdentification Goal 数值不得为负";
  }
  return "未知 GravityIdentification 校验结果";
}

}  // namespace easy_debug_bridge
