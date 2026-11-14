#include "easy_debug_bridge/joint4_task_core.hpp"
#include <cassert>
#include <iostream>
using namespace easy_debug_bridge;
using Core=Joint4TaskCore;
using namespace std::chrono_literals;
Core::Observation observation(int64_t stamp=1000) {
  Core::Observation o;o.ros_now=stamp;o.joint_stamp=stamp;o.hardware_stamp=stamp;o.clock_generation=1;
  o.status_revision=uint64_t(stamp);o.fresh=true;o.stopped=true;o.pose_released=true;o.mode=1;return o;
}
int main() {
  const auto at=Core::Time{}+1s;
  { // Release cannot overtake a delayed Begin or an in-flight Capture.
    Core c;c.start(1,"a","begin_pose",at);auto begin=c.call("begin_pose","",true,at);
    c.cancel();assert(!c.release_due(at+10s));assert(c.busy());
    assert(!c.observe(observation(2000),at+10s));
    assert(!c.result(begin.serial+1,true,observation(),at));assert(c.active()->pending);
    assert(c.result(begin.serial,true,observation(),at+10s));assert(c.release_due(at+10s));
    auto release=c.call("release_pose","",false,at+10s);assert(!c.release_due(at+30s));
    c.result(release.serial,true,observation(),at+30s);
    assert(!c.observe(observation(),at+31s)); // source replay cannot build settling time
    assert(!c.observe(observation(2000),at+31s));
    auto end=c.observe(observation(3000),at+31s+201ms);
    assert(end&&end->phase=="canceled"&&end->evidence=="pose_released");
  }
  {
    Core c;c.start(1,"b","begin_pose",at);auto b=c.call("begin_pose","",true,at);c.result(b.serial,true,observation(),at);
    assert(!c.observe(observation(2000),at+1s));assert(c.renew(1,"b",at+4s));assert(!c.renew(2,"b",at+4s));
    c.tick(at+8s);assert(!c.active()->cancel);c.tick(at+9s);assert(c.active()->cancel);
    assert(!c.renew(1,"b",at+9s));assert(c.release_due(at+9s));
  }
  {
    Core c;c.start(1,"c","begin_pose",at);auto b=c.call("begin_pose","",true,at);c.result(b.serial,true,observation(),at);
    auto sample=c.call("capture_pose","sample",false,at);c.cancel();assert(!c.release_due(at+5s));
    c.result(sample.serial,true,observation(),at);assert(c.active()->captured);assert(c.release_due(at));
    bool rejected=false;try{c.call("capture_pose","again",false,at);}catch(...){rejected=true;}assert(rejected);
  }
  { // A fresh post-release DISABLE sequence is separate from soft release.
    Core c;c.start(1,"d","release_pose",at);auto release=c.call("release_pose","",true,at);c.disable();
    c.disabled_sent(10,observation(),at);c.result(release.serial,true,observation(2000),at+1ms);
    auto o=observation(3000);o.mode=3;o.sequence=10;assert(!c.observe(o,at+1s));
    assert(c.disable_due(at+1s));c.disabled_sent(20,observation(3000),at+1s);
    o=observation(4000);o.mode=3;o.sequence=19;assert(!c.observe(o,at+2s));
    o.sequence=20;assert(!c.observe(o,at+2s));o=observation(5000);o.mode=3;o.sequence=20;
    auto end=c.observe(o,at+2s+201ms);assert(end&&end->evidence=="output_disabled");
  }
  {
    Core c;c.start(1,"e","reset",at);auto reset=c.call("reset","",true,at);c.result(reset.serial,true,observation(),at);
    auto o=observation(2000);assert(!c.observe(o,at+1s));o.fresh=false;assert(!c.observe(o,at+2s));
    o=observation(3000);assert(!c.observe(o,at+3s));o=observation(4000);o.clock_generation=2;assert(!c.observe(o,at+4s));
    o=observation(5000);assert(!c.observe(o,at+5s));o=observation(6000);
    auto end=c.observe(o,at+5s+201ms);assert(end&&end->phase=="succeeded"&&end->evidence=="service_verified");
  }
  {
    Core c;c.start(1,"f","fit",at);auto fit=c.call("fit","",true,at);c.result(fit.serial,false,observation(),at);
    assert(!c.observe(observation(2000),at+1s));assert(c.release_due(at));
    auto release=c.call("release_pose","",false,at);c.result(release.serial,false,observation(),at);
    assert(!c.release_due(at+999ms));assert(c.release_due(at+1s));
    release=c.call("release_pose","",false,at+1s);c.result(release.serial,true,observation(),at+1s);
    assert(!c.observe(observation(2000),at+2s));auto end=c.observe(observation(3000),at+2s+201ms);
    assert(end&&end->phase=="failed"&&end->evidence=="service_rejected");
  }
  std::cout<<"Joint4 lifecycle tests passed\n";
}
