#pragma once
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>

namespace easy_debug_bridge::motor_v2 {
using Clock = std::chrono::steady_clock;
using Time = Clock::time_point;
constexpr uint32_t all_joints = 0x7f;
constexpr uint8_t mit = 1, pos_vel = 2, disable = 3;
inline bool mask_valid(uint32_t mask) { return mask && !(mask & ~all_joints); }
inline bool sequence_after(uint32_t next, uint32_t previous) {
  const uint32_t distance = next - previous;
  return distance && distance < 0x80000000u;
}
struct Status {
  uint8_t protocol_version{};
  uint64_t boot_id{}, owner_source_id{}, stamp_ns{};
  uint32_t control_epoch{}, lease_id{}, selected_joint_mask{}, enabled_joint_mask{},
      verified_joint_mask{}, pos_vel_supported_mask{}, operation_id{}, last_command_sequence{}, rejected_sequence{};
  std::array<uint8_t, 7> control_modes{};
  std::array<float, 7> velocity_limit_max{}, position_min{}, position_max{};
  bool switching{}, disabled_verified{};
  uint8_t operation_state{}, mode{};
  uint16_t fault_code{}, error_code{}, reject_code{};
  bool valid() const {
    if (protocol_version != 2 || !boot_id || !stamp_ns || mode > 3 || operation_state > 4 ||
        ((selected_joint_mask | enabled_joint_mask | verified_joint_mask | pos_vel_supported_mask) & ~all_joints)) return false;
    for (size_t i = 0; i < 7; ++i) {
      if (control_modes[i] > pos_vel || !std::isfinite(velocity_limit_max[i]) ||
          !std::isfinite(position_min[i]) || !std::isfinite(position_max[i])) return false;
      if ((pos_vel_supported_mask & (1u << i)) && (velocity_limit_max[i] <= 0 || position_min[i] > position_max[i])) return false;
    }
    return true;
  }
  bool disabled() const { return disabled_verified && mode == disable && !enabled_joint_mask && !lease_id && !switching; }
  bool actual(uint32_t mask, uint8_t requested_mode) const {
    if (!mask_valid(mask) || (mask & verified_joint_mask) != mask) return false;
    for (size_t i = 0; i < 7; ++i) if ((mask & (1u << i)) && control_modes[i] != requested_mode) return false;
    return true;
  }
};
struct Cache {
  bool seen{}, have{};
  Status status;
  Time received{};
  std::set<uint64_t> retired_boots;
  // Seeing a publisher is sticky too: missing or incompatible samples must not
  // turn a new firmware connection back into the permissive legacy path.
  void discovered() { seen = true; }
  bool observe(const Status &next, Time now) {
    seen = true;
    if (!next.valid()) { have = false; return false; }
    if (retired_boots.count(next.boot_id)) return false;
    // Keep the last accepted high-water marks even when a malformed sample has
    // invalidated admission. It must not make an older MIT snapshot fresh again.
    if (next.boot_id == status.boot_id && (next.stamp_ns <= status.stamp_ns || next.control_epoch < status.control_epoch)) return false;
    if (status.boot_id && next.boot_id != status.boot_id) {
      if (retired_boots.size() >= 16) { have = false; return false; }
      retired_boots.insert(status.boot_id);
    }
    status = next; have = true; received = now; return true;
  }
  bool fresh(Time now) const { return have && now - received < std::chrono::seconds(1); }
  void require_fresh(Time now) const {
    if (!fresh(now)) throw std::runtime_error("V2 固件能力状态缺失、无效或过期");
  }
  void require_identity(uint64_t boot, uint32_t epoch, Time now) const {
    require_fresh(now);
    if (!boot || status.boot_id != boot || status.control_epoch != epoch)
      throw std::runtime_error("固件 boot_id 或 control_epoch 已变化，请重新确认");
  }
  bool mit_allowed(Time now) const {
    return !seen || (fresh(now) && !status.switching && !status.fault_code && !status.error_code && status.operation_state != 1 &&
        !status.lease_id && !status.owner_source_id && status.actual(all_joints, mit));
  }
};
struct Command {
  uint64_t boot{}, source{};
  uint32_t epoch{}, lease{}, mask{}, sequence{};
  uint8_t mode{};
  std::array<float, 7> position{}, velocity_limit{};
};
inline void validate_command(const Cache &cache, const Command &command, Time now) {
  cache.require_identity(command.boot, command.epoch, now);
  const auto &s = cache.status;
  if (!mask_valid(command.mask) || command.mode > 1) throw std::runtime_error("POS_VEL 只支持有效关节掩码及 HOLD/TRACK");
  if (s.switching || s.fault_code || !s.actual(command.mask, pos_vel) ||
      (command.mask & s.pos_vel_supported_mask) != command.mask) throw std::runtime_error("所选关节未确认 POS_VEL、存在故障或正在切换");
  if (!command.source || !command.lease || command.source != s.owner_source_id || command.lease != s.lease_id ||
      command.mask != s.selected_joint_mask) throw std::runtime_error("POS_VEL 控制许可或关节集合不匹配");
  for (size_t i = 0; i < 7; ++i) {
    if (!std::isfinite(command.position[i]) || !std::isfinite(command.velocity_limit[i])) throw std::runtime_error("POS_VEL 参数必须为有限数值");
    if (command.mask & (1u << i)) {
      if (command.velocity_limit[i] <= 0 || command.velocity_limit[i] > s.velocity_limit_max[i] ||
          (command.mode == 1 && (command.position[i] < s.position_min[i] || command.position[i] > s.position_max[i])) ||
          (command.mode == 0 && command.position[i] != 0)) throw std::runtime_error("POS_VEL 参数超出固件验证范围，或 HOLD 携带了目标位置");
    } else if (command.position[i] != 0 || command.velocity_limit[i] != 0) throw std::runtime_error("未选关节的 POS_VEL 控制字段必须为零");
  }
}

// ROS publication is local and independent of WebView/SSH scheduling. Only a
// live client can renew this bounded snapshot; publication never renews it.
struct CommandStream {
  static constexpr auto client_timeout = std::chrono::milliseconds(250);
  static constexpr auto period = std::chrono::milliseconds(20);
  std::optional<Command> command;
  Time client_at{}, published_at{};
  void clear() { command.reset(); }
  void renew(const Cache &cache, const Command &next, Time now) {
    if (command && now - client_at >= client_timeout)
      throw std::runtime_error("POS_VEL 客户端续发超时，必须停止后重新开始");
    validate_command(cache, next, now);
    command = next; client_at = now;
  }
  std::optional<Command> due(const Cache &cache, Time now) const {
    if (!command) return std::nullopt;
    if (now - client_at >= client_timeout)
      throw std::runtime_error("POS_VEL 客户端续发超时");
    validate_command(cache, *command, now);
    if (now - published_at < period) return std::nullopt;
    return command;
  }
  void published(Time now) { published_at = now; }
};

enum class Stage { Stop, Service, Readback, Finished, Uncertain };
struct Transaction {
  uint8_t action{}, requested_mode{}; // ROS CONFIGURE=1, ACQUIRE=2, RELEASE=3
  uint64_t boot{}, source{}, initial_stamp{};
  uint32_t epoch{}, mask{}, operation{}, disable_sequence{}, admitted_lease{};
  bool configure_then_release{};
  Stage stage{Stage::Stop};
  Time deadline{};
  void validate_start(const Cache &cache, Time now) const {
    cache.require_identity(boot, epoch, now);
    const auto &s = cache.status;
    if (!source || !operation || !mask_valid(mask) || action < 1 || action > 3 ||
        (requested_mode != mit && requested_mode != pos_vel)) throw std::runtime_error("V2 模式操作字段无效");
    if (!s.disabled() || s.fault_code) throw std::runtime_error("配置或获取许可前需确认输出关闭且无故障");
    if (requested_mode == pos_vel && (mask & s.pos_vel_supported_mask) != mask) throw std::runtime_error("所选关节尚未通过 POS_VEL 验证");
    if (action == 2 && (requested_mode != pos_vel || !s.actual(mask, pos_vel) || s.owner_source_id != source))
      throw std::runtime_error("获取许可前需由本连接配置 POS_VEL 并读回确认");
    if (action == 3 && (requested_mode != mit || !s.actual(all_joints, mit) || s.owner_source_id != source))
      throw std::runtime_error("释放许可前需由本连接恢复 MIT 并读回确认");
  }
  bool stopped(const Cache &cache, Time now) const {
    return cache.fresh(now) && cache.status.boot_id == boot && cache.status.control_epoch == epoch &&
        cache.status.stamp_ns > initial_stamp && cache.status.disabled() && !cache.status.fault_code &&
        cache.status.last_command_sequence == disable_sequence;
  }
  bool confirmed(const Cache &cache, Time now) const {
    if (stage != Stage::Readback || !cache.fresh(now)) return false;
    const auto &s = cache.status;
    if (s.boot_id != boot || s.stamp_ns <= initial_stamp || s.switching || s.fault_code || s.operation_id != operation ||
        s.operation_state != 2 || !s.actual(mask, requested_mode) || !s.disabled_verified || s.enabled_joint_mask || s.mode != disable) return false;
    if (action == 1) return s.control_epoch != epoch && !s.lease_id && s.owner_source_id == source;
    if (action == 2) return s.control_epoch == epoch && admitted_lease && s.lease_id == admitted_lease &&
        s.owner_source_id == source && s.selected_joint_mask == mask;
    return s.control_epoch == epoch && s.actual(all_joints, mit) && !s.lease_id && !s.owner_source_id;
  }
};
} // namespace easy_debug_bridge::motor_v2
