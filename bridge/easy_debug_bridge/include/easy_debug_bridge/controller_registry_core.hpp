#pragma once
#include "easy_debug_bridge/controller_health.hpp"
#include "easy_debug_bridge/position_motion_core.hpp"
#include <set>

namespace easy_debug_bridge {
struct RegistryController { std::string name, type_name, state; std::vector<std::string> claimed_interfaces; };
// A slot lives from admission through queued reply and the complete send. Slow
// output must not reopen capacity while it still retains a response/owner.
class ControllerRequestBudget {
 public:
  bool reserve(uint64_t owner) {
    const auto found = owners.find(owner);
    if (total >= 64 || (found != owners.end() && found->second >= 8)) return false;
    ++owners[owner]; ++total; return true;
  }
  void release(uint64_t owner) {
    const auto found = owners.find(owner);
    if (found == owners.end()) return;
    --total;
    if (--found->second == 0) owners.erase(found);
  }
  size_t count() const { return total; }
 private:
  size_t total{};
  std::map<uint64_t, size_t> owners;
};
struct ControllerRegistrySnapshot {
  bool supported{true}, has_snapshot{false}, failed{false}, fresh{false}, query_pending{false};
  uint64_t sequence{}, started_query{}, completed_query{};
  double age_ms{}, time_ms{}, retry_after_ms{}, latency_s{};
  ControllerHealthPoll::Time received_at{};
  std::string query_state{"waiting"}, message{"等待 ControllerManager 首次查询"};
  std::vector<RegistryController> controllers;
};
class ControllerRegistryCore {
 public:
  using Time = ControllerHealthPoll::Time;
  ControllerHealthPoll poll;
  ControllerRegistrySnapshot cache;
  uint64_t start(Time now) { const auto generation = poll.start(now); ++cache.started_query; return generation; }
  bool matches(uint64_t generation) const { return poll.matches(generation); }
  void fail(Time now, const std::string &state, const std::string &message) {
    if (poll.pending()) cache.completed_query = cache.started_query;
    poll.failed(now); cache.failed = true; cache.query_state = state; cache.message = message;
  }
  void success(Time now, double unix_ms, std::vector<RegistryController> rows) {
    if (rows.size() > 1024 || !std::isfinite(unix_ms) || unix_ms < 0) throw std::runtime_error("ControllerManager 响应过大或时间无效");
    std::set<std::string> names;
    size_t bytes = 0;
    for (const auto &row : rows) {
      if (row.name.empty() || row.name.size() > 512 || row.type_name.size() > 512 || row.state.size() > 128 ||
          !names.insert(row.name).second || row.claimed_interfaces.size() > 512)
        throw std::runtime_error("ControllerManager 包含无效/重复控制器字段");
      bytes += row.name.size() + row.type_name.size() + row.state.size();
      for (const auto &claim : row.claimed_interfaces) {
        if (claim.size() > 512) throw std::runtime_error("ControllerManager 接口字段过长");
        bytes += claim.size();
      }
      if (bytes > 2 * 1024 * 1024) throw std::runtime_error("ControllerManager 快照超过 2 MiB");
    }
    cache.latency_s = poll.latency(now); cache.controllers = std::move(rows);
    cache.has_snapshot = true; cache.failed = false; cache.received_at = now; cache.time_ms = unix_ms;
    ++cache.sequence; cache.completed_query = cache.started_query;
    cache.query_state = "ready"; cache.message.clear(); poll.succeeded(now);
  }
  ControllerRegistrySnapshot snapshot(Time now) const {
    auto result = cache;
    result.query_pending = poll.pending(); result.retry_after_ms = poll.pending() ? 0. : poll.retry_after_ms(now);
    result.age_ms = result.has_snapshot ? std::max(0., std::chrono::duration<double, std::milli>(now - result.received_at).count()) : 0.;
    result.fresh = result.supported && result.has_snapshot && !result.failed && result.age_ms < 3100.;
    if (poll.expired(now)) {
      result.fresh = false; result.failed = true; result.query_state = "timeout";
      result.message = "arm_trajectory_controller 状态查询超时（ListControllers ≥2s）";
    }
    if (!result.supported) { result.query_state = "unsupported"; result.message = "Bridge 未编译 controller_manager_msgs 支持"; }
    else if (result.query_pending && !poll.expired(now)) result.query_state = "pending";
    else if (!result.failed && result.has_snapshot && !result.fresh) { result.query_state = "stale"; result.message = "arm_trajectory_controller 状态已过期（ListControllers >3.1s）"; }
    return result;
  }
};
inline std::string controller_registry_json(const ControllerRegistrySnapshot &value, const std::string &request_id,
    const std::string &request_error = "", double request_wait_ms = 0.) {
  std::ostringstream out; out << std::setprecision(17)
      << "{\"op\":\"controllers_info\",\"request_id\":" << position_json_quote(request_id)
      << ",\"supported\":" << (value.supported ? "true" : "false") << ",\"manager\":\"/controller_manager\",\"available\":"
      << (value.fresh && request_error.empty() ? "true" : "false") << ",\"fresh\":" << (value.fresh && request_error.empty() ? "true" : "false")
      << ",\"has_snapshot\":" << (value.has_snapshot ? "true" : "false") << ",\"snapshot_sequence\":" << value.sequence;
  out << ",\"request_wait_ms\":" << std::clamp(request_wait_ms, 0., 5000.);
  if (value.has_snapshot) out << ",\"snapshot_age_ms\":" << value.age_ms << ",\"snapshot_time_ms\":" << value.time_ms;
  out << ",\"query_state\":" << position_json_quote(request_error.empty() ? value.query_state : "error")
      << ",\"query_pending\":" << (value.query_pending ? "true" : "false") << ",\"retry_after_ms\":" << value.retry_after_ms
      << ",\"message\":" << position_json_quote(request_error.empty() ? value.message : request_error) << ",\"controllers\":[";
  for (size_t i = 0; i < value.controllers.size(); ++i) {
    if (i) out << ',';
    const auto &row = value.controllers[i];
    out << "{\"name\":" << position_json_quote(row.name) << ",\"type_name\":" << position_json_quote(row.type_name)
        << ",\"state\":" << position_json_quote(row.state) << '}';
  }
  return out.str() + "]}";
}
}
