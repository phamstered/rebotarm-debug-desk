#pragma once
#include <rclcpp/rclcpp.hpp>
#include <functional>
#include <memory>
#include <string>
#include <boost/property_tree/ptree.hpp>

namespace easy_debug_bridge {
// Requests are queued onto the ROS executor. Its mutually-exclusive callback
// group owns every motion state transition; socket threads never touch ROS goals.
class PositionMotion {
 public:
  using Send = std::function<void(const std::string &)>;
  explicit PositionMotion(rclcpp::Node &node, const std::string &joint_topic, const std::string &status_topic);
  ~PositionMotion();
  void request(uint64_t owner, const boost::property_tree::ptree &request, Send send);
  void disconnected(uint64_t owner);
  bool busy() const;
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}
