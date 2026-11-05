#include <unistd.h>

#include <atomic>
#include <boost/property_tree/json_parser.hpp>
#include <cassert>
#include <fstream>
#include <mutex>
#include <thread>

#include "easy_debug_bridge/visual_pick.hpp"
using namespace easy_debug_bridge;
using Tree = boost::property_tree::ptree;
static Tree parse(const std::string &s) {
  Tree t;
  std::istringstream in(s);
  boost::property_tree::read_json(in, t);
  return t;
}
int main() {
  const auto path = "/tmp/easy-debug-visual-pick-" + std::to_string(getpid()) + ".json";
  auto config = [&](bool calibrated) {
    std::ofstream f(path);
    f << "{\"calibrated\":" << (calibrated ? "true" : "false")
      << ",\"scene_verified\":true,\"grasp_to_tcp\":{\"position\":[0,0,0],\"orientation\":[0,0,0,1]}}";
  };
  config(false);
  ObjectBox box{1, {.2, .1, .05}, {.05, .04, .06}, 100};
  auto plan = make_pick_plan(box, load_pick_config(path));
  assert(std::abs(plan.opening - .025) < 1e-9);
  bool reject = false;
  try {
    auto bad = box;
    bad.size[0] = bad.size[1] = .3;
    make_pick_plan(bad, load_pick_config(path));
  } catch (...) {
    reject = true;
  }
  assert(reject);
  auto turn = plan.tcp;
  turn.orientation = {1, 0, 0, 0};
  auto step = bounded_pick_step(plan.pre_tcp, turn, .01);
  assert(tcp_pose_position_error(plan.pre_tcp, step) <= .010001 &&
         tcp_pose_orientation_error(plan.pre_tcp, step) <= .150001);
  std::atomic<int> moves{0}, grips{0}, cancel_requests{0};
  std::atomic<bool> lost{false}, hold{false}, release{false}, frozen{false}, flip{false},
      static_frames{false}, pose_ready{true};
  std::atomic<uint64_t> sequence{10};
  int contact_observations = 0;
  TcpPose actual = plan.pre_tcp;
  std::mutex pose_mutex, callback_mutex;
  VisualPick::Send pending;
  auto motion = [&](uint64_t, const Tree &r, VisualPick::Send send) {
    const auto op = r.get<std::string>("op");
    if (op == "position_motion_info") {
      send(
          "{\"op\":\"position_motion_info\",\"available\":true,\"tcp_pose_supported\":true,\"busy\":false,"
          "\"gripper_available\":true,\"gripper_feedback_fresh\":true,\"gripper_lower\":0,\"gripper_upper\":"
          "0.0715}");
      return;
    }
    if (op == "position_cancel") {
      ++cancel_requests;
      VisualPick::Send done;
      {
        std::lock_guard<std::mutex> lock(callback_mutex);
        done = pending;
      }
      if (done)
        done(release ? "{\"op\":\"position_motion\",\"motion_phase\":\"canceled\",\"message\":\"stopped\"}"
                     : "{\"op\":\"position_motion\",\"motion_phase\":\"stop_failed\",\"message\":"
                       "\"unconfirmed\"}");
      return;
    }
    assert(op == "position_move" && r.get<std::string>("confirmation") == "ARMED");
    const auto child_id = r.get<std::string>("command_id");
    assert(child_id.size() <= 80 &&
           child_id.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-") ==
               std::string::npos);
    ++moves;
    if (r.get_child_optional("tcp_pose")) {
      if (!frozen) {
        std::lock_guard<std::mutex> lock(pose_mutex);
        size_t i = 0;
        for (const auto &v : r.get_child("tcp_pose.position"))
          actual.position[i++] = v.second.get_value<double>();
        i = 0;
        for (const auto &v : r.get_child("tcp_pose.orientation"))
          actual.orientation[i++] = v.second.get_value<double>();
      }
    } else {
      ++grips;
      assert(r.get<std::string>("joint_name") == "gripper_finger_left_joint");
    }
    send("{\"op\":\"position_move_ack\",\"accepted\":true}");
    if (hold) {
      std::lock_guard<std::mutex> lock(callback_mutex);
      pending = send;
      return;
    }
    send("{\"op\":\"position_motion\",\"motion_phase\":\"succeeded\"}");
  };
  auto observe = [&](uint64_t owner, const std::string &token, uint64_t id) {
    if (owner != 1 || token != "lease" || id != 1 || lost) throw std::runtime_error("target lost");
    auto observed = box;
    if (flip) {
      std::lock_guard<std::mutex> lock(pose_mutex);
      if (std::abs(actual.position[2] - .065) < 1e-6 && ++contact_observations >= 2)
        std::swap(observed.size[0], observed.size[1]);
    }
    return PickObservation{observed, token, static_frames ? sequence.load() : sequence.fetch_add(1), 2};
  };
  VisualPick pick(path, motion, observe, [&](const std::string &) {
    if (!pose_ready) throw std::runtime_error("TCP feedback unavailable");
    std::lock_guard<std::mutex> lock(pose_mutex);
    return actual;
  });
  Tree request = parse("{\"op\":\"visual_pick_preview\",\"subscription_id\":\"lease\",\"object_id\":1}");
  Tree reply;
  auto capture = [&](const std::string &s) { reply = parse(s); };
  pick.request(1, request, capture);
  assert(!reply.get<bool>("execution_ready"));
  assert(moves == 0);
  request.put("op", "visual_pick_start");
  request.put("confirmation", "ARMED");
  request.put("command_id", "test");
  reject = false;
  try {
    pick.request(1, request, capture);
  } catch (...) {
    reject = true;
  }
  assert(reject && moves == 0);
  config(true);
  auto calibrated = load_pick_config(path);
  calibrated.grasp_to_tcp.position = {.1, 0, .1};
  const auto offset_plan = make_pick_plan(box, calibrated);
  assert(std::abs(offset_plan.tcp.position[0] - .2) < 1e-9 &&
         std::abs(offset_plan.tcp.position[1] - .2) < 1e-9);
  assert(std::abs(offset_plan.tcp.position[2] - .165) < 1e-9);

  auto refresh_preview = [&]() {
    auto p = request;
    p.put("op", "visual_pick_preview");
    pick.request(1, p, [&](const std::string &s) {
      request.put("preview_frame_seq", parse(s).get<uint64_t>("frame_seq"));
    });
  };
  refresh_preview();
  auto wait = [&](bool heartbeat = true) {
    const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(8);
    while (pick.busy() && std::chrono::steady_clock::now() < until) {
      if (heartbeat) {
        Tree r;
        r.put("op", "visual_pick_status");
        pick.request(1, r, [](const std::string &) {});
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    assert(!pick.busy());
  };
  pose_ready = false;
  request.put("command_id", "missing-tcp");
  refresh_preview();
  pick.request(1, request, [](const std::string &) {});
  wait();
  assert(moves == 0);
  pose_ready = true;
  request.put("command_id", "test");
  refresh_preview();
  // Run the full isolated observe -> segment -> close -> lift sequence with fake motion success.
  pick.request(1, request, [](const std::string &) {});
  wait();
  assert(moves > 5 && grips == 2);
  Tree status;
  status.put("op", "visual_pick_status");
  pick.request(1, status, capture);
  assert(reply.get<std::string>("pick_phase") == "holding");
  // Explicit cancellation keeps the lock until the fake backend confirms a terminal stop.
  hold = true;
  release = false;
  const int before_cancel = moves;
  request.put("command_id", "cancel-test");
  refresh_preview();
  pick.request(1, request, [](const std::string &) {});
  while (moves == before_cancel) std::this_thread::sleep_for(std::chrono::milliseconds(10));
  reject = false;
  try {
    pick.request(2, parse("{\"op\":\"visual_pick_cancel\"}"), capture);
  } catch (...) {
    reject = true;
  }
  assert(reject);
  pick.cancel(1);
  const auto stop_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  do {
    pick.request(1, status, capture);
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  } while (reply.get<std::string>("pick_phase") != "stop_failed" &&
           std::chrono::steady_clock::now() < stop_deadline);
  assert(pick.busy() && reply.get<std::string>("pick_phase") == "stop_failed");
  release = true;
  wait();
  assert(cancel_requests > 0);
  // Observation loss while a goal is admitted causes cancellation, never a follow-up segment.
  lost = false;
  release = true;
  const int before = moves;
  request.put("command_id", "lost-test");
  refresh_preview();
  pick.request(1, request, [](const std::string &) {});
  while (moves == before) std::this_thread::sleep_for(std::chrono::milliseconds(10));
  lost = true;
  wait();
  assert(moves == before + 1);
  pick.request(1, status, capture);
  assert(reply.get<std::string>("pick_phase") == "failed");
  lost = false;
  const int before_lease = moves;
  request.put("command_id", "lease-test");
  refresh_preview();
  pick.request(1, request, [](const std::string &) {});
  wait(false);
  assert(moves == before_lease + 1);
  pick.request(1, status, capture);
  assert(reply.get<std::string>("pick_phase") == "failed");
  reject = false;
  auto expired = request;
  expired.put("command_id", "expired-preview");
  try {
    pick.request(1, expired, capture);
  } catch (const std::exception &e) {
    reject = std::string(e.what()).find("预览已过期") != std::string::npos;
  }
  assert(reject);
  refresh_preview();
  // Replaying a completed task must not run another Pick.
  reject = false;
  try {
    pick.request(1, request, capture);
  } catch (...) {
    reject = true;
  }
  assert(reject);
  // A nonconverging measured TCP exhausts the bounded approach without closing or lifting.
  hold = false;
  frozen = true;
  {
    std::lock_guard<std::mutex> lock(pose_mutex);
    actual.position = {0, 0, .4};
  }
  const int previous_grips = grips;
  request.put("command_id", "not-converging");
  refresh_preview();
  pick.request(1, request, [](const std::string &) {});
  wait();
  assert(grips == previous_grips + 1);
  pick.request(1, status, capture);
  assert(reply.get<std::string>("pick_phase") == "failed");
  // A yaw change at the final observation cannot close or rotate a held object unexpectedly.
  frozen = false;
  flip = true;
  contact_observations = 0;
  {
    std::lock_guard<std::mutex> lock(pose_mutex);
    actual = plan.pre_tcp;
  }
  const int grips_before_flip = grips;
  request.put("command_id", "final-yaw-change");
  refresh_preview();
  pick.request(1, request, [](const std::string &) {});
  wait();
  assert(grips == grips_before_flip + 1);
  pick.request(1, status, capture);
  assert(reply.get<std::string>("pick_phase") == "failed");
  flip = false;
  // Reusing a fresh-but-unchanged image cannot drive another servo segment.
  static_frames = true;
  {
    std::lock_guard<std::mutex> lock(pose_mutex);
    actual = plan.pre_tcp;
  }
  const int before_stale = moves, grips_before_stale = grips;
  request.put("command_id", "unchanged-image");
  refresh_preview();
  pick.request(1, request, [](const std::string &) {});
  wait();
  assert(moves == before_stale + 1 && grips == grips_before_stale + 1);
  pick.request(1, status, capture);
  assert(reply.get<std::string>("pick_phase") == "failed");
  // Wrong subscription and invalid/unknown request fields are rejected without motion.
  auto bad = request;
  bad.put("subscription_id", "old");
  reject = false;
  try {
    pick.request(1, bad, capture);
  } catch (...) {
    reject = true;
  }
  assert(reject);
  bad = request;
  bad.put("arbitrary_topic", "unsafe");
  reject = false;
  try {
    pick.request(1, bad, capture);
  } catch (...) {
    reject = true;
  }
  assert(reject);
  std::remove(path.c_str());
}
