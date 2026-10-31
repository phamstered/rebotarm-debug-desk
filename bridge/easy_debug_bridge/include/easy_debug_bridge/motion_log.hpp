#pragma once
#include "easy_debug_bridge/position_motion_core.hpp"
#include <chrono>
#include <cstdint>
#include <deque>

namespace easy_debug_bridge {
// ROS executor-owned audit window. Full entries are also written via RCLCPP.
class MotionLog {
  struct Entry { uint64_t seq, owner; std::string json; };
  std::deque<Entry> entries_;
  uint64_t seq_{0};
 public:
  void append(uint64_t owner, const std::string &command, const std::string &phase,
              const std::string &message, const std::string &level) {
    const auto timestamp = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    const auto bounded = [](const std::string &text, size_t limit) {
      if (text.size() <= limit) return text;
      size_t end = limit;
      while (end && (static_cast<unsigned char>(text[end]) & 0xc0) == 0x80) --end;
      return text.substr(0, end);
    };
    const auto seq = ++seq_;
    entries_.push_back({seq, owner, "{\"seq\":" + std::to_string(seq) + ",\"timestamp_ms\":" + std::to_string(timestamp) +
        ",\"command_id\":" + position_json_quote(bounded(command, 80)) + ",\"phase\":" + position_json_quote(phase) +
        ",\"level\":" + position_json_quote(level) + ",\"message\":" + position_json_quote(bounded(message, 8192)) + "}"});
    if (entries_.size() > 2048) entries_.pop_front();
  }
  std::string page(uint64_t owner, uint64_t after) const {
    std::string data = "\"motion_logs\":[";
    uint64_t cursor = after; size_t count = 0;
    for (const auto &entry : entries_) {
      if (entry.seq <= after) continue;
      cursor = entry.seq;
      if (entry.owner && entry.owner != owner) continue;
      if (count++) data += ',';
      data += entry.json;
      if (count == 256) break;
    }
    return data + "],\"motion_log_cursor\":" + std::to_string(cursor) + ",\"motion_log_truncated\":" +
        (!entries_.empty() && after && after < entries_.front().seq - 1 ? "true" : "false");
  }
};
}
