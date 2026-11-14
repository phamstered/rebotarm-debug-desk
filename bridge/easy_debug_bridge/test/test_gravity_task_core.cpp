#include "easy_debug_bridge/gravity_task_core.hpp"
#include <cassert>
#include <iostream>
using namespace easy_debug_bridge;
int main() {
  GravityTaskCore task;using Clock=GravityTaskCore::Clock;
  const auto t=Clock::now();task.start(1,"first",t);
  try {task.start(2,"second",t);assert(false);} catch(const std::runtime_error &) {}
  assert(!task.renew(2,"first",t+std::chrono::seconds(4)));
  assert(task.cancel_due(t+std::chrono::seconds(5)));
  assert(!task.renew(1,"first",t+std::chrono::seconds(5)));
  assert(!task.cancel_due(t+std::chrono::milliseconds(5500)));
  task.accepted("first");assert(task.active()->phase=="canceling");
  task.result("wrong","succeeded","{}",t,10,10);assert(!task.active()->result_received);
  task.result("first","canceled","{\"result\":1}",t,10,10);
  assert(!task.cancel_due(t+std::chrono::seconds(10)));
  assert(!task.observe_stop(t+std::chrono::seconds(1),10,10,true));
  assert(!task.observe_stop(t+std::chrono::seconds(1),11,11,true));
  assert(!task.observe_stop(t+std::chrono::seconds(2),11,11,true));
  assert(!task.observe_stop(t+std::chrono::seconds(2),12,12,false));
  assert(!task.observe_stop(t+std::chrono::seconds(3),13,13,true));
  auto done=task.observe_stop(t+std::chrono::milliseconds(3201),14,14,true);
  assert(done && done->id=="first" && task.terminal("first")=="canceled" && !task.busy());
  assert(task.retained("first")=="{\"result\":1}");
  assert(!task.terminal("unknown"));
  try {task.start(1,"first",t);assert(false);} catch(const std::runtime_error &) {}
  task.start(2,"next",t);task.lost(1);assert(!task.active()->cancel_requested);
  task.lost(2);assert(task.active()->cancel_requested);
  task.rejected("first","{}");assert(task.busy());task.rejected("next","{}");assert(!task.busy());
  for(int i=0;i<300;++i){auto id="id-"+std::to_string(i);task.start(1,id,t);task.rejected(id,"{}");}
  assert(!task.terminal("first"));assert(task.terminal("id-299"));
  task.start(1,"disable",t);task.disable();task.result("disable","canceled","{}",t,1,1);
  assert(!task.disable_due(t+std::chrono::milliseconds(299)));
  assert(task.disable_due(t+std::chrono::milliseconds(300)));
  task.disabled_sent(42,t+std::chrono::milliseconds(300));
  assert(!task.observe_stop(t+std::chrono::seconds(1),2,2,true,0,42));
  assert(!task.observe_stop(t+std::chrono::seconds(2),3,3,true,3,41));
  assert(!task.observe_stop(t+std::chrono::seconds(3),4,4,true,3,42));
  assert(task.observe_stop(t+std::chrono::milliseconds(3201),5,5,true,3,42));
  std::cout<<"Gravity task core tests passed\n";
}
