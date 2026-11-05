#include <atomic>
#include <boost/property_tree/json_parser.hpp>
#include <condition_variable>
#include <deque>
#include <map>
#include <mutex>
#include <set>
#include <thread>

#include "easy_debug_bridge/visual_pick.hpp"

namespace easy_debug_bridge {
using Tree = boost::property_tree::ptree;
using Clock = std::chrono::steady_clock;
static Tree parse(const std::string &s) {
  Tree t;
  std::istringstream in(s);
  boost::property_tree::read_json(in, t);
  return t;
}
static std::string vec(const std::array<double, 3> &v) {
  std::ostringstream o;
  o << "[" << v[0] << "," << v[1] << "," << v[2] << "]";
  return o.str();
}
static std::string pose_json(const TcpPose &p) {
  std::ostringstream o;
  o << "{\"position\":" << vec(p.position) << ",\"orientation\":[" << p.orientation[0] << ","
    << p.orientation[1] << "," << p.orientation[2] << "," << p.orientation[3] << "]}";
  return o.str();
}
PickConfig load_pick_config(const std::string &path) {
  Tree t;
  boost::property_tree::read_json(path, t);
  PickConfig c;
  c.calibrated = t.get<bool>("calibrated", false);
  c.scene_verified = t.get<bool>("scene_verified", false);
  c.tcp_link = t.get<std::string>("tcp_link", "gripper_link");
  if (c.tcp_link.empty() || c.tcp_link.size() > 128) throw std::runtime_error("Invalid Pick TCP link");
  auto scalar = [&](const char *key, double &v, double lo, double hi) {
    v = t.get<double>(key, v);
    if (!std::isfinite(v) || v < lo || v > hi)
      throw std::runtime_error(std::string("Invalid Pick config: ") + key);
  };
  scalar("table_z_m", c.table_z, -2, 2);
  scalar("grasp_depth_m", c.depth, 0, .04);
  scalar("pregrasp_clearance_m", c.clearance, .05, .2);
  scalar("lift_m", c.lift, .03, .2);
  scalar("jaw_gap_at_zero_m", c.jaw_gap_zero, 0, .05);
  scalar("opening_margin_m", c.opening_margin, .004, .03);
  scalar("compression_m", c.compression, 0, .003);
  auto array = [&](const char *key, auto &out) {
    const auto &a = t.get_child(key);
    size_t i = 0;
    for (const auto &v : a) {
      if (i >= out.size() || !v.first.empty()) throw std::runtime_error("Invalid Pick transform array");
      out[i++] = v.second.get_value<double>();
    }
    if (i != out.size()) throw std::runtime_error("Incomplete Pick transform");
  };
  array("grasp_to_tcp.position", c.grasp_to_tcp.position);
  array("grasp_to_tcp.orientation", c.grasp_to_tcp.orientation);
  c.grasp_to_tcp = validate_tcp_pose(c.grasp_to_tcp);
  for (double x : c.grasp_to_tcp.position)
    if (std::abs(x) > .5) throw std::runtime_error("Pick TCP offset exceeds .5 m");
  return c;
}
PickPlan make_pick_plan(const ObjectBox &b, const PickConfig &c) {
  for (int a = 0; a < 3; ++a)
    if (!std::isfinite(b.center[a]) || std::abs(b.center[a]) > 3 || !std::isfinite(b.size[a]) ||
        b.size[a] <= 0 || b.size[a] > .5)
      throw std::runtime_error("Invalid Pick object bounds");
  const double width = std::min(b.size[0], b.size[1]);
  if (width < .015 || width > .13) throw std::runtime_error("物体可见宽度不在首版抓取范围 15–130 mm");
  PickPlan p;
  p.grasp.position = b.center;
  p.grasp.position[2] += b.size[2] / 2;
  if (c.calibrated) {
    if (p.grasp.position[2] < c.table_z + .025)
      throw std::runtime_error("物体离桌高度不足，拒绝生成接触动作");
    p.grasp.position[2] = std::max(c.table_z + .01, p.grasp.position[2] - c.depth);
  }
  // Grasp-frame +X is jaw closing direction, +Z points up. AABB supplies two yaw candidates.
  if (b.size[1] < b.size[0]) p.grasp.orientation = {0, 0, std::sqrt(.5), std::sqrt(.5)};
  p.pregrasp = p.grasp;
  p.pregrasp.position[2] += c.clearance;
  p.tcp = tcp_pose_compose(p.grasp, c.grasp_to_tcp);
  p.pre_tcp = tcp_pose_compose(p.pregrasp, c.grasp_to_tcp);
  p.opening = (width + c.opening_margin - c.jaw_gap_zero) / 2;
  p.closing = (width - c.compression - c.jaw_gap_zero) / 2;
  return p;
}
TcpPose bounded_pick_step(const TcpPose &actual, const TcpPose &target, double length) {
  const auto a = validate_tcp_pose(actual), b = validate_tcp_pose(target);
  auto next = b;
  const double d = tcp_pose_position_error(a, b), angle = tcp_pose_orientation_error(a, b);
  if (d > length)
    for (int i = 0; i < 3; ++i)
      next.position[i] = a.position[i] + (b.position[i] - a.position[i]) * length / d;
  if (angle > .15) {
    double dot = 0;
    for (int i = 0; i < 4; ++i) dot += a.orientation[i] * b.orientation[i];
    const double t = .15 / angle, theta = angle / 2, denom = std::sin(theta);
    for (int i = 0; i < 4; ++i)
      next.orientation[i] = (std::sin((1 - t) * theta) * a.orientation[i] +
                             std::sin(t * theta) * (dot < 0 ? -1 : 1) * b.orientation[i]) /
                            denom;
  }
  return validate_tcp_pose(next);
}
struct VisualPick::Impl {
  std::string config_path;
  Motion motion;
  Observe observe;
  Pose pose;
  std::atomic<bool> active{false}, canceled{false}, shutdown{false};
  mutable std::mutex mutex;
  uint64_t owner = 0;
  std::string id, phase = "idle", message;
  Clock::time_point heartbeat;
  std::thread worker;
  std::deque<std::string> accepted_ids;
  struct Preview {
    PickObservation observed;
    PickConfig config;
    Clock::time_point created;
  };
  std::map<uint64_t, Preview> previews;
  struct Call {
    std::mutex mutex;
    bool terminal = false, rejected = false, admitted = false, uncertain = false;
    std::string error, phase;
    Tree reply;
  };
  Impl(std::string path, Motion m, Observe o, Pose p)
      : config_path(std::move(path)), motion(std::move(m)), observe(std::move(o)), pose(std::move(p)) {}
  std::string state(const std::string &request_id = "") const {
    std::lock_guard<std::mutex> lock(mutex);
    return "{\"op\":\"visual_pick_state\",\"request_id\":" + position_json_quote(request_id) +
           ",\"command_id\":" + position_json_quote(id) + ",\"pick_phase\":" + position_json_quote(phase) +
           ",\"message\":" + position_json_quote(message) + ",\"busy\":" + (active ? "true" : "false") + "}";
  }
  void update(const std::string &p, const std::string &msg, const Send &send) {
    {
      std::lock_guard<std::mutex> lock(mutex);
      phase = p;
      message = msg;
    }
    send(state());
  }
  void finish(const std::string &p, const std::string &msg, const Send &send) {
    {
      std::lock_guard<std::mutex> lock(mutex);
      phase = p;
      message = msg;
      active = false;
    }
    send(state());
  }
  void check_lease() {
    if (shutdown || canceled) throw std::runtime_error("抓取已取消");
    std::lock_guard<std::mutex> lock(mutex);
    if (Clock::now() - heartbeat > std::chrono::seconds(3)) throw std::runtime_error("抓取客户端心跳超时");
  }
  std::shared_ptr<Call> dispatch(uint64_t who, Tree request) {
    auto call = std::make_shared<Call>();
    motion(who, request, [call](const std::string &text) {
      std::lock_guard<std::mutex> lock(call->mutex);
      try {
        auto t = parse(text);
        const auto op = t.get<std::string>("op", "");
        if (op == "position_move_ack" && t.get<bool>("accepted", false)) {
          call->admitted = true;
        } else if (op == "error" && call->admitted) {
          call->uncertain = true;
          call->error = t.get<std::string>("message", "运动响应异常");
        } else if (op == "error" || (op == "position_move_ack" && !t.get<bool>("accepted", false))) {
          call->rejected = true;
          call->error = t.get<std::string>("message", "运动被拒绝");
          call->terminal = true;
        } else if (op == "position_motion") {
          call->phase = t.get<std::string>("motion_phase", "");
          call->error = t.get<std::string>("message", "");
          if (call->phase == "succeeded" || call->phase == "failed" || call->phase == "canceled") {
            call->terminal = true;
            call->error = t.get<std::string>("message", "");
          }
        } else if (op == "position_motion_info") {
          call->reply = t;
          call->terminal = true;
        }
      } catch (...) {
        call->error = "运动响应无效";
        call->uncertain = true;
      }
    });
    return call;
  }
  Tree info(uint64_t who) {
    Tree r;
    r.put("op", "position_motion_info");
    auto call = dispatch(who, r);
    const auto deadline = Clock::now() + std::chrono::seconds(4);
    while (!shutdown) {
      {
        std::lock_guard<std::mutex> lock(call->mutex);
        if (call->terminal) {
          if (call->rejected) throw std::runtime_error(call->error);
          return call->reply;
        }
      }
      if (Clock::now() > deadline) throw std::runtime_error("MoveIt 状态查询超时");
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    throw std::runtime_error("Bridge 关闭");
  }
  void move(uint64_t who, Tree request, const Send &send, const std::function<void()> &guard) {
    check_lease();
    if (guard) guard();
    const auto command = request.get<std::string>("command_id");
    auto call = dispatch(who, request);
    const auto began = Clock::now();
    auto ping = began;
    bool stopping = false, reported_stop_failure = false;
    std::string reason;
    while (!shutdown) {
      bool underlying_stop_failed = false;
      {
        std::lock_guard<std::mutex> lock(call->mutex);
        underlying_stop_failed = call->phase == "stop_failed";
        if (call->terminal) {
          if (stopping) throw std::runtime_error(reason + "；已确认运动终态");
          if (call->rejected || call->phase != "succeeded")
            throw std::runtime_error(call->error.empty() ? "运动未成功" : call->error);
          return;
        }
      }
      if (underlying_stop_failed && !reported_stop_failure) {
        stopping = true;
        reason = "底层运动停止未确认";
        reported_stop_failure = true;
        update("stop_failed", "底层运动停止未确认，保留抓取锁，请检查现场", send);
      }
      if (!stopping) try {
          {
            std::lock_guard<std::mutex> lock(call->mutex);
            if (call->uncertain || call->phase == "canceling" || call->phase == "stopping")
              throw std::runtime_error(call->error.empty() ? "底层运动正在停止" : call->error);
          }
          check_lease();
          if (guard) guard();
          if (Clock::now() - began > std::chrono::seconds(120)) throw std::runtime_error("抓取单段超时");
        } catch (const std::exception &e) {
          reason = e.what();
          stopping = true;
          update("canceling", reason + "，等待停止确认", send);
        }
      if (Clock::now() - ping > std::chrono::milliseconds(500)) {
        ping = Clock::now();
        Tree r;
        r.put("op", stopping ? "position_cancel" : "position_motion_info");
        r.put("command_id", command);
        motion(who, r, [](const std::string &) {});
        if (stopping && !reported_stop_failure && Clock::now() - began > std::chrono::seconds(125)) {
          reported_stop_failure = true;
          update("stop_failed", "停止未确认，保留抓取运动锁，请检查现场", send);
        }
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    throw std::runtime_error("Bridge 关闭");
  }
  void run(uint64_t who, Tree request, PickConfig config, PickObservation initial, Send send) {
    const auto began = Clock::now();
    try {
      auto status = info(who);
      if (!status.get<bool>("available", false) || !status.get<bool>("tcp_pose_supported", false))
        throw std::runtime_error(status.get<std::string>("message", "TCP 规划未就绪"));
      if (status.get<bool>("busy", false) || !status.get<bool>("gripper_available", false) ||
          !status.get<bool>("gripper_feedback_fresh", false))
        throw std::runtime_error(status.get<std::string>("gripper_message", "夹爪未就绪或已有运动"));
      validate_tcp_pose(pose(config.tcp_link));  // Reject missing/stale TCP TF before opening the gripper.
      const auto plan = make_pick_plan(initial.box, config);
      const double lo = status.get<double>("gripper_lower"), hi = status.get<double>("gripper_upper");
      if (!std::isfinite(lo) || !std::isfinite(hi) || lo >= hi || plan.opening < lo || plan.opening > hi ||
          plan.closing < lo || plan.closing > hi)
        throw std::runtime_error("抓取开度超出实测夹爪标定范围");
      unsigned segment = 0;
      auto task_guard = [&]() {
        check_lease();
        if (Clock::now() - began > std::chrono::seconds(180)) throw std::runtime_error("抓取任务超过 180 秒");
      };
      auto current = [&]() {
        task_guard();
        auto o = observe(who, initial.subscription, initial.box.id);
        if (o.generation != initial.generation || o.sequence < initial.sequence)
          throw std::runtime_error("视觉时间基准改变");
        double d = 0;
        for (int a = 0; a < 3; ++a) {
          d += std::pow(o.box.center[a] - initial.box.center[a], 2);
          if (std::abs(o.box.size[a] - initial.box.size[a]) > .04)
            throw std::runtime_error("目标形状明显变化");
        }
        if (d > .05 * .05) throw std::runtime_error("目标位移超过 5 cm，需重新选择");
        return o;
      };
      uint64_t used_sequence = initial.sequence;
      auto next_observation = [&]() {
        const auto until = Clock::now() + std::chrono::milliseconds(500);
        while (true) {
          auto o = current();
          if (o.sequence > used_sequence) {
            used_sequence = o.sequence;
            return o;
          }
          if (Clock::now() >= until) throw std::runtime_error("等待新视觉帧超时，未继续下一段");
          std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
      };
      auto base = [&]() {
        Tree r;
        r.put("op", "position_move");
        r.put("confirmation", "ARMED");
        r.put("command_id", request.get<std::string>("command_id") + "-vp-" + std::to_string(++segment));
        return r;
      };
      auto grip = [&](double value) {
        auto r = base();
        r.put("joint_name", "gripper_finger_left_joint");
        r.put("joint_position", value);
        return r;
      };
      auto tcp = [&](TcpPose target) {
        auto r = base();
        auto p = parse(pose_json(target));
        p.put("frame_id", "base_link");
        p.put("tcp_link", config.tcp_link);
        r.add_child("tcp_pose", p);
        return r;
      };
      auto guard = [&]() { current(); };
      update("opening", "张开夹爪", send);
      move(who, grip(plan.opening), send, guard);
      TcpPose grasp_target;
      for (const bool descending : {false, true}) {
        update(descending ? "descending" : "approaching",
               descending ? "分段下降，持续核对目标" : "分段接近预抓取位", send);
        bool reached = false;
        for (unsigned step = 0; step < 30; ++step) {
          auto observed = next_observation();
          auto desired = make_pick_plan(observed.box, config);
          if (std::abs(desired.opening - plan.opening) > .003)
            throw std::runtime_error("目标宽度变化，需重新选择");
          const auto target = descending ? desired.tcp : desired.pre_tcp;
          const auto actual = pose(config.tcp_link);
          const double distance = tcp_pose_position_error(actual, target);
          if (distance <= .006 && tcp_pose_orientation_error(actual, target) <= .02) {
            grasp_target = desired.tcp;
            reached = true;
            break;
          }
          const auto next = bounded_pick_step(actual, target, descending ? .01 : .02);
          const auto anchor = observed.box;
          move(who, tcp(next), send, [&]() {
            auto live = current();
            double shift = 0;
            for (int a = 0; a < 3; ++a) shift += std::pow(live.box.center[a] - anchor.center[a], 2);
            if (shift > .02 * .02) throw std::runtime_error("单段运动期间目标移动超过 2 cm");
          });
        }
        if (!reached) throw std::runtime_error("视觉接近未在 30 段内收敛");
      }
      const auto final_plan = make_pick_plan(next_observation().box, config);
      const auto final_actual = pose(config.tcp_link);
      if (std::abs(final_plan.opening - plan.opening) > .003 || final_plan.closing < lo ||
          final_plan.closing > hi || tcp_pose_position_error(final_actual, final_plan.tcp) > .006 ||
          tcp_pose_orientation_error(final_actual, final_plan.tcp) > .02)
        throw std::runtime_error("闭合前目标变化，需重新选择");
      grasp_target = final_plan.tcp;
      update("closing", "闭合夹爪；夹持结果需要另行确认", send);
      move(who, grip(final_plan.closing), send, task_guard);
      check_lease();
      auto lift = grasp_target;
      lift.position[2] += config.lift;
      update("lifting", "抬升并保持", send);
      move(who, tcp(lift), send, task_guard);
      finish("holding", "抬升完成；尚未通过传感器验证夹持成功", send);
    } catch (const std::exception &e) {
      finish(canceled ? "canceled" : "failed", e.what(), send);
    }
  }
};
VisualPick::VisualPick(std::string config, Motion m, Observe o, Pose p)
    : impl_(std::make_unique<Impl>(std::move(config), std::move(m), std::move(o), std::move(p))) {}
VisualPick::~VisualPick() {
  impl_->shutdown = true;
  impl_->canceled = true;
  if (impl_->worker.joinable()) impl_->worker.join();
}
bool VisualPick::busy() const { return impl_->active; }
void VisualPick::cancel(uint64_t owner) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (!owner || owner == impl_->owner) impl_->canceled = true;
  if (owner)
    impl_->previews.erase(owner);
  else
    impl_->previews.clear();
}
void VisualPick::request(uint64_t owner, const Tree &r, Send send) {
  std::set<std::string> seen;
  const std::set<std::string> allowed{"op",           "request_id", "subscription_id",  "object_id",
                                      "confirmation", "command_id", "preview_frame_seq"};
  for (const auto &field : r)
    if (!allowed.count(field.first) || !seen.insert(field.first).second || !field.second.empty())
      throw std::runtime_error("抓取请求字段未知、重复或不是标量");
  const auto op = r.get<std::string>("op"), rid = r.get<std::string>("request_id", "");
  if (op == "visual_pick_status") {
    {
      std::lock_guard<std::mutex> lock(impl_->mutex);
      if (owner == impl_->owner) impl_->heartbeat = Clock::now();
    }
    send(impl_->state(rid));
    return;
  }
  if (op == "visual_pick_cancel") {
    {
      std::lock_guard<std::mutex> lock(impl_->mutex);
      if (impl_->active && owner != impl_->owner) throw std::runtime_error("抓取由其他会话持有");
    }
    cancel(owner);
    send(impl_->state(rid));
    return;
  }
  auto config = load_pick_config(impl_->config_path);
  const auto token = r.get<std::string>("subscription_id", "");
  const auto object = r.get<uint64_t>("object_id", 0);
  if (token.empty() || token.size() > 128 || !object) throw std::runtime_error("抓取目标令牌或编号无效");
  const auto observed = impl_->observe(owner, token, object);
  const auto plan = make_pick_plan(observed.box, config);
  if (op == "visual_pick_preview") {
    {
      std::lock_guard<std::mutex> lock(impl_->mutex);
      if (impl_->previews.size() >= 64 && !impl_->previews.count(owner))
        impl_->previews.erase(impl_->previews.begin());
      impl_->previews[owner] = {observed, config, Clock::now()};
    }
    send("{\"op\":\"visual_pick_preview\",\"request_id\":" + position_json_quote(rid) +
         ",\"subscription_id\":" + position_json_quote(token) + ",\"object_id\":" + std::to_string(object) +
         ",\"frame_seq\":" + std::to_string(observed.sequence) +
         ",\"calibrated\":" + (config.calibrated ? "true" : "false") +
         ",\"execution_ready\":" + (config.calibrated && config.scene_verified ? "true" : "false") +
         ",\"grasp\":" + pose_json(plan.grasp) + ",\"pregrasp\":" + pose_json(plan.pregrasp) +
         ",\"opening_m\":" + std::to_string(plan.opening) + ",\"message\":" +
         position_json_quote(config.calibrated && config.scene_verified
                                 ? "候选姿态；执行仍需 MoveIt、夹爪和现场确认"
                                 : "未完成相机/TCP/桌面标定或 MoveIt 障碍物核验，仅供预览") +
         "}");
    return;
  }
  if (op != "visual_pick_start") throw std::runtime_error("未知抓取操作");
  if (!config.calibrated || !config.scene_verified)
    throw std::runtime_error("未完成相机/TCP/桌面标定或 MoveIt 障碍物核验，禁止执行");
  if (r.get<std::string>("confirmation", "") != "ARMED") throw std::runtime_error("请先确认现场安全");
  {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    auto it = impl_->previews.find(owner);
    if (it == impl_->previews.end() || Clock::now() - it->second.created > std::chrono::seconds(1))
      throw std::runtime_error("预览已过期，请重新生成候选");
    const auto &p = it->second;
    if (!p.config.calibrated || !p.config.scene_verified || p.observed.subscription != token ||
        p.observed.box.id != object || p.observed.sequence != r.get<uint64_t>("preview_frame_seq", 0) ||
        p.observed.generation != observed.generation)
      throw std::runtime_error("预览与当前目标或标定代次不一致");
    double shift = 0;
    for (int a = 0; a < 3; ++a) {
      shift += std::pow(observed.box.center[a] - p.observed.box.center[a], 2);
      if (std::abs(observed.box.size[a] - p.observed.box.size[a]) > .01)
        throw std::runtime_error("目标尺寸已改变，请重新预览");
    }
    if (shift > .02 * .02) throw std::runtime_error("目标相对预览移动超过 2 cm");
    const auto approved = make_pick_plan(observed.box, p.config);
    if (config.tcp_link != p.config.tcp_link || std::abs(config.lift - p.config.lift) > 1e-9 ||
        tcp_pose_position_error(plan.tcp, approved.tcp) > 1e-9 ||
        tcp_pose_orientation_error(plan.tcp, approved.tcp) > 1e-9 ||
        tcp_pose_position_error(plan.pre_tcp, approved.pre_tcp) > 1e-9 ||
        std::abs(plan.opening - approved.opening) > 1e-9 || std::abs(plan.closing - approved.closing) > 1e-9)
      throw std::runtime_error("抓取配置已改变，请重新预览");
  }
  const auto id = r.get<std::string>("command_id", "");
  if (id.empty() || id.size() > 60 ||
      id.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-") !=
          std::string::npos)
    throw std::runtime_error("抓取 command_id 无效");
  // Serialize admission and joining a previous completed worker.
  static std::mutex admission;
  std::lock_guard<std::mutex> serial(admission);
  if (impl_->active) throw std::runtime_error("已有抓取任务");
  if (std::find(impl_->accepted_ids.begin(), impl_->accepted_ids.end(), id) != impl_->accepted_ids.end())
    throw std::runtime_error("重复的抓取 command_id");
  if (impl_->worker.joinable()) impl_->worker.join();
  {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    impl_->owner = owner;
    impl_->id = id;
    impl_->phase = "validating";
    impl_->message = "校验视觉抓取条件";
    impl_->heartbeat = Clock::now();
  }
  impl_->accepted_ids.push_back(id);
  if (impl_->accepted_ids.size() > 256) impl_->accepted_ids.pop_front();
  impl_->canceled = false;
  impl_->active = true;
  send(impl_->state(rid));
  impl_->worker = std::thread(
      [this, owner, r, config, observed, send]() { impl_->run(owner, r, config, observed, send); });
}
}  // namespace easy_debug_bridge
