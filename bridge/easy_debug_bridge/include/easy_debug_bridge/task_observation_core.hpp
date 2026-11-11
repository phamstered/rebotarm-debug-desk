#pragma once
#include <deque>
#include <optional>
#include <stdexcept>
#include <string>

namespace easy_debug_bridge {
inline bool valid_motion_command_id(const std::string &id) {
  return !id.empty() && id.size() <= 80 &&
      id.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-") == std::string::npos;
}
inline bool motion_terminal_phase(const std::string &phase) {
  return phase == "succeeded" || phase == "failed" || phase == "canceled";
}
// Only the motion executor accesses this bounded evidence store. A new Bridge
// process starts empty: absence is unknown, never evidence that a goal stopped.
class MotionTerminalHistory {
  struct Entry { std::string id, phase, state; };
  std::deque<Entry> entries_;
  size_t bytes_{};
 public:
  void record(const std::string &id, const std::string &phase, const std::string &state = "null") {
    if (!valid_motion_command_id(id) || !motion_terminal_phase(phase))
      throw std::runtime_error("运动终态记录无效");
    for (auto it = entries_.begin(); it != entries_.end(); ++it) {
      if (it->id == id) { bytes_ -= it->state.size(); entries_.erase(it); break; }
    }
    if (state.size() > 256 * 1024) return;
    entries_.push_back({id, phase, state}); bytes_ += state.size();
    while (entries_.size() > 256 || bytes_ > 2 * 1024 * 1024) { bytes_ -= entries_.front().state.size(); entries_.pop_front(); }
  }
  std::optional<std::string> find(const std::string &id) const {
    for (const auto &entry : entries_) if (entry.id == id) return entry.phase;
    return std::nullopt;
  }
  std::string state(const std::string &id) const {
    for (const auto &entry : entries_) if (entry.id == id) return entry.state;
    return "null";
  }
};
}
