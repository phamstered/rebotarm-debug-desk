#include "easy_debug_bridge/trajectory_task_core.hpp"
#include "easy_debug_bridge/direct_trajectory_validation.hpp"
#include <cassert>
#include <iostream>
using namespace easy_debug_bridge;
using Core=TrajectoryTaskCore;
using namespace std::chrono_literals;
const Core::Time origin=Core::Time{}+60s;
constexpr int64_t source=10000000000LL;
TrajectoryCommand command() {
  return {"/arm/joint_trajectory",{"joint1","finger"},{{{0.,0.},{},.1},{{.5,.02},{0.,0.},.4}}};
}
void reserve(Core &core,const std::string &id="first") {
  core.reserve(1,id,command(),{{.01,.02},{.001,.002}},7,origin);
}
void start(Core &core) {reserve(core);core.sending("first",source,origin);}
Core::Feedback feedback(std::chrono::milliseconds elapsed) {
  Core::Feedback f;f.clock_epoch=7;f.clock_valid=true;
  f.ros_now=source+std::chrono::duration_cast<std::chrono::nanoseconds>(elapsed).count();
  f.reference={f.ros_now,origin+elapsed,{"finger","joint1"},{.02,.5},{0.,0.}};
  f.reference.trajectory_elapsed_ns=std::chrono::duration_cast<std::chrono::nanoseconds>(elapsed).count();
  f.actual=f.reference;f.joint=f.reference;
  // Hardware JointState can include non-controller joints and another order.
  f.joint.names={"joint1","finger","extra"};f.joint.positions={.5,.02,8.};f.joint.velocities={0.,0.,1.};
  f.status_stamp=f.ros_now;f.status_received=origin+elapsed;f.mode=0;f.sequence=12;
  return f;
}
template<class F> void rejects(F operation) {
  try {operation();assert(false);} catch(const std::runtime_error &) {}
}
int main() {
  {
    Core rejected;start(rejected);
    assert(!rejected.reject_unpublished("first")); // Published task cannot become unsent.
    assert(rejected.reject_unpublished("other"));assert(rejected.matches("first"));
    assert(!rejected.reject_unpublished("other"));assert(!rejected.reject_unpublished("bad id"));
    assert(rejected.result("other")->evidence=="not_published");
    Core pending;reserve(pending);assert(pending.reject_unpublished("first"));assert(!pending.busy());
  }
  {
    PositionMotionModel model;model.joint_names={"joint1"};model.lower={-1.};model.upper={1.};
    TrajectoryCommand path{"/arm_trajectory_controller/joint_trajectory",{"joint1"},{{{0.},{0.},.1},{{.1},{0.},2.}}};
    validate_direct_trajectory(path,model,{0.},{0.},{1.},{1.});
    // Matching knots alone do not prove the seed-to-first segment safe.
    rejects([&]{validate_direct_trajectory(path,model,{.5},{0.},{1.},{1.});});
    auto bad=path;bad.points[1].positions={2.};
    rejects([&]{validate_direct_trajectory(bad,model,{0.},{0.},{1.},{1.});});
    bad=path;bad.points[1].time_from_start=.10000000001;
    rejects([&]{validate_direct_trajectory(bad,model,{0.},{0.},{1.},{1.});});
    // Cubic interpolation can exceed position limits even if knots are valid.
    bad=path;bad.points[1].positions={.9};bad.points[0].positions={.9};bad.points[0].velocities={3.};
    rejects([&]{validate_direct_trajectory(bad,model,{.9},{3.},{100.},{100.});});
    for (auto &point:path.points) point.velocities.clear();
    validate_direct_trajectory(path,model,{0.},{0.},{1.},{1.});
    rejects([&]{validate_direct_trajectory(path,model,{0.},{0.},{.01},{1.});});
    path.joint_names={gripper_motion_joint()};model.joint_names=path.joint_names;
    rejects([&]{validate_direct_trajectory(path,model,{0.},{0.},{1.},{1.});});
  }
  // Admission, bounded input and explicit pre-publication rejection.
  Core c;
  rejects([&]{c.reserve(0,"first",command(),{{.01,.02},{.001,.002}},7,origin);});
  reserve(c);assert(c.busy());
  rejects([&]{reserve(c,"second");});
  assert(!c.renew(2,"first",origin+4s));assert(!c.renew(1,"wrong",origin+4s));
  assert(c.renew(1,"first",origin+1s));
  c.lost(2);assert(!c.active()->stopping);
  c.cancel("first");rejects([&]{c.sending("first",source,origin);});
  assert(c.reject("first") && c.result("first")->evidence=="not_published");
  rejects([&]{reserve(c);});
  auto invalid=command();invalid.points.back().time_from_start=std::numeric_limits<double>::max();
  rejects([&]{c.reserve(1,"long",invalid,{{.01,.02},{.001,.002}},7,origin);});
  rejects([&]{c.reserve(1,"bad",command(),{{.01,.02}},7,origin);});
  auto moving=command();moving.points.back().velocities[0]=.001;
  rejects([&]{c.reserve(1,"moving-end",moving,{{.01,.02},{.001,.002}},7,origin);});
  reserve(c,"overflow");rejects([&]{c.sending("overflow",std::numeric_limits<int64_t>::max(),origin);});
  assert(c.reject("overflow"));

  // Publication is not completion; actual arrival requires every named source.
  Core normal;start(normal);assert(!normal.reject("first"));
  assert(!normal.observe(feedback(200ms),origin+200ms));
  assert(!normal.observe(feedback(400ms),origin+400ms));
  assert(!normal.observe(feedback(400ms),origin+650ms)); // Replay cannot settle.
  auto done=normal.observe(feedback(650ms),origin+650ms);
  assert(done && done->phase=="succeeded" && done->evidence=="target_observed");
  assert(!normal.busy() && normal.result("first")->phase=="succeeded");
  assert(!normal.result("unknown"));

  // Each malformed/stale/future/wrong-unit sample resets the settling interval.
  for (int fault=0;fault<19;++fault) {
    Core task;start(task);assert(!task.observe(feedback(400ms),origin+400ms));
    auto f=feedback(650ms);
    switch(fault) {
      case 0:f.reference.positions[0]=.024;break; // prismatic tolerance
      case 1:f.actual.positions[1]=.53;break;
      case 2:f.joint.positions[0]=.53;break;
      case 3:f.joint.velocities[1]=.01;break;
      case 4:f.reference.velocities[1]=.1;break;
      case 5:f.actual.names={"finger","finger"};break;
      case 6:f.joint.names[0]="missing";break;
      case 7:f.actual.positions[1]=std::numeric_limits<double>::quiet_NaN();break;
      case 8:f.joint.velocities.clear();break;
      case 9:f.status_received=origin;break;
      case 10:f.reference.stamp=f.actual.stamp=f.ros_now+1;break;
      case 11:f.joint.stamp=f.ros_now-1000000000LL;break;
      case 12:f.mode=3;break; // unexpected output-off is not success
      case 13:f.actual.stamp-=1;break; // actual/reference must share one callback
      case 14:f.mode=2;break; // RETURN is not an arrived JTC target
      case 16:f.reference.trajectory_elapsed_ns=-1;break;
      case 17:f.reference.trajectory_elapsed_ns+=1000000000LL;break; // old controller origin
      case 18:f.reference.trajectory_elapsed_ns=std::numeric_limits<int64_t>::max();break;
      case 15:f.reference.velocities[0]=.001;break; // low measured speed is not a stationary reference
    }
    assert(!task.observe(f,origin+650ms));assert(task.busy());
    assert(!task.observe(feedback(700ms),origin+700ms));
    assert(task.observe(feedback(950ms),origin+950ms));
  }

  // Same endpoint and fresh idle feedback from the previous trajectory do
  // not prove that a delayed zero-header command was consumed, even on cancel.
  for (bool cancel:{false,true}) {
    Core delayed;start(delayed);
    if(cancel){delayed.cancel("first");delayed.disabled_sent("first",12,origin+100ms,source,source,source);}
    for (auto elapsed:{500ms,750ms}) {
      auto old=feedback(elapsed);old.reference.trajectory_elapsed_ns+=1000000000LL;
      if(cancel)old.mode=3;
      assert(!delayed.observe(old,origin+elapsed));assert(delayed.busy());
    }
    // Actual JTC start is 700 ms after publication; 400 ms duration plus
    // 200 ms settling is measured from that consumption, not from publish.
    for (auto elapsed:{900ms,1100ms,1350ms}) {
      auto frame=feedback(elapsed);frame.reference.trajectory_elapsed_ns-=700000000LL;
      if(cancel)frame.mode=3;
      auto result=delayed.observe(frame,origin+elapsed);
      assert(bool(result)==(elapsed==1350ms));
    }
  }

  // Source expiry alone and a fresh output-off ACK never release a pending
  // controller reference. A delayed trajectory cannot be ignored on re-enable.
  Core canceled;start(canceled);canceled.lost(1);assert(canceled.disable_due(origin+100ms));
  canceled.disabled_sent("wrong",90,origin+100ms,source,source,source);
  assert(!canceled.active()->disable_sequence);
  canceled.disabled_sent("first",90,origin+100ms,source,source,source);
  assert(!canceled.disable_due(origin+1000ms));assert(canceled.disable_due(origin+1100ms));
  auto off=feedback(200ms);off.mode=3;off.sequence=90;
  assert(!canceled.observe(off,origin+200ms)); // Before source end.
  off=feedback(500ms);off.mode=3;off.sequence=89;
  assert(!canceled.observe(off,origin+500ms));
  off=feedback(600ms);off.mode=3;off.sequence=90;off.reference.positions[1]=.2;
  assert(!canceled.observe(off,origin+600ms));
  off=feedback(700ms);off.mode=3;off.sequence=90;off.actual.positions[1]=.2;off.joint.positions[0]=.2;
  assert(!canceled.observe(off,origin+700ms)); // Canceled: measured stop may be off-target.
  off=feedback(950ms);off.mode=3;off.sequence=90;off.actual.positions[1]=.2;off.joint.positions[0]=.2;
  done=canceled.observe(off,origin+950ms);assert(done && done->phase=="canceled" && done->evidence=="output_disabled");

  // A repeated disable establishes a new source baseline and fresh sequence.
  Core retry;start(retry);retry.cancel("first");
  retry.disabled_sent("first",90,origin+100ms,source,source,source);
  off=feedback(500ms);off.mode=3;off.sequence=90;assert(!retry.observe(off,origin+500ms));
  retry.disabled_sent("first",91,origin+600ms,source+600000000,source+600000000,source+600000000);
  off=feedback(650ms);off.mode=3;off.sequence=90;assert(!retry.observe(off,origin+650ms));
  off=feedback(700ms);off.mode=3;off.sequence=91;assert(!retry.observe(off,origin+700ms));
  off=feedback(950ms);off.mode=3;off.sequence=91;assert(retry.observe(off,origin+950ms));

  // Lease expiry and bounded arrival deadline request stop, never success.
  Core stale;start(stale);stale.tick(origin+1s);assert(stale.active()->stopping);
  Core lease;start(lease);
  for(int ms=500;ms<=5000;ms+=500) {
    auto elapsed=std::chrono::milliseconds(ms);auto frame=feedback(elapsed);
    frame.reference.positions[1]=.1;
    assert(!lease.observe(frame,origin+elapsed));
    assert(lease.active()->stopping==(ms==5000)); // Fresh feedback cannot renew the owner lease.
  }
  assert(lease.disable_due(origin+5s));
  Core deadline;start(deadline);
  for(int ms=500;ms<=5500;ms+=500) {
    auto elapsed=std::chrono::milliseconds(ms);auto frame=feedback(elapsed);
    frame.reference.positions[1]=.1;
    assert(deadline.renew(1,"first",origin+elapsed));
    assert(!deadline.observe(frame,origin+elapsed));
    assert(deadline.active()->stopping==(ms==5500)); // Both feedback and lease are fresh.
  }
  assert(!deadline.renew(1,"first",origin+6s));
  for (bool changed:{false,true}) {
    Core clock;start(clock);auto f=feedback(500ms);
    if(changed)f.clock_epoch=8;else f.clock_valid=false;
    assert(!clock.observe(f,origin+500ms));assert(clock.active()->phase=="uncertain");
    clock.disabled_sent("first",90,origin+500ms,source,source,source);
    off=feedback(800ms);off.mode=3;off.sequence=90;
    assert(!clock.observe(off,origin+800ms));assert(clock.busy()); // Old epoch cannot be revived.
  }
  Core history;
  for(int i=0;i<300;++i){const auto id="id-"+std::to_string(i);reserve(history,id);assert(history.reject(id));}
  assert(!history.result("id-0") && history.result("id-299"));
  std::cout<<"Direct trajectory task core tests passed\n";
}
