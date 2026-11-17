#pragma once
#include "easy_debug_bridge/motor_delivery.hpp"
#include <cassert>
inline void check_motor_delivery() {
  namespace delivery = easy_debug_bridge::motor_delivery;
  using namespace std::chrono;
  const auto now = delivery::Clock::now();
  delivery::Queue queue;
  const delivery::Send send = [](const std::string &, delivery::Time) {};
  queue.push({1, send, "slow owner first", true, now});
  auto slow = queue.take(); assert(slow && slow->owner == 1);
  // A socket blocked in its write does not consume a second sender for that owner.
  for (int i=0;i<20;++i) queue.push({1,send,"status " + std::to_string(i),true,now+milliseconds(i)});
  assert(!queue.ready()); assert(!queue.take());
  queue.push({2,send,"other status",true,now});
  queue.push({3,send,"terminal",false,now});
  auto terminal=queue.take(); assert(terminal && terminal->owner==3);
  auto other=queue.take(); assert(other && other->owner==2);
  assert(!queue.take()); // slow owner never occupies all four workers
  queue.finished(2); queue.finished(3);
  queue.push({1,send,"stop error",false,now});
  queue.finished(1);
  auto error=queue.take(); assert(error && error->json=="stop error");
  assert(!queue.take()); queue.finished(1);
  auto latest=queue.take(); assert(latest && latest->json=="status 19" && latest->generated_at==now+milliseconds(19));
  queue.push({1,send,"discard on disconnect",false,now}); queue.erase(1);
  queue.finished(1); assert(!queue.ready());
  queue.push({4,send,"after reconnect",false,now}); assert(queue.ready()); queue.clear(); assert(!queue.ready());

  const std::string payload=R"({"op":"motor_control_status","motor_control":{"supported":true,"fresh":true,"reason":"", "age_ms":100,"boot_id":"12","disabled_verified":true}})";
  auto aged=delivery::age_payload(payload,now,now+milliseconds(200));
  assert(aged && aged->find("\"age_ms\":550")!=std::string::npos);
  assert(aged->find("\"fresh\":true")!=std::string::npos);
  assert(aged->find("\"supported\":true")!=std::string::npos); // native JSON types preserved
  aged=delivery::age_payload(payload,now,now+milliseconds(650));
  assert(aged && aged->find("\"fresh\":false")!=std::string::npos); // 250 ms write budget expires the proof
  aged=delivery::age_payload(payload,now,now+seconds(2));
  assert(aged && aged->find("\"age_ms\":2350")!=std::string::npos && aged->find("\"fresh\":false")!=std::string::npos);
  auto stale=payload; stale.replace(stale.find("\"fresh\":true"),12,"\"fresh\":false");
  aged=delivery::age_payload(stale,now,now); assert(aged && aged->find("\"fresh\":false")!=std::string::npos);
  const std::string reversed=R"({"motor_control":{"age_ms":50,"fresh":true}})";
  aged=delivery::age_payload(reversed,now,now+milliseconds(100));
  assert(aged && *aged==R"({"motor_control":{"age_ms":400,"fresh":true}})");
  assert(!delivery::age_payload(R"({"motor_control":{"age_ms":"0","fresh":true}})",now,now));
  assert(!delivery::age_payload(R"({"motor_control":{"age_ms":0,"fresh":"true"}})",now,now));
  const std::string ack=R"({"op":"motor_command_v2_ack","sequence":4})";
  assert(delivery::age_payload(ack,now,now+seconds(5))==ack);
  aged=delivery::age_payload(R"({"motor_control":{"age_ms":18446744073709551615,"fresh":true}})",now,now+seconds(5));
  assert(aged && aged->find("\"fresh\":false")!=std::string::npos);

  assert(!delivery::received_at(0,1000000000,now));
  assert(!delivery::received_at(1,0,now));
  assert(!delivery::received_at(2000000001,3000000001,now)); // one second old at source
  assert(!delivery::received_at(3050000001,3000000000,now)); // >50ms future
  const auto received=delivery::received_at(2500000000,3000000000,now);
  assert(received && now-*received==milliseconds(500));
  assert(delivery::received_at(3050000000,3000000000,now)==now); // permitted skew cannot rejuvenate beyond receipt
}
