#include <easy_debug_bridge/topic_json.hpp>
#include <easy_debug_bridge/rgbd_qos.hpp>
#include <rclcpp/typesupport_helpers.hpp>
#include <std_msgs/msg/string.hpp>
#include <std_msgs/msg/u_int64.hpp>
#include <trajectory_msgs/msg/joint_trajectory.hpp>

#include <cassert>
#include <string>

template <typename Message>
std::string encode(const Message &message, const std::string &type) {
  constexpr const char *identifier = "rosidl_typesupport_introspection_cpp";
  auto library = rclcpp::get_typesupport_library(type, identifier);
  const auto *handle = rclcpp::get_typesupport_handle(type, identifier, *library);
  const auto *members = static_cast<const rosidl_typesupport_introspection_cpp::MessageMembers *>(handle->data);
  return easy_debug_bridge::message_to_json(&message, *members);
}

int main() {
  const auto image_qos = rclcpp::QoS(10).reliable().transient_local();
  const auto info_qos = rclcpp::QoS(10).best_effort().durability_volatile();
  const auto rgbd_image_qos = easy_debug_bridge::rgbd_stream_qos(image_qos);
  const auto rgbd_info_qos = easy_debug_bridge::rgbd_stream_qos(info_qos);
  assert(image_qos.get_rmw_qos_profile().durability == RMW_QOS_POLICY_DURABILITY_TRANSIENT_LOCAL);
  assert(rgbd_image_qos.get_rmw_qos_profile().durability == RMW_QOS_POLICY_DURABILITY_VOLATILE);
  assert(rgbd_image_qos.get_rmw_qos_profile().reliability == RMW_QOS_POLICY_RELIABILITY_RELIABLE);
  assert(rgbd_info_qos.get_rmw_qos_profile().durability == RMW_QOS_POLICY_DURABILITY_VOLATILE);
  assert(rgbd_info_qos.get_rmw_qos_profile().reliability == RMW_QOS_POLICY_RELIABILITY_BEST_EFFORT);

  std_msgs::msg::String text;
  text.data = "quote \" and newline\n";
  assert(encode(text, "std_msgs/msg/String") == "{\"data\":\"quote \\\" and newline\\n\"}");

  std_msgs::msg::UInt64 large;
  large.data = 9007199254740992ULL;
  assert(encode(large, "std_msgs/msg/UInt64") == "{\"data\":\"9007199254740992\"}");

  trajectory_msgs::msg::JointTrajectory trajectory;
  trajectory.joint_names = {"joint1", "joint2"};
  trajectory_msgs::msg::JointTrajectoryPoint point;
  point.positions = {0.1, 0.2};
  point.time_from_start.sec = 2;
  point.time_from_start.nanosec = 500000000;
  trajectory.points.push_back(point);
  const auto json = encode(trajectory, "trajectory_msgs/msg/JointTrajectory");
  assert(json.find("\"joint_names\":[\"joint1\",\"joint2\"]") != std::string::npos);
  assert(json.find("\"positions\":[0.10000000000000001,0.20000000000000001]") != std::string::npos);
  assert(json.find("\"time_from_start\":{\"sec\":2,\"nanosec\":500000000}") != std::string::npos);
  return 0;
}
