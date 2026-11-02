#pragma once
#include "easy_debug_bridge/motion_arrival.hpp"
#include <optional>

namespace easy_debug_bridge {
enum class GroupHoldResult { ready, recovering, velocity_timeout };
struct GroupHoldRecovery {
  bool ready{true};
  std::optional<double> unstable_since, stable_since, last_sample;
  static constexpr double stable_seconds = .2, recovery_seconds = 5.;
  GroupHoldResult observe(double now, double sample, bool stopped) {
    if (!std::isfinite(now) || !std::isfinite(sample) || sample > now || (last_sample && sample < *last_sample))
      throw std::runtime_error("停留反馈接收时间无效");
    const bool new_sample = !last_sample || sample > *last_sample;
    if (!ready && unstable_since && now - *unstable_since > recovery_seconds + 1e-9) {
      if (!stopped || (last_sample && sample - *last_sample >= 1.)) stable_since.reset();
      last_sample = sample; return GroupHoldResult::velocity_timeout;
    }
    if (!stopped) {
      if (ready) unstable_since = now;
      ready = false; stable_since.reset();
    } else if (!ready && new_sample) {
      if (last_sample && sample - *last_sample >= 1.) stable_since.reset();
      if (!stable_since) stable_since = sample;
      if (sample - *stable_since + 1e-9 >= stable_seconds) {
        ready = true; unstable_since.reset();
      }
    }
    last_sample = sample;
    if (ready) return GroupHoldResult::ready;
    if (unstable_since && now - *unstable_since + 1e-9 >= recovery_seconds) return GroupHoldResult::velocity_timeout;
    return GroupHoldResult::recovering;
  }
  double stable_for_ms() const {
    if (!stable_since || !last_sample) return 0.;
    const auto end = unstable_since ? std::min(*last_sample, *unstable_since + recovery_seconds) : *last_sample;
    return std::max(0., end - *stable_since) * 1000;
  }
};
inline bool group_hold_position_valid(const std::vector<std::string> &names, const std::vector<double> &reference,
    const std::vector<double> &actual) {
  if (names.empty() || reference.size() != names.size() || actual.size() != names.size()) return false;
  for (size_t i = 0; i < names.size(); ++i)
    if (!std::isfinite(reference[i]) || !std::isfinite(actual[i]) ||
        std::abs(actual[i] - reference[i]) > (names[i] == gripper_motion_joint() ? .001 : .02)) return false;
  return true;
}
struct GroupHoldFailure {
  std::string reason, phase;
  double captured_at_ms{}, feedback_age_ms{}, stable_for_ms{};
  std::vector<MotionArrivalError> samples;
};
inline std::string group_hold_failure_json(const GroupHoldFailure &failure) {
  std::ostringstream out; out << std::setprecision(17)
      << "{\"reason\":" << position_json_quote(failure.reason) << ",\"phase\":" << position_json_quote(failure.phase)
      << ",\"captured_at_ms\":" << failure.captured_at_ms << ",\"feedback_age_ms\":" << failure.feedback_age_ms
      << ",\"stable_for_ms\":" << failure.stable_for_ms << ",\"required_stable_ms\":200,\"samples\":"
      << motion_arrival_json(failure.samples) << '}';
  return out.str();
}
}
