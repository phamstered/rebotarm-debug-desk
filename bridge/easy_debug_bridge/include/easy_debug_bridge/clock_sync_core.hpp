#pragma once

#include <chrono>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <optional>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace easy_debug_bridge {

struct ClockSyncSnapshot {
  std::string state{"waiting"}, message{"等待 STM32 关节时间戳"};
  std::optional<double> source_offset_ms, feedback_age_ms;
  uint64_t generation{0};
  bool healthy() const { return state == "synchronized"; }
};

// Validate source time against Jetson ROS time, while liveness and convergence
// use steady time. Never rewrite a source stamp or change a motor watchdog.
class ClockSyncMonitor {
 public:
  using Clock = std::chrono::steady_clock;
  using Time = Clock::time_point;
  static constexpr double future_limit_ms = 50.;
  static constexpr double past_limit_ms = 1000.;
  static constexpr double recovery_ms = 200.;
  void new_epoch() { reset_epoch(); }

  void observe(int32_t sec, uint32_t nanosec, int64_t ros_now_ns, Time now) {
    const bool valid_stamp = sec > 0 && nanosec < 1000000000u;
    const int64_t stamp = static_cast<int64_t>(sec) * 1000000000LL + nanosec;
    const bool valid_ros_time = ros_now_ns >= 0;
    const bool ros_jump = have_sample_ && valid_ros_time && last_ros_ns_ >= 0 && std::abs(
        static_cast<long double>(ros_now_ns - last_ros_ns_) -
        std::chrono::duration<long double, std::nano>(now - received_).count()) > 250000000.L;
    const bool source_jump = have_sample_ && valid_stamp && last_stamp_valid_ &&
        stamp < last_stamp_ns_ - 50000000LL;
    const bool gap = have_sample_ && now - received_ >= std::chrono::seconds(1);
    if (ros_jump || source_jump || gap) reset_epoch();
    have_sample_ = true;
    received_ = now;
    last_ros_ns_ = ros_now_ns;
    last_stamp_ns_ = stamp;
    last_stamp_valid_ = valid_stamp;
    offset_ms_.reset();
    std::string error;
    if (!valid_ros_time) error = "Jetson ROS 时间无效";
    else if (!valid_stamp) error = "STM32 时间戳无效，等待时钟同步";
    else {
      // Subtract integer epochs before converting; arm64 macOS long double has
      // only double precision and otherwise loses the 50ms boundary at 1e18ns.
      offset_ms_ = static_cast<double>(stamp - ros_now_ns) / 1000000.;
      if (*offset_ms_ > future_limit_ms)
        error = "STM32 时间戳超前 Jetson " + milliseconds(*offset_ms_) + "，等待时钟同步";
      else if (*offset_ms_ <= -past_limit_ms)
        error = "STM32 时间戳落后 Jetson " + milliseconds(-*offset_ms_) + "，反馈时间已过期";
    }
    if (!error.empty()) {
      if (healthy_) reset_epoch();
      healthy_ = false;
      converging_ = false;
      error_ = std::move(error);
      return;
    }
    error_.clear();
    if (!converging_) { valid_since_ = now; converging_ = true; }
    if (!healthy_ && std::chrono::duration<double, std::milli>(now - valid_since_).count() >= recovery_ms) {
      healthy_ = true;
      ++generation_;
    }
  }

  ClockSyncSnapshot snapshot(int64_t ros_now_ns, Time now) const {
    ClockSyncSnapshot out;
    out.generation = generation_;
    if (!have_sample_) return out;
    out.source_offset_ms = offset_ms_;
    out.feedback_age_ms = std::chrono::duration<double, std::milli>(now - received_).count();
    if (*out.feedback_age_ms >= 1000.) {
      out.state = "stale"; out.message = "STM32 时间同步反馈已过期";
    } else if (!error_.empty()) {
      out.state = "unsynchronized"; out.message = error_;
    } else if (ros_now_ns < 0 || last_stamp_ns_ - ros_now_ns > 50000000LL ||
               ros_now_ns - last_stamp_ns_ >= 1000000000LL) {
      out.state = "unsynchronized"; out.message = "STM32 时间戳与 Jetson 时间不一致";
    } else if (!healthy_) {
      out.state = "waiting"; out.message = "等待连续有效的 STM32 时间戳";
    } else {
      out.state = "synchronized"; out.message = "STM32 时间戳与 Jetson 已对齐";
    }
    return out;
  }

 private:
  static std::string milliseconds(double value) {
    std::ostringstream out;
    out << std::fixed << std::setprecision(1) << value << " ms";
    return out.str();
  }
  void reset_epoch() {
    ++generation_;
    healthy_ = false;
    converging_ = false;
  }
  bool have_sample_{false}, last_stamp_valid_{false}, converging_{false}, healthy_{false};
  Time received_{}, valid_since_{};
  int64_t last_ros_ns_{0}, last_stamp_ns_{0};
  uint64_t generation_{0};
  std::optional<double> offset_ms_;
  std::string error_;
};

// Firmware v1's 16-field diagnostics remain supported through host stamp
// validation. v2 appends clock fields; an explicit unhealthy/stale v2 cannot be
// overridden by a plausible header timestamp.
class FirmwareClockMonitor {
 public:
  using Time = ClockSyncMonitor::Time;
  bool observe(const std::vector<uint32_t> &data, Time now) {
    if (!data.empty() && data[0] == 1 && data.size() == 16 && !supported_) return false;
    const bool valid = data.size() == 24 && data[0] == 2 && data[16] <= 2;
    const bool changed = valid && (!supported_ || generation_ != data[22]);
    supported_ = true;
    valid_ = valid;
    received_ = now;
    if (valid) {
      state_ = data[16]; age_ms_ = data[17]; failure_count_ = data[19];
      duration_ms_ = data[20]; generation_ = data[22];
    }
    return changed;
  }
  bool supported() const { return supported_; }
  uint32_t generation() const { return generation_; }
  uint32_t failure_count() const { return failure_count_; }
  uint32_t duration_ms() const { return duration_ms_; }
  std::optional<double> age_ms(Time now) const {
    if (!valid_ || age_ms_ == UINT32_MAX) return std::nullopt;
    return age_ms_ + std::chrono::duration<double, std::milli>(now - received_).count();
  }
  std::string reason(Time now) const {
    if (!supported_) return "";
    if (!valid_) return "固件时钟同步诊断无效";
    if (now - received_ >= std::chrono::seconds(3)) return "固件时钟同步诊断已过期";
    if (state_ != 1 || !age_ms(now) || *age_ms(now) >= 15000.) return "固件时钟尚未同步或同步已过期";
    return "";
  }
  void apply(ClockSyncSnapshot &snapshot, Time now) const {
    const auto error = reason(now);
    if (!error.empty()) {
      snapshot.state = "unsynchronized";
      snapshot.message = error;
    } else if (snapshot.healthy() && !supported_) {
      snapshot.message = "STM32 源时间校验正常（固件未提供同步诊断）";
    }
  }

 private:
  bool supported_{false}, valid_{false};
  uint32_t state_{0}, age_ms_{UINT32_MAX}, failure_count_{0}, duration_ms_{0}, generation_{0};
  Time received_{};
};
}  // namespace easy_debug_bridge
