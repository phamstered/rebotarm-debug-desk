#pragma once
#include "easy_debug_bridge/joint4_task_core.hpp"
#include <rclcpp/rclcpp.hpp>
#include <boost/property_tree/ptree.hpp>
#include <functional>
#include <memory>
#include <string>
namespace easy_debug_bridge {
class ControllerRegistry;
class Joint4Calibration {
 public:
  using Send=std::function<void(const std::string &)>;
  struct Safety {
    Joint4TaskCore::Observation observation;
    bool tracking{}, healthy{};
  };
  using Snapshot=std::function<Safety()>;
  using Disable=std::function<uint32_t()>;
  Joint4Calibration(rclcpp::Node &node, std::shared_ptr<ControllerRegistry> controllers, Snapshot snapshot, Disable disable, Send broadcast);
  ~Joint4Calibration();
  void request(uint64_t owner,const boost::property_tree::ptree &request,Send send,bool conflict=false);
  void disconnected(uint64_t owner);
  void disable();
  bool busy() const;
  bool supported() const;
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}
