#include "easy_debug_bridge/motor_control_core.hpp"
#include "motor_delivery_checks.hpp"
#include <cassert>
#include <functional>
#include <limits>
using namespace easy_debug_bridge::motor_v2;
static bool rejects(const std::function<void()> &fn) { try { fn(); return false; } catch (const std::exception &) { return true; } }
static Status fixture() {
  Status s; s.protocol_version=2; s.boot_id=123; s.control_epoch=7; s.stamp_ns=100;
  s.mode=3; s.disabled_verified=true; s.verified_joint_mask=all_joints; s.pos_vel_supported_mask=0x3f;
  s.control_modes.fill(mit); s.velocity_limit_max.fill(2); s.position_min.fill(-3); s.position_max.fill(3);
  return s;
}
static void check_command_stream() {
  const auto start = Clock::now(); Cache cache; auto status = fixture();
  status.control_modes[0] = pos_vel; status.owner_source_id = 55;
  status.lease_id = 9; status.selected_joint_mask = 1; status.mode = 1;
  Command command; command.boot = status.boot_id; command.epoch = status.control_epoch;
  command.source = 55; command.lease = 9; command.mask = 1; command.mode = 1;
  command.position[0] = 0.25f; command.velocity_limit[0] = 0.1f;
  CommandStream stream;
  assert(!stream.due(cache, start));
  assert(cache.observe(status, start));
  stream.renew(cache, command, start); stream.published(start);
  assert(!stream.due(cache, start + std::chrono::milliseconds(19)));
  unsigned publications = 0;
  // One minute at a fixed (already reached) target. Client jitter exceeds the
  // firmware's 100 ms frame deadline, but stays within its own 250 ms deadline.
  for (int ms = 20; ms <= 60000; ms += 20) {
    const auto now = start + std::chrono::milliseconds(ms);
    ++status.stamp_ns; assert(cache.observe(status, now));
    if (ms % 180 == 0) stream.renew(cache, command, now);
    auto next = stream.due(cache, now); assert(next);
    assert(next->mode == 1 && next->position == command.position && next->lease == 9);
    stream.published(now); ++publications;
  }
  assert(publications == 3000);
  const auto renewed = start + std::chrono::seconds(61);
  ++status.stamp_ns; assert(cache.observe(status, renewed));
  // Use a new stream so expired state is never silently revived.
  stream.clear(); stream.renew(cache, command, renewed); stream.published(renewed);
  assert(stream.due(cache, renewed + std::chrono::milliseconds(249)));
  assert(rejects([&]{stream.due(cache, renewed + std::chrono::milliseconds(250));}));
  assert(rejects([&]{stream.renew(cache, command, renewed + std::chrono::milliseconds(250));}));
  for (int failure = 0; failure < 8; ++failure) {
    auto bad = cache; stream.clear(); stream.renew(cache, command, renewed);
    if (failure == 0) bad.status.lease_id = 0;
    if (failure == 1) ++bad.status.boot_id;
    if (failure == 2) ++bad.status.control_epoch;
    if (failure == 3) bad.status.fault_code = 11;
    if (failure == 4) bad.status.switching = true;
    if (failure == 5) bad.status.control_modes[0] = mit;
    if (failure == 6) bad.have = false;
    if (failure == 7) bad.status.owner_source_id++;
    assert(rejects([&]{stream.due(bad, renewed + std::chrono::milliseconds(20));}));
  }
  stream.clear();
  assert(!stream.due(cache, renewed + std::chrono::milliseconds(20))); // STOP/disconnect fence
}
int main() {
  check_motor_delivery();
  check_command_stream();
  const auto now=Clock::now(); Cache c;
  assert(c.mit_allowed(now)); c.discovered(); assert(!c.mit_allowed(now));
  auto s=fixture(); assert(c.observe(s,now)); assert(c.mit_allowed(now));
  assert(!c.observe(s,now+std::chrono::milliseconds(900)));
  assert(!c.mit_allowed(now+std::chrono::seconds(1))); // duplicate stamps do not renew freshness
  s.stamp_ns++; s.control_modes[0]=pos_vel; s.owner_source_id=55; assert(c.observe(s,now));
  assert(!c.mit_allowed(now));
  Transaction t; t.action=1;t.requested_mode=pos_vel;t.boot=123;t.epoch=7;t.source=55;t.mask=1;t.operation=1;
  t.initial_stamp=s.stamp_ns;t.disable_sequence=12;t.validate_start(c,now);
  assert(!t.stopped(c,now)); s.stamp_ns++;s.last_command_sequence=12;c.observe(s,now);assert(t.stopped(c,now));
  s.disabled_verified=false;s.stamp_ns++;c.observe(s,now);assert(!t.stopped(c,now));s.disabled_verified=true;
  s.enabled_joint_mask=1;s.stamp_ns++;c.observe(s,now);assert(!t.stopped(c,now));
  s.enabled_joint_mask=0;s.operation_id=1;s.operation_state=2;s.control_epoch=8;s.stamp_ns++;c.observe(s,now);
  assert(!t.confirmed(c,now));t.stage=Stage::Service;assert(!t.confirmed(c,now));
  t.stage=Stage::Readback;assert(t.confirmed(c,now)); // only post-service readback is terminal
  s.control_modes[0]=mit;s.stamp_ns++;c.observe(s,now);assert(!t.confirmed(c,now));
  s.control_modes[0]=pos_vel;s.stamp_ns++;c.observe(s,now);
  t.action=2;t.epoch=8;t.operation=2;t.initial_stamp=s.stamp_ns;t.admitted_lease=31;
  t.validate_start(c,now);s.lease_id=31;s.selected_joint_mask=1;s.operation_id=2;s.stamp_ns++;c.observe(s,now);
  assert(t.confirmed(c,now));s.lease_id=32;s.stamp_ns++;c.observe(s,now);assert(!t.confirmed(c,now));
  Command command;command.boot=123;command.epoch=8;command.source=55;command.lease=32;command.mask=1;command.mode=1;
  command.position[0]=1.2f;command.velocity_limit[0]=0.2f;validate_command(c,command,now);
  for(int failure=0;failure<10;++failure) {
    auto bad=command;
    if(failure==0)bad.boot++;if(failure==1)bad.epoch++;if(failure==2)bad.source++;
    if(failure==3)bad.lease++;if(failure==4)bad.mask=2;if(failure==5)bad.mode=2;
    if(failure==6)bad.velocity_limit[0]=0;if(failure==7)bad.position[0]=4;
    if(failure==8)bad.position[1]=1;if(failure==9)bad.velocity_limit[0]=std::numeric_limits<float>::quiet_NaN();
    assert(rejects([&]{validate_command(c,bad,now);}));
  }
  assert(rejects([&]{validate_command(c,command,now+std::chrono::seconds(1));}));
  s.position_min[0]=0.5f;s.position_max[0]=1.5f;s.stamp_ns++;c.observe(s,now);
  auto hold=command;hold.mode=0;hold.position.fill(0);validate_command(c,hold,now);
  hold.position[0]=1;assert(rejects([&]{validate_command(c,hold,now);}));
  s.lease_id=0;s.stamp_ns++;c.observe(s,now);assert(rejects([&]{validate_command(c,command,now);}));
  s.boot_id++;s.stamp_ns=1;c.observe(s,now);assert(rejects([&]{validate_command(c,command,now);}));
  assert(sequence_after(0,UINT32_MAX));assert(!sequence_after(UINT32_MAX,0));assert(!sequence_after(7,7));
  s=fixture();s.stamp_ns=200;s.velocity_limit_max[0]=std::numeric_limits<float>::infinity();assert(!c.observe(s,now));
  assert(!c.mit_allowed(now)); // malformed status never enables legacy fallback
  s=fixture();s.boot_id=125;s.stamp_ns=201;c.observe(s,now);t.action=1;t.epoch=7;t.boot=125;t.mask=0x40;
  assert(rejects([&]{t.validate_start(c,now);})); // unqualified joint7
  t.mask=1;t.action=2;assert(rejects([&]{t.validate_start(c,now);})); // MIT cannot acquire POS lease
  s.control_epoch=8;s.control_modes[0]=pos_vel;s.owner_source_id=55;s.stamp_ns++;assert(c.observe(s,now));
  auto malformed=s;malformed.velocity_limit_max[0]=std::numeric_limits<float>::infinity();assert(!c.observe(malformed,now));
  auto replay=fixture();replay.boot_id=s.boot_id;replay.stamp_ns=s.stamp_ns+1; // newer stamp, rolled-back epoch
  assert(!c.observe(replay,now));assert(!c.mit_allowed(now));
  replay=s;replay.stamp_ns--;assert(!c.observe(replay,now));
  s.stamp_ns++;assert(c.observe(s,now));assert(!c.mit_allowed(now));
  replay=s;replay.boot_id=123;replay.stamp_ns=10000;assert(!c.observe(replay,now)); // retired boot
  return 0;
}
