#include "easy_debug_bridge/position_motion.hpp"
#include "easy_debug_bridge/position_motion_core.hpp"
namespace easy_debug_bridge {
struct PositionMotion::Impl {};
PositionMotion::PositionMotion(rclcpp::Node &, const std::string &, const std::string &) : impl_(std::make_unique<Impl>()) {}
PositionMotion::~PositionMotion() = default;
void PositionMotion::request(uint64_t, const boost::property_tree::ptree &data, Send send) {
  const auto id = position_json_quote(data.get<std::string>("request_id", ""));
  const auto op = data.get<std::string>("op", "");
  if (op == "position_motion_info")
    send("{\"op\":\"position_motion_info\",\"request_id\":" + id + ",\"available\":false,\"motion_group_supported\":false,\"home_positions\":[],\"message\":\"Bridge 未编译 MoveIt2 支持，请安装 moveit_msgs/control_msgs/controller_manager_msgs 后重新构建\"}");
  else if (op == "position_group_start" || op == "position_group_pause" || op == "position_group_resume")
    send("{\"op\":" + position_json_quote(op + "_ack") + ",\"request_id\":" + id + ",\"accepted\":false,\"command_id\":" + position_json_quote(data.get<std::string>("command_id", "")) + ",\"message\":\"Bridge 未编译 MoveIt2 支持\"}");
  else send("{\"op\":\"error\",\"request_id\":" + id + ",\"message\":\"Bridge 未编译 MoveIt2 支持\"}");
}
void PositionMotion::disconnected(uint64_t) {}
bool PositionMotion::busy() const { return false; }
}
