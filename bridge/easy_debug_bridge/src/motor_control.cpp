#include "easy_debug_bridge/motor_control.hpp"
#include "easy_debug_bridge/motor_control_core.hpp"
#include <algorithm>
#include <condition_variable>
#include <deque>
#include <iomanip>
#include <limits>
#include <map>
#include <mutex>
#include <random>
#include <set>
#include <sstream>
#include <thread>
#if __has_include(<microros_stm32h723_bridge/msg/joint_command_v2.hpp>) && \
    __has_include(<microros_stm32h723_bridge/msg/motor_control_status.hpp>) && \
    __has_include(<microros_stm32h723_bridge/srv/motor_control.hpp>)
#define EASY_DEBUG_HAS_MOTOR_V2 1
#include <microros_stm32h723_bridge/msg/joint_command_v2.hpp>
#include <microros_stm32h723_bridge/msg/motor_control_status.hpp>
#include <microros_stm32h723_bridge/srv/motor_control.hpp>
#endif

namespace easy_debug_bridge {
namespace {
using namespace motor_v2;
using Tree = boost::property_tree::ptree;
std::string quote(const std::string &text) {
  std::ostringstream out; out << '"';
  for (const auto c : text) {
    if (c == '"' || c == '\\') out << '\\' << c;
    else if (static_cast<unsigned char>(c) < 32) out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << unsigned(static_cast<unsigned char>(c));
    else out << c;
  }
  out << '"'; return out.str();
}
std::string error(const std::string &id, const std::string &reason) {
  return "{\"op\":\"error\",\"request_id\":" + quote(id) + ",\"message\":" + quote(reason) + "}";
}
uint64_t integer(const Tree &tree, const std::string &key, uint64_t maximum = UINT32_MAX) {
  const auto &field = tree.get_child(key); const auto &text = field.data();
  if (!field.empty() || text.empty() || text.size() > 20 || text.find_first_not_of("0123456789") != std::string::npos)
    throw std::runtime_error(key + " 必须为无符号整数");
  size_t used = 0; const auto value = std::stoull(text, &used);
  if (used != text.size() || value > maximum) throw std::runtime_error(key + " 超出整数范围");
  return value;
}
void fields(const Tree &tree, const std::set<std::string> &allowed) {
  std::set<std::string> found;
  for (const auto &field : tree) if (!allowed.count(field.first) || !found.insert(field.first).second)
    throw std::runtime_error("未知或重复的 V2 字段：" + field.first);
}
uint8_t drive(const Tree &tree) {
  const auto text = tree.get<std::string>("control_mode");
  if (text == "MIT") return mit;
  if (text == "POS_VEL") return pos_vel;
  throw std::runtime_error("control_mode 必须为 MIT 或 POS_VEL");
}
std::array<float, 7> numbers(const Tree &tree) {
  std::array<float, 7> result{}; size_t i = 0;
  for (const auto &field : tree) {
    if (!field.first.empty() || !field.second.empty() || i == 7) throw std::runtime_error("POS_VEL 数组必须恰好包含七个数值");
    const double value = field.second.get_value<double>();
    if (!std::isfinite(value) || std::abs(value) > std::numeric_limits<float>::max()) throw std::runtime_error("POS_VEL 数值超出有限 float32 范围");
    result[i++] = static_cast<float>(value);
  }
  if (i != 7) throw std::runtime_error("POS_VEL 数组必须恰好包含七个数值");
  return result;
}
template<class Array> std::string array_json(const Array &values) {
  std::ostringstream out; out << '[' << std::setprecision(9); bool first = true;
  for (const auto v : values) { if (!first) out << ','; first = false; out << v; }
  out << ']'; return out.str();
}
}

struct MotorControl::Impl {
  struct Connection { uint64_t source; Send send; };
  struct Pending { Transaction transaction; uint64_t owner; std::string id; Send send; bool responded{}; };
  rclcpp::Node &node;
  Disable disable_output;
  Sequence next_sequence;
  SyncSequence sync_sequence;
  Safety safety;
  mutable std::mutex mutex;
  Cache cache;
  CommandStream stream;
  std::map<uint64_t, Connection> connections;
  std::optional<Pending> pending;
  uint32_t operation_counter{};
  uint64_t generation{}, stream_owner{};
  Time last_command{}, last_broadcast{};
  bool stop_barrier{}, stopping{}, waiting_first_frame{};
  uint64_t stop_boot{}, stop_stamp{};
  std::optional<uint32_t> stop_sequence;
  motor_delivery::Queue replies;
  std::condition_variable condition;
  std::vector<std::thread> senders;
  rclcpp::CallbackGroup::SharedPtr group;
  rclcpp::TimerBase::SharedPtr timer;
#ifdef EASY_DEBUG_HAS_MOTOR_V2
  using Service = microros_stm32h723_bridge::srv::MotorControl;
  using StatusMessage = microros_stm32h723_bridge::msg::MotorControlStatus;
  using CommandMessage = microros_stm32h723_bridge::msg::JointCommandV2;
  rclcpp::Client<Service>::SharedPtr client;
  rclcpp::Subscription<StatusMessage>::SharedPtr subscription;
  rclcpp::Publisher<CommandMessage>::SharedPtr publisher;
  std::optional<int64_t> service_request;
#endif
  Impl(rclcpp::Node &n, const std::string &topic, Disable d, Sequence q, SyncSequence sync, Safety s)
      : node(n), disable_output(std::move(d)), next_sequence(std::move(q)), sync_sequence(std::move(sync)), safety(std::move(s)) {
    group = node.create_callback_group(rclcpp::CallbackGroupType::MutuallyExclusive);
#ifdef EASY_DEBUG_HAS_MOTOR_V2
    const auto slash = topic.find_last_of('/');
    const auto prefix = slash == std::string::npos ? std::string() : topic.substr(0, slash + 1);
    const auto qos = rclcpp::QoS(10).best_effort().durability_volatile();
    publisher = node.create_publisher<CommandMessage>(topic + "_v2", qos);
    client = node.create_client<Service>(prefix + "motor_control", rmw_qos_profile_services_default, group);
    rclcpp::SubscriptionOptions options; options.callback_group = group;
    subscription = node.create_subscription<StatusMessage>(prefix + "motor_control_status",
      rclcpp::QoS(1).best_effort().durability_volatile(),
      [this](StatusMessage::ConstSharedPtr message) { observe(*message); }, options);
#else
    (void)topic;
#endif
    timer = node.create_wall_timer(std::chrono::milliseconds(20), [this] { tick(); }, group);
    for (int i = 0; i < 4; ++i) senders.emplace_back([this] {
      for (;;) {
        std::unique_lock<std::mutex> lock(mutex);
        condition.wait(lock, [this] { return stopping || replies.ready(); });
        if (stopping) return;
        auto reply = replies.take();
        if (!reply) continue;
        lock.unlock();
        try { reply->send(reply->json, reply->generated_at); } catch (...) {}
        lock.lock(); replies.finished(reply->owner); lock.unlock();
        condition.notify_all();
      }
    });
  }
  ~Impl() {
    timer->cancel();
    { std::lock_guard<std::mutex> lock(mutex); stopping = true; replies.clear(); }
    condition.notify_all(); for (auto &sender : senders) if (sender.joinable()) sender.join();
  }
  static bool compiled() {
#ifdef EASY_DEBUG_HAS_MOTOR_V2
    return true;
#else
    return false;
#endif
  }
  uint32_t operation() {
    if (operation_counter == UINT32_MAX) throw std::runtime_error("V2 operation_id 已耗尽，请重启 Bridge");
    return ++operation_counter;
  }
  uint64_t source(uint64_t owner) const {
    const auto it = connections.find(owner);
    if (it == connections.end()) throw std::runtime_error("V2 连接身份已失效");
    return it->second.source;
  }
  void enqueue(uint64_t owner, Send send, std::string json, bool status = false, Time generated = Clock::now()) {
    replies.push({owner, std::move(send), std::move(json), status, generated}); condition.notify_one();
  }
  std::string capabilities(uint64_t owner, Time now) const {
    const auto &s = cache.status;
    const bool fresh = cache.fresh(now);
    const auto age = cache.have ? std::max<int64_t>(0, std::chrono::duration_cast<std::chrono::milliseconds>(now - cache.received).count()) : 0;
    const std::string reason = !compiled() ? "Bridge 构建未包含 V2 消息类型" :
        !cache.seen ? "未发现 V2 固件能力，仅支持旧 MIT" : !fresh ? "V2 固件状态缺失或过期" :
        !s.pos_vel_supported_mask ? "固件尚未开放通过台架验证的 POS_VEL 关节" : "";
    std::ostringstream out;
    out << "{\"supported\":" << (cache.seen && compiled() ? "true" : "false") << ",\"fresh\":" << (fresh ? "true" : "false")
        << ",\"reason\":" << quote(reason) << ",\"age_ms\":" << age << ",\"protocol_version\":" << unsigned(s.protocol_version)
        << ",\"boot_id\":" << quote(std::to_string(s.boot_id)) << ",\"control_epoch\":" << s.control_epoch
        << ",\"source_id\":" << quote(std::to_string(source(owner))) << ",\"owner_source_id\":" << quote(std::to_string(s.owner_source_id))
        << ",\"lease_id\":" << s.lease_id << ",\"selected_joint_mask\":" << s.selected_joint_mask << ",\"enabled_joint_mask\":" << s.enabled_joint_mask
        << ",\"verified_joint_mask\":" << s.verified_joint_mask << ",\"pos_vel_supported_mask\":" << s.pos_vel_supported_mask << ",\"control_modes\":[";
    for (size_t i = 0; i < 7; ++i) { if (i) out << ','; out << quote(s.control_modes[i] == mit ? "MIT" : s.control_modes[i] == pos_vel ? "POS_VEL" : "UNKNOWN"); }
    out << "],\"velocity_limit_max\":" << array_json(s.velocity_limit_max) << ",\"position_min\":" << array_json(s.position_min)
        << ",\"position_max\":" << array_json(s.position_max) << ",\"switching\":" << (s.switching ? "true" : "false")
        << ",\"disabled_verified\":" << (s.disabled_verified ? "true" : "false")
        << ",\"operation_id\":" << s.operation_id << ",\"operation_state\":" << unsigned(s.operation_state)
        << ",\"last_command_sequence\":" << s.last_command_sequence << ",\"mode\":" << unsigned(s.mode)
        << ",\"fault_code\":" << s.fault_code << ",\"error_code\":" << s.error_code << ",\"rejected_sequence\":" << s.rejected_sequence
        << ",\"reject_code\":" << s.reject_code << ",\"stamp_ns\":" << quote(std::to_string(s.stamp_ns)) << '}';
    return out.str();
  }
  void revoke(const std::string &reason) {
    ++generation; stream_owner = 0; waiting_first_frame = false; stream.clear();
#ifdef EASY_DEBUG_HAS_MOTOR_V2
    if (service_request) { client->remove_pending_request(*service_request); service_request.reset(); }
#endif
    if (pending && !pending->responded) enqueue(pending->owner, pending->send, error(pending->id, reason));
    pending.reset(); stop_barrier = cache.seen; stop_boot = cache.status.boot_id;
    stop_stamp = cache.status.stamp_ns; stop_sequence.reset();
  }
  void stop(const std::string &reason) {
    revoke(reason);
    try { stop_sequence = disable_output(); } catch (...) { /* Keep the barrier until an explicit retry is proven. */ }
  }
  void confirm_stop(Time now) {
    if (stop_barrier && stop_sequence && cache.fresh(now) && cache.status.boot_id == stop_boot &&
        cache.status.stamp_ns > stop_stamp && cache.status.disabled() &&
        (cache.status.last_command_sequence == *stop_sequence || sequence_after(cache.status.last_command_sequence, *stop_sequence))) {
      stop_barrier = false; stop_sequence.reset();
    }
  }
#ifdef EASY_DEBUG_HAS_MOTOR_V2
  uint32_t publish_command(Command command, Time now) {
    // Called under the same mutex as revoke/DISABLE and connection retirement.
    validate_command(cache, command, now);
    if (!safety(command.mask)) throw std::runtime_error("STM32 status / joint feedback 不新鲜或存在故障");
    if (!publisher->get_subscription_count()) throw std::runtime_error("V2 command subscriber 不可用");
    command.sequence = next_sequence();
    CommandMessage message; message.header.stamp = node.now(); message.header.frame_id = "base_link";
    message.boot_id = command.boot; message.control_epoch = command.epoch;
    message.source_id = command.source; message.lease_id = command.lease;
    message.sequence = command.sequence; message.mode = command.mode; message.control_mode = pos_vel;
    message.active_joint_mask = command.mask; message.position = command.position; message.velocity_limit = command.velocity_limit;
    publisher->publish(message); stream.published(now);
    return command.sequence;
  }
  void observe(const StatusMessage &m) {
    std::lock_guard<std::mutex> lock(mutex);
    Status s;
    s.protocol_version = m.protocol_version; s.boot_id = m.boot_id; s.control_epoch = m.control_epoch;
    s.owner_source_id = m.owner_source_id; s.lease_id = m.lease_id; s.selected_joint_mask = m.selected_joint_mask;
    s.enabled_joint_mask = m.enabled_joint_mask; s.verified_joint_mask = m.verified_joint_mask;
    s.pos_vel_supported_mask = m.pos_vel_supported_mask; s.control_modes = m.control_modes;
    s.velocity_limit_max = m.velocity_limit_max; s.position_min = m.position_min; s.position_max = m.position_max;
    s.switching = m.switching; s.disabled_verified = m.disabled_verified; s.operation_id = m.operation_id; s.operation_state = m.operation_state;
    s.last_command_sequence = m.last_command_sequence; s.mode = m.mode; s.fault_code = m.fault_code;
    s.error_code = m.error_code; s.rejected_sequence = m.rejected_sequence; s.reject_code = m.reject_code;
    if (m.header.stamp.sec >= 0 && m.header.stamp.nanosec < 1000000000u)
      s.stamp_ns = uint64_t(m.header.stamp.sec) * 1000000000u + m.header.stamp.nanosec;
    const auto received = motor_delivery::received_at(s.stamp_ns, node.now().nanoseconds(), Clock::now());
    if (!received) { cache.discovered(); cache.have = false; return; }
    const bool boot_changed = cache.status.boot_id && cache.status.boot_id != s.boot_id;
    if (cache.observe(s, *received)) sync_sequence(s.last_command_sequence, boot_changed);
  }
  void send_service() {
    auto &p = *pending; auto &t = p.transaction;
    if (!client->service_is_ready()) throw std::runtime_error("V2 MotorControl 服务不可用");
    auto request = std::make_shared<Service::Request>();
    request->action = t.action; request->operation_id = t.operation; request->boot_id = t.boot;
    request->expected_control_epoch = t.epoch; request->source_id = t.source; request->active_joint_mask = t.mask;
    request->control_mode = t.requested_mode; request->lease_id = 0; request->disable_sequence = t.disable_sequence;
    t.stage = Stage::Service; const auto token = generation;
    service_request = client->async_send_request(request, [this, token](rclcpp::Client<Service>::SharedFuture future) {
      std::lock_guard<std::mutex> lock(mutex);
      if (!pending || token != generation) return;
      service_request.reset();
      try {
        const auto response = future.get(); auto &t = pending->transaction;
        if (!response->accepted || response->operation_id != t.operation) throw std::runtime_error("固件拒绝 V2 操作，error_code=" + std::to_string(response->error_code));
        t.admitted_lease = response->lease_id; t.stage = Stage::Readback;
      } catch (const std::exception &e) { stop(std::string("V2 服务结果未确认：") + e.what()); }
    }).request_id;
  }
#endif
  void tick() {
    std::lock_guard<std::mutex> lock(mutex); const auto now = Clock::now();
#ifdef EASY_DEBUG_HAS_MOTOR_V2
    if (subscription->get_publisher_count()) cache.discovered();
#endif
    if (stream_owner && (!cache.fresh(now) || now - last_command >= std::chrono::milliseconds(waiting_first_frame ? 500 : 250))) stop("POS_VEL 指令或固件反馈超时，已请求 DISABLE");
    confirm_stop(now);
#ifdef EASY_DEBUG_HAS_MOTOR_V2
    if (stream_owner && !waiting_first_frame && !stop_barrier && !pending) {
      try {
        if (auto command = stream.due(cache, now)) publish_command(*command, now);
      } catch (const std::exception &e) { stop(std::string("POS_VEL 持续保持中止：") + e.what()); }
    }
    if (pending) {
      auto &t = pending->transaction;
      if (now >= t.deadline || !cache.fresh(now) || cache.status.boot_id != t.boot) stop("V2 操作超时或固件身份失效，已请求 DISABLE；需核验输出关闭");
      else try {
        if (t.stage == Stage::Stop && t.stopped(cache, now)) send_service();
        else if (t.stage == Stage::Readback && t.confirmed(cache, now)) {
          if (t.action == 1 && t.requested_mode == mit) {
            if (!cache.status.actual(all_joints, mit)) throw std::runtime_error("仍有其他关节未恢复 MIT，保持 V2 占用");
            t.configure_then_release = true; t.action = 3; t.epoch = cache.status.control_epoch;
            t.operation = operation(); t.initial_stamp = cache.status.stamp_ns; t.stage = Stage::Stop;
            t.disable_sequence = disable_output();
          } else {
            const auto owner = pending->owner;
            const auto op = t.action == 1 || t.configure_then_release ? "motor_set_control_mode_result" : "motor_control_lease_ack";
            enqueue(owner, pending->send, "{\"op\":" + quote(op) + ",\"request_id\":" + quote(pending->id) +
                ",\"terminal\":true,\"motor_control\":" + capabilities(owner, now) + "}", false, now);
            if (t.action == 2) { stream_owner = owner; waiting_first_frame = true; last_command = now; }
            pending.reset();
          }
        } else if (t.stage == Stage::Readback && cache.status.operation_id == t.operation && cache.status.operation_state >= 3)
          stop("固件模式操作失败或已取消，已请求 DISABLE");
      } catch (const std::exception &e) { stop(std::string("V2 操作中止：") + e.what()); }
    }
#endif
    if (cache.seen && now - last_broadcast >= std::chrono::milliseconds(100)) {
      last_broadcast = now;
      for (const auto &entry : connections) enqueue(entry.first, entry.second.send,
          "{\"op\":\"motor_control_status\",\"motor_control\":" + capabilities(entry.first, now) + "}", true, now);
    }
  }
};

MotorControl::MotorControl(rclcpp::Node &node, const std::string &topic, Disable d, Sequence q, SyncSequence sync, Safety s)
    : impl_(std::make_unique<Impl>(node, topic, std::move(d), std::move(q), std::move(sync), std::move(s))) {}
MotorControl::~MotorControl() = default;
bool MotorControl::supported() const { return Impl::compiled(); }
bool MotorControl::busy() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  return impl_->pending.has_value() || impl_->stream_owner || impl_->stop_barrier || !impl_->cache.mit_allowed(Clock::now());
}
void MotorControl::require_mit() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (impl_->pending || impl_->stream_owner || impl_->stop_barrier || !impl_->cache.mit_allowed(Clock::now()))
    throw std::runtime_error("旧控制链路需要整组读回确认 MIT、无 V2 占用且输出停止已核验");
}
void MotorControl::connected(uint64_t owner, Send send) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  std::random_device random; uint64_t identity;
  do { identity = (uint64_t(random()) << 32u) | random(); }
  while (!identity || std::any_of(impl_->connections.begin(), impl_->connections.end(), [identity](const auto &c) { return c.second.source == identity; }));
  impl_->connections.emplace(owner, Impl::Connection{identity, std::move(send)});
}
void MotorControl::disconnected(uint64_t owner) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  const auto found = impl_->connections.find(owner);
  if (found == impl_->connections.end()) return;
  if ((impl_->pending && impl_->pending->owner == owner) || impl_->stream_owner == owner ||
      (impl_->cache.have && impl_->cache.status.owner_source_id == found->second.source)) impl_->stop("控制连接已断开，已请求 DISABLE");
  impl_->connections.erase(found);
  impl_->replies.erase(owner);
}
void MotorControl::stopping() { std::lock_guard<std::mutex> lock(impl_->mutex); impl_->revoke("已请求 DISABLE，撤销模式操作与控制许可"); }
void MotorControl::disabled_published(uint32_t sequence) { std::lock_guard<std::mutex> lock(impl_->mutex); impl_->stop_sequence = sequence; }
void MotorControl::request(uint64_t owner, const Tree &request, Send send, std::function<bool()> current) {
  const auto id = request.get<std::string>("request_id", "");
  if (id.size() > 128) { send(error("", "V2 request_id 过长"), Clock::now()); return; }
  std::unique_lock<std::mutex> lock(impl_->mutex);
  const auto now = Clock::now(); const auto op = request.get<std::string>("op", "");
  try {
    // A capability read can observe stop proof between timer ticks. Consume it
    // before admitting the next explicit operation so UI and task gates agree.
    impl_->confirm_stop(now);
    const auto source = impl_->source(owner);
    if (op == "motor_capabilities") {
      fields(request, {"op", "request_id"});
      const auto json = "{\"op\":\"motor_capabilities\",\"request_id\":" + quote(id) + ",\"motor_control\":" + impl_->capabilities(owner, now) + "}";
      lock.unlock(); send(json, now); return;
    }
    if (!current()) throw std::runtime_error("较早的 Motor 请求已被 DISABLE 撤销");
    if (!Impl::compiled()) throw std::runtime_error("当前 Bridge 未构建 V2 支持，旧 MIT 可继续使用");
    if (request.get<std::string>("confirmation", "") != "ARMED") throw std::runtime_error("控制面板尚未安全确认");
    const auto boot = integer(request, "boot_id", UINT64_MAX);
    const auto epoch = uint32_t(integer(request, "control_epoch"));
    const auto mask = uint32_t(integer(request, "active_joint_mask"));
    const auto requested_mode = drive(request);
    impl_->cache.require_identity(boot, epoch, now);
    if (!impl_->safety(mask)) throw std::runtime_error("STM32 status / joint feedback 不新鲜、存在故障或所选轴不可用");
    if (op == "motor_command_v2") {
      fields(request, {"op", "request_id", "boot_id", "control_epoch", "active_joint_mask", "control_mode", "lease_id", "mode", "position", "pos_vel", "confirmation"});
      if (impl_->pending || impl_->stop_barrier || impl_->stream_owner != owner || requested_mode != pos_vel) throw std::runtime_error("POS_VEL 流尚未获准或正在停止");
      Command command; command.boot = boot; command.epoch = epoch; command.source = source; command.mask = mask;
      command.lease = integer(request, "lease_id"); command.mode = integer(request, "mode", 1);
      command.position = numbers(request.get_child("position"));
      const auto &parameters = request.get_child("pos_vel"); fields(parameters, {"velocity_limit"});
      command.velocity_limit = numbers(parameters.get_child("velocity_limit"));
      validate_command(impl_->cache, command, now);
#ifdef EASY_DEBUG_HAS_MOTOR_V2
      if (now - impl_->last_command >= std::chrono::milliseconds(impl_->waiting_first_frame ? 500 : 250)) {
        impl_->stop("POS_VEL 客户端指令超时，已请求 DISABLE");
        throw std::runtime_error("POS_VEL 客户端指令超时，必须停止后重新开始");
      }
      try {
        impl_->stream.renew(impl_->cache, command, now);
        command.sequence = impl_->publish_command(command, now);
        impl_->last_command = now; impl_->waiting_first_frame = false;
      } catch (...) { impl_->stop("POS_VEL 发布失败，已请求 DISABLE"); throw; }
#endif
      const auto json = "{\"op\":\"motor_command_v2_ack\",\"request_id\":" + quote(id) + ",\"sequence\":" + std::to_string(command.sequence) +
          ",\"mode\":" + std::to_string(command.mode) + ",\"boot_id\":" + quote(std::to_string(boot)) + ",\"control_epoch\":" + std::to_string(epoch) + ",\"lease_id\":" + std::to_string(command.lease) + "}";
      lock.unlock(); send(json, now); return;
    }
    if (impl_->pending || impl_->stream_owner || impl_->stop_barrier) throw std::runtime_error("已有 V2 操作或正在核验停止");
    Transaction t; t.boot = boot; t.epoch = epoch; t.mask = mask; t.source = source; t.requested_mode = requested_mode;
    t.operation = impl_->operation(); t.initial_stamp = impl_->cache.status.stamp_ns;
    if (op == "motor_set_control_mode") {
      fields(request, {"op", "request_id", "boot_id", "control_epoch", "active_joint_mask", "control_mode", "confirmation", "support_confirmation"});
      if (request.get<std::string>("support_confirmation", "") != "SUPPORTED") throw std::runtime_error("切换前必须确认机械臂已被可靠支撑");
      t.action = 1;
    } else if (op == "motor_control_lease") {
      fields(request, {"op", "request_id", "boot_id", "control_epoch", "active_joint_mask", "control_mode", "confirmation", "lease_action"});
      const auto action = request.get<std::string>("lease_action", "");
      if (action != "acquire" && action != "release") throw std::runtime_error("lease_action 必须为 acquire 或 release");
      t.action = action == "acquire" ? 2 : 3;
    } else throw std::runtime_error("未知 V2 操作");
    t.validate_start(impl_->cache, now);
    t.deadline = now + (t.action == 1 ? std::chrono::seconds(10) : std::chrono::seconds(4));
    ++impl_->generation;
    impl_->pending = Impl::Pending{t, owner, id, send, false};
    try { impl_->pending->transaction.disable_sequence = impl_->disable_output(); }
    catch (...) { impl_->stop("DISABLE 发布结果未确认，保留停止门禁"); throw; }
  } catch (const std::exception &e) {
    const auto json = error(id, e.what()); lock.unlock(); send(json, now);
  }
}
} // namespace easy_debug_bridge
