#pragma once
#include "easy_debug_bridge/controller_registry_core.hpp"
#include <rclcpp/rclcpp.hpp>
#include <functional>
#include <memory>

namespace easy_debug_bridge {
class ControllerRegistry {
 public:
  using Send = std::function<void(const std::string &)>;
  explicit ControllerRegistry(rclcpp::Node &node);
  ~ControllerRegistry();
  bool supported() const;
  rclcpp::CallbackGroup::SharedPtr callback_group() const;
  ControllerRegistrySnapshot snapshot() const;
  void request(uint64_t owner, const std::string &request_id, bool refresh, Send send);
  void disconnected(uint64_t owner);
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}
