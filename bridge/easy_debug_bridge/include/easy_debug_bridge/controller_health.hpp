#pragma once

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <stdexcept>

namespace easy_debug_bridge {
// Transport scheduling only: controller validity and live telemetry keep their
// independent safety deadlines. All calls belong to the motion callback group.
class ControllerHealthPoll {
 public:
  using Clock = std::chrono::steady_clock;
  using Time = Clock::time_point;
  static constexpr double validity_seconds = 3.1;
  bool pending() const { return pending_; }
  bool due(Time now) const { return !pending_ && now >= next_; }
  bool expired(Time now) const {
    return pending_ && now - requested_ >= std::chrono::seconds(2);
  }
  bool matches(uint64_t generation) const { return pending_ && generation == generation_; }
  double latency(Time now) const { return std::chrono::duration<double>(now - requested_).count(); }
  double retry_after_ms(Time now) const { return std::max(0., std::chrono::duration<double, std::milli>(next_ - now).count()); }
  void expedite_success(Time now) { if (!pending_ && failures_ == 0) next_ = std::min(next_, now); }
  uint64_t start(Time now) {
    if (!due(now)) throw std::logic_error("Controller health query already pending or in backoff");
    pending_ = true;
    requested_ = now;
    return ++generation_;
  }
  void succeeded(Time now) {
    pending_ = false;
    failures_ = 0;
    next_ = now + std::chrono::seconds(1);
  }
  void failed(Time now) {
    pending_ = false;
    ++generation_; // A canceled/expired response can never restore readiness.
    next_ = now + std::chrono::seconds(1u << std::min(failures_, 3u));
    failures_ = std::min(failures_ + 1, 3u);
  }

 private:
  bool pending_{false};
  unsigned failures_{0};
  uint64_t generation_{0};
  Time requested_{}, next_{};
};
}  // namespace easy_debug_bridge
