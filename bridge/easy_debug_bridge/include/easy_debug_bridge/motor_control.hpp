#pragma once
#include <boost/property_tree/ptree.hpp>
#include "easy_debug_bridge/motor_delivery.hpp"
#include <rclcpp/rclcpp.hpp>
#include <functional>
#include <memory>
#include <string>

namespace easy_debug_bridge {
class MotorControl {
 public:
  using Send = motor_delivery::Send;
  using Disable = std::function<uint32_t()>;
  using Sequence = std::function<uint32_t()>;
  using SyncSequence = std::function<void(uint32_t, bool)>;
  using Safety = std::function<bool(uint32_t)>;
  MotorControl(rclcpp::Node &node, const std::string &command_topic, Disable disable,
               Sequence sequence, SyncSequence sync_sequence, Safety safety);
  ~MotorControl();
  bool supported() const;
  bool busy() const;
  void require_mit() const;
  void connected(uint64_t owner, Send send);
  void disconnected(uint64_t owner);
  void request(uint64_t owner, const boost::property_tree::ptree &request, Send send, std::function<bool()> current);
  // Called before any explicit/global DISABLE; revoke queued operations first.
  void stopping();
  void disabled_published(uint32_t sequence);
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}
