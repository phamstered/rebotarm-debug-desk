#include "easy_debug_bridge/controller_registry.hpp"
#include <controller_manager_msgs/srv/list_controllers.hpp>
#include <cassert>
#include <condition_variable>
#include <mutex>
#include <thread>

using namespace std::chrono_literals;
int main(int argc, char **argv) {
  rclcpp::init(argc, argv);
  auto node = std::make_shared<rclcpp::Node>("registry_transport_test");
  auto service = node->create_service<controller_manager_msgs::srv::ListControllers>("/controller_manager/list_controllers",
      [](const std::shared_ptr<controller_manager_msgs::srv::ListControllers::Request>,
         std::shared_ptr<controller_manager_msgs::srv::ListControllers::Response>) {});
  auto registry = std::make_shared<easy_debug_bridge::ControllerRegistry>(*node);
  rclcpp::executors::MultiThreadedExecutor executor(rclcpp::ExecutorOptions(), 2);
  executor.add_node(node);
  std::thread spin([&] { executor.spin(); });
  auto deadline = std::chrono::steady_clock::now() + 5s;
  while (!registry->snapshot().fresh && std::chrono::steady_clock::now() < deadline) std::this_thread::sleep_for(10ms);
  assert(registry->snapshot().fresh);
  std::mutex mutex;
  std::condition_variable condition;
  bool release = false;
  int entered = 0, completed = 0;
  auto slow_send = [&](const std::string &) {
    std::unique_lock<std::mutex> lock(mutex);
    ++entered; condition.notify_all();
    condition.wait(lock, [&] { return release; });
    ++completed; condition.notify_all();
  };
  for (int i = 0; i < 8; ++i) registry->request(1, std::to_string(i), true, slow_send);
  { std::unique_lock<std::mutex> lock(mutex); assert(condition.wait_for(lock, 5s, [&] { return entered == 4; })); }
  bool rejected = false;
  registry->request(1, "ninth", true, [&](const std::string &json) { rejected = json.find("请求过多") != std::string::npos; });
  assert(rejected); // Four active sends still consume four owner slots.
  registry->disconnected(1); // Drops four queued replies, not four active writes.
  for (int i = 0; i < 4; ++i) registry->request(1, "new" + std::to_string(i), true, slow_send);
  rejected = false;
  registry->request(1, "again", true, [&](const std::string &json) { rejected = json.find("请求过多") != std::string::npos; });
  assert(rejected);
  { std::lock_guard<std::mutex> lock(mutex); release = true; condition.notify_all(); }
  { std::unique_lock<std::mutex> lock(mutex); assert(condition.wait_for(lock, 5s, [&] { return completed == 8; })); }
  executor.cancel(); spin.join(); registry.reset(); service.reset(); node.reset();
  rclcpp::shutdown();
}
