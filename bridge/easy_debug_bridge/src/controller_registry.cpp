#include "easy_debug_bridge/controller_registry.hpp"
#include <mutex>
#include <deque>
#include <thread>
#include <condition_variable>
#ifdef EASY_DEBUG_HAS_CONTROLLER_MANAGER
#include <controller_manager_msgs/srv/list_controllers.hpp>
#endif

namespace easy_debug_bridge {
struct ControllerRegistry::Impl {
  using Clock = ControllerHealthPoll::Clock;
  struct Waiter { uint64_t owner, minimum_query; std::string id; Send send; Clock::time_point deadline; };
  struct Reply { uint64_t owner; Send send; std::string json; };
  mutable std::mutex mutex;
  ControllerRegistryCore core;
  ControllerRequestBudget budget;
  std::deque<Waiter> waiters;
  std::deque<Reply> replies;
  std::condition_variable condition;
  std::vector<std::thread> senders;
  bool stopping{false};
  rclcpp::CallbackGroup::SharedPtr group;
  rclcpp::TimerBase::SharedPtr timer;
#ifdef EASY_DEBUG_HAS_CONTROLLER_MANAGER
  using Service = controller_manager_msgs::srv::ListControllers;
  rclcpp::Client<Service>::SharedPtr client;
  int64_t request_id{};
#endif
  explicit Impl(rclcpp::Node &node) {
#ifdef EASY_DEBUG_HAS_CONTROLLER_MANAGER
    group = node.create_callback_group(rclcpp::CallbackGroupType::MutuallyExclusive);
    client = node.create_client<Service>("/controller_manager/list_controllers", rmw_qos_profile_services_default, group);
    timer = node.create_wall_timer(std::chrono::milliseconds(50), [this] { tick(); }, group);
    for (int i = 0; i < 4; ++i) senders.emplace_back([this] {
      for (;;) {
        std::unique_lock<std::mutex> lock(mutex);
        condition.wait(lock, [this] { return stopping || !replies.empty(); });
        if (stopping) return;
        auto reply = std::move(replies.front()); replies.pop_front();
        lock.unlock();
        try { reply.send(reply.json); } catch (...) {}
        lock.lock(); budget.release(reply.owner);
      }
    });
#else
    (void)node; core.cache.supported = false;
#endif
  }
  ~Impl() {
    { std::lock_guard<std::mutex> lock(mutex); stopping = true;
      for (const auto &waiter : waiters) budget.release(waiter.owner);
      for (const auto &reply : replies) budget.release(reply.owner);
      waiters.clear(); replies.clear(); }
    condition.notify_all();
    for (auto &sender : senders) if (sender.joinable()) sender.join();
  }
  void collect(Clock::time_point now) {
    const auto view = core.snapshot(now);
    for (auto it = waiters.begin(); it != waiters.end();) {
      const bool finished = view.completed_query >= it->minimum_query;
      const bool backoff = view.failed && !view.query_pending;
      const bool expired = now >= it->deadline;
      if (!finished && !backoff && !expired) { ++it; continue; }
      replies.push_back({it->owner, it->send, controller_registry_json(view, it->id,
          expired ? "控制器刷新等待超过 5 秒，未使用旧查询结果" : "",
          std::chrono::duration<double, std::milli>(now - (it->deadline - std::chrono::seconds(5))).count())});
      it = waiters.erase(it);
    }
    condition.notify_all();
  }
  void tick() {
#ifdef EASY_DEBUG_HAS_CONTROLLER_MANAGER
    std::unique_lock<std::mutex> lock(mutex);
    const auto now = Clock::now();
    if (!waiters.empty()) core.poll.expedite_success(now);
    if (core.poll.pending() && (core.poll.expired(now) || !client->service_is_ready())) {
      client->remove_pending_request(request_id);
      const bool ready = client->service_is_ready();
      core.fail(now, ready ? "timeout" : "unavailable", ready ? "arm_trajectory_controller 状态查询超时（ListControllers ≥2s）" : "ControllerManager ListControllers 服务不可用");
    } else if (core.poll.due(now)) {
      if (!client->service_is_ready()) core.fail(now, "unavailable", "ControllerManager ListControllers 服务不可用");
      else {
        const auto generation = core.start(now);
        try {
          request_id = client->async_send_request(std::make_shared<Service::Request>(), [this, generation](rclcpp::Client<Service>::SharedFuture future) {
            std::unique_lock<std::mutex> callback_lock(mutex);
            if (!core.matches(generation)) return;
            const auto received = Clock::now();
            if (core.poll.expired(received)) core.fail(received, "timeout", "arm_trajectory_controller 状态查询超时（ListControllers ≥2s）");
            else try {
              std::vector<RegistryController> rows;
              for (const auto &row : future.get()->controller) rows.push_back({row.name, row.type, row.state, row.claimed_interfaces});
              core.success(received, std::chrono::duration<double, std::milli>(std::chrono::system_clock::now().time_since_epoch()).count(), std::move(rows));
            } catch (const std::exception &e) { core.fail(received, "error", std::string("ControllerManager 查询失败：") + e.what()); }
            collect(Clock::now()); // Age and request wait include response validation work.
          }).request_id;
        } catch (const std::exception &e) { core.fail(now, "error", std::string("ControllerManager 查询发送失败：") + e.what()); }
      }
    }
    collect(Clock::now());
#endif
  }
};
ControllerRegistry::ControllerRegistry(rclcpp::Node &node) : impl_(std::make_unique<Impl>(node)) {}
ControllerRegistry::~ControllerRegistry() = default;
bool ControllerRegistry::supported() const { return snapshot().supported; }
rclcpp::CallbackGroup::SharedPtr ControllerRegistry::callback_group() const { return impl_->group; }
ControllerRegistrySnapshot ControllerRegistry::snapshot() const { std::lock_guard<std::mutex> lock(impl_->mutex); return impl_->core.snapshot(Impl::Clock::now()); }
void ControllerRegistry::request(uint64_t owner, const std::string &id, bool refresh, Send send) {
  std::unique_lock<std::mutex> lock(impl_->mutex);
  const auto now = Impl::Clock::now();
  const auto view = impl_->core.snapshot(now);
  std::string reply;
  if (id.size() > 128) reply = controller_registry_json(view, "", "controllers_info request_id 超过 128 字节，未回显无效 ID");
  else if (!refresh || !view.supported || (view.failed && !view.query_pending)) reply = controller_registry_json(view, id);
  else if (!impl_->budget.reserve(owner)) reply = controller_registry_json(view, id, "控制器刷新请求过多");
  else try { impl_->waiters.push_back({owner, view.started_query + 1, id, send, now + std::chrono::seconds(5)}); }
  catch (...) { impl_->budget.release(owner); throw; }
  lock.unlock(); if (!reply.empty()) send(reply);
}
void ControllerRegistry::disconnected(uint64_t owner) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->waiters.erase(std::remove_if(impl_->waiters.begin(), impl_->waiters.end(),
      [&](const auto &waiter) { if (waiter.owner != owner) return false; impl_->budget.release(owner); return true; }), impl_->waiters.end());
  impl_->replies.erase(std::remove_if(impl_->replies.begin(), impl_->replies.end(),
      [&](const auto &reply) { if (reply.owner != owner) return false; impl_->budget.release(owner); return true; }), impl_->replies.end());
}
}
