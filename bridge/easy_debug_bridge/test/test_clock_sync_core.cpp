#include "easy_debug_bridge/clock_sync_core.hpp"
#include <cassert>
#include <vector>

using easy_debug_bridge::ClockSyncMonitor;
using easy_debug_bridge::FirmwareClockMonitor;
using namespace std::chrono_literals;
constexpr int64_t base = 1800000000000000000LL;
const ClockSyncMonitor::Time origin{};
void sample(ClockSyncMonitor &clock, int elapsed_ms, int offset_ms = 0) {
  const int64_t ros = base + static_cast<int64_t>(elapsed_ms) * 1000000LL;
  const int64_t stamp = ros + static_cast<int64_t>(offset_ms) * 1000000LL;
  clock.observe(static_cast<int32_t>(stamp / 1000000000LL), stamp % 1000000000LL,
                ros, origin + std::chrono::milliseconds(elapsed_ms));
}
auto state(const ClockSyncMonitor &clock, int elapsed_ms) {
  return clock.snapshot(base + static_cast<int64_t>(elapsed_ms) * 1000000LL,
                        origin + std::chrono::milliseconds(elapsed_ms));
}
int main() {
  ClockSyncMonitor clock;
  assert(state(clock, 0).state == "waiting" && !state(clock, 0).source_offset_ms);
  sample(clock, 0); sample(clock, 100);
  assert(state(clock, 100).state == "waiting");
  sample(clock, 200, -5);
  auto aligned = state(clock, 200);
  assert(aligned.healthy() && *aligned.source_offset_ms == -5 && *aligned.feedback_age_ms == 0);
  const auto first_epoch = aligned.generation;

  sample(clock, 250, 15400);
  auto future = state(clock, 250);
  assert(!future.healthy() && future.state == "unsynchronized");
  assert(future.message.find("15400.0 ms") != std::string::npos);
  assert(future.generation > first_epoch);
  sample(clock, 260, 15400);
  assert(state(clock, 260).generation == future.generation);
  sample(clock, 300); sample(clock, 490);
  assert(!state(clock, 490).healthy());
  sample(clock, 500);
  assert(state(clock, 500).healthy() && state(clock, 500).generation > future.generation);
  const auto recovered_epoch = state(clock, 500).generation;
  assert(state(clock, 1500).state == "stale");
  sample(clock, 1500);
  assert(!state(clock, 1500).healthy());
  sample(clock, 1700);
  assert(state(clock, 1700).healthy() && state(clock, 1700).generation > recovered_epoch);

  // Source timestamps and Jetson wall time can jump independently. Either
  // starts a fresh convergence window instead of clamping a future old stamp.
  clock.observe(0, 0, base, origin + 1800ms);
  assert(state(clock, 1800).state == "unsynchronized");
  clock.observe(1800000000, 1000000000u, base, origin + 1801ms);
  assert(!state(clock, 1801).healthy());
  ClockSyncMonitor boundary;
  sample(boundary, 0, 50); sample(boundary, 200, 50);
  assert(state(boundary, 200).healthy());
  sample(boundary, 250, 51);
  assert(state(boundary, 250).state == "unsynchronized");
  sample(boundary, 300, -1000);
  assert(state(boundary, 300).state == "unsynchronized");
  sample(boundary, 500, -999); sample(boundary, 700, -999);
  assert(state(boundary, 700).healthy());
  // A ROS-time jump with an otherwise plausible stamp must still reset epoch.
  const auto before_jump = state(boundary, 700).generation;
  boundary.observe(1800000020, 800000000, base + 20800000000LL, origin + 800ms);
  assert(boundary.snapshot(base + 20800000000LL, origin + 800ms).generation > before_jump);
  assert(!boundary.snapshot(base + 20800000000LL, origin + 800ms).healthy());

  FirmwareClockMonitor firmware;
  assert(!firmware.observe(std::vector<uint32_t>(16, 1), origin));
  assert(!firmware.supported());
  std::vector<uint32_t> diagnostics(24, 0);
  diagnostics[0] = 2; diagnostics[16] = 1; diagnostics[17] = 20;
  diagnostics[19] = 3; diagnostics[20] = 4; diagnostics[22] = 7;
  assert(firmware.observe(diagnostics, origin));
  assert(firmware.supported() && firmware.reason(origin).empty());
  assert(firmware.failure_count() == 3 && firmware.duration_ms() == 4);
  assert(*firmware.age_ms(origin + 100ms) == 120);
  assert(!firmware.observe(diagnostics, origin + 1s));
  assert(!firmware.reason(origin + 4s).empty()); // Diagnostic receipt TTL is 3s.
  diagnostics[22] = 8;
  assert(firmware.observe(diagnostics, origin + 4s));
  diagnostics[16] = 2;
  firmware.observe(diagnostics, origin + 5s);
  auto gated = aligned;
  firmware.apply(gated, origin + 5s);
  assert(!gated.healthy() && gated.message.find("固件") != std::string::npos);
  diagnostics[16] = 1; diagnostics[17] = 14900;
  firmware.observe(diagnostics, origin + 6s);
  assert(firmware.reason(origin + 6050ms).empty());
  assert(!firmware.reason(origin + 6100ms).empty());
  assert(!firmware.reason(origin + 6200ms).empty()); // Holdover cannot live forever.
  diagnostics[17] = UINT32_MAX;
  firmware.observe(diagnostics, origin + 7s);
  assert(!firmware.age_ms(origin + 7s) && !firmware.reason(origin + 7s).empty());
  firmware.observe({2, 1}, origin + 8s);
  assert(!firmware.reason(origin + 8s).empty());
  FirmwareClockMonitor unknown;
  unknown.observe({3}, origin);
  assert(unknown.supported() && !unknown.reason(origin).empty());
  return 0;
}
