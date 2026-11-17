#pragma once
#include <algorithm>
#include <charconv>
#include <chrono>
#include <cstdint>
#include <deque>
#include <functional>
#include <limits>
#include <optional>
#include <set>
#include <string>

namespace easy_debug_bridge::motor_delivery {
using Clock = std::chrono::steady_clock;
using Time = Clock::time_point;
using Send = std::function<void(const std::string &, Time)>;
struct Reply {
  uint64_t owner;
  Send send;
  std::string json;
  bool status;
  Time generated_at;
};
// The caller holds its mutex. A blocked socket occupies at most one worker.
class Queue {
 public:
  void push(Reply reply) {
    if (reply.status) {
      const auto existing = std::find_if(pending_.begin(), pending_.end(), [&](const auto &r) {
        return r.status && r.owner == reply.owner;
      });
      if (existing != pending_.end()) { *existing = std::move(reply); return; }
      if (pending_.size() >= 64) return;
    }
    pending_.push_back(std::move(reply));
  }
  bool ready() const {
    return std::any_of(pending_.begin(), pending_.end(), [&](const auto &r) { return !active_.count(r.owner); });
  }
  std::optional<Reply> take() {
    auto available = [&](const auto &r) { return !active_.count(r.owner); };
    auto found = std::find_if(pending_.begin(), pending_.end(), [&](const auto &r) { return !r.status && available(r); });
    if (found == pending_.end()) found = std::find_if(pending_.begin(), pending_.end(), available);
    if (found == pending_.end()) return std::nullopt;
    Reply result = std::move(*found); pending_.erase(found); active_.insert(result.owner); return result;
  }
  void finished(uint64_t owner) { active_.erase(owner); }
  void erase(uint64_t owner) {
    pending_.erase(std::remove_if(pending_.begin(), pending_.end(), [owner](const auto &r) { return r.owner == owner; }), pending_.end());
  }
  void clear() { pending_.clear(); }
 private:
  std::deque<Reply> pending_;
  std::set<uint64_t> active_;
};

// Include source age in the monotonic cache age; absent/stale/future ROS time
// never becomes fresh merely because its DDS delivery has just arrived.
inline std::optional<Time> received_at(uint64_t stamp_ns, int64_t ros_now_ns, Time now) {
  if (!stamp_ns || ros_now_ns <= 0 || stamp_ns > uint64_t(std::numeric_limits<int64_t>::max())) return std::nullopt;
  const int64_t age = ros_now_ns - int64_t(stamp_ns);
  if (age < -50000000LL || age >= 1000000000LL) return std::nullopt;
  return now - std::chrono::nanoseconds(std::max<int64_t>(age, 0));
}

// This edits only two scalar tokens in Bridge-generated JSON. It deliberately
// avoids a property_tree JSON round trip, which turns booleans/numbers into strings.
inline std::optional<std::string> age_payload(std::string json, Time generated, Time now,
                                             uint64_t write_budget_ms = 250) {
  const auto object = json.find("\"motor_control\":{");
  if (object == std::string::npos) return json;
  const auto age_key = json.find("\"age_ms\":", object);
  const auto fresh_key = json.find("\"fresh\":", object);
  if (age_key == std::string::npos || fresh_key == std::string::npos) return std::nullopt;
  const auto age_begin = age_key + 9;
  const auto age_end = json.find_first_not_of("0123456789", age_begin);
  if (age_end == std::string::npos || age_begin == age_end || (json[age_end] != ',' && json[age_end] != '}')) return std::nullopt;
  uint64_t age = 0;
  const auto parsed = std::from_chars(json.data() + age_begin, json.data() + age_end, age);
  if (parsed.ec != std::errc{} || parsed.ptr != json.data() + age_end) return std::nullopt;
  const auto wait = std::chrono::duration_cast<std::chrono::milliseconds>(now - generated).count();
  const uint64_t queued = wait > 0 ? uint64_t(wait) : 0;
  age = queued > std::numeric_limits<uint64_t>::max() - age ? std::numeric_limits<uint64_t>::max() : age + queued;
  const auto fresh_begin = fresh_key + 8;
  const bool was_fresh = json.compare(fresh_begin, 4, "true") == 0;
  const auto fresh_size = was_fresh ? 4U : 5U;
  if ((!was_fresh && json.compare(fresh_begin, 5, "false") != 0) ||
      fresh_begin + fresh_size >= json.size() ||
      (json[fresh_begin + fresh_size] != ',' && json[fresh_begin + fresh_size] != '}')) return std::nullopt;
  // Reserve the bounded socket write time as well; a nearly expired proof is
  // stale before transmission, rather than becoming a fresh-looking late packet.
  age = write_budget_ms > std::numeric_limits<uint64_t>::max() - age ? std::numeric_limits<uint64_t>::max() : age + write_budget_ms;
  const bool fresh = was_fresh && age < 1000;
  if (fresh_begin > age_begin) {
    json.replace(fresh_begin, fresh_size, fresh ? "true" : "false");
    json.replace(age_begin, age_end - age_begin, std::to_string(age));
  } else {
    json.replace(age_begin, age_end - age_begin, std::to_string(age));
    json.replace(fresh_begin, fresh_size, fresh ? "true" : "false");
  }
  return json;
}
} // namespace easy_debug_bridge::motor_delivery
