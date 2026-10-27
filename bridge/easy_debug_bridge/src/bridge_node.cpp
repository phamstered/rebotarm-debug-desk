#include <ament_index_cpp/get_package_share_directory.hpp>
#include <boost/asio.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/websocket.hpp>
#include <boost/property_tree/json_parser.hpp>
#include <boost/property_tree/ptree.hpp>
#include <microros_stm32h723_bridge/msg/hardware_status.hpp>
#include <microros_stm32h723_bridge/msg/joint_command.hpp>
#if __has_include(<microros_stm32h723_bridge/action/gravity_identification.hpp>)
#define EASY_DEBUG_BRIDGE_HAS_GRAVITY_ID 1
#include <rclcpp_action/rclcpp_action.hpp>
#include <microros_stm32h723_bridge/action/gravity_identification.hpp>
#endif
#include <rclcpp/rclcpp.hpp>
#include <rclcpp/serialization.hpp>
#include <rclcpp/typesupport_helpers.hpp>
#include <rmw/types.h>
#include <rmw/time.h>
#include <sensor_msgs/msg/image.hpp>
#include <sensor_msgs/msg/camera_info.hpp>
#include <sensor_msgs/msg/joint_state.hpp>
#include <tf2_ros/buffer.h>
#include <tf2_ros/transform_listener.h>
#include <tf2/exceptions.h>
#include "easy_debug_bridge/rgbd_core.hpp"
#include <std_msgs/msg/bool.hpp>
#include <std_msgs/msg/float32.hpp>
#include <std_msgs/msg/float32_multi_array.hpp>
#include <std_msgs/msg/float64.hpp>
#include <std_msgs/msg/float64_multi_array.hpp>
#include <std_msgs/msg/int32.hpp>
#include <std_msgs/msg/string.hpp>
#include <std_msgs/msg/u_int32.hpp>
#include <trajectory_msgs/msg/joint_trajectory.hpp>
#include <trajectory_msgs/msg/joint_trajectory_point.hpp>
#include "easy_debug_bridge/bridge_build_id.hpp"
#include "easy_debug_bridge/bridge_core.hpp"
#include "easy_debug_bridge/topic_json.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <tuple>
#include <unordered_map>
#include <vector>

namespace asio = boost::asio;
namespace beast = boost::beast;
namespace websocket = beast::websocket;
using tcp = asio::ip::tcp;

static std::string json_quote(const std::string &value) {
  std::ostringstream out;
  out << '"';
  for (unsigned char c : value) {
    switch (c) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\b': out << "\\b"; break;
      case '\f': out << "\\f"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (c < 0x20) {
          out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<int>(c)
              << std::dec;
        } else {
          out << c;
        }
    }
  }
  out << '"';
  return out.str();
}

template <typename Container>
static std::string number_array(const Container &values) {
  std::ostringstream out;
  out << '[';
  for (size_t index = 0; index < values.size(); ++index) {
    if (index) out << ',';
    if (!std::isfinite(static_cast<long double>(values[index]))) out << "null";
    else out << std::setprecision(15) << values[index];
  }
  out << ']';
  return out.str();
}

static std::string header_json(const std_msgs::msg::Header &header) {
  return "{\"stamp\":{\"sec\":" + std::to_string(header.stamp.sec) +
         ",\"nanosec\":" + std::to_string(header.stamp.nanosec) +
         "},\"frame_id\":" + json_quote(header.frame_id) + "}";
}

static std::string mode_name(uint8_t mode) {
  switch (mode) {
    case 0: return "HOLD";
    case 1: return "TRACK";
    case 2: return "RETURN";
    case 3: return "DISABLE";
    default: return "UNKNOWN";
  }
}

static std::string active_joints_json(uint32_t mask) {
  std::ostringstream out;
  out << '[';
  bool first = true;
  for (unsigned index = 0; index < 32; ++index) {
    if ((mask & (uint32_t{1} << index)) == 0) continue;
    if (!first) out << ',';
    first = false;
    out << index;
  }
  out << ']';
  return out.str();
}

static std::string string_array(const std::vector<std::string> &values) {
  std::ostringstream out;
  out << '[';
  for (size_t index = 0; index < values.size(); ++index) {
    if (index) out << ',';
    out << json_quote(values[index]);
  }
  out << ']';
  return out.str();
}

static std::string names_and_types_json(const std::map<std::string, std::vector<std::string>> &entries) {
  std::ostringstream out;
  out << '[';
  bool first = true;
  for (const auto &[name, types] : entries) {
    if (!first) out << ',';
    first = false;
    out << "{\"name\":" << json_quote(name) << ",\"types\":" << string_array(types) << '}';
  }
  out << ']';
  return out.str();
}

static std::string reliability_name(rmw_qos_reliability_policy_t value) {
  switch (value) {
    case RMW_QOS_POLICY_RELIABILITY_RELIABLE: return "RELIABLE";
    case RMW_QOS_POLICY_RELIABILITY_BEST_EFFORT: return "BEST_EFFORT";
    case RMW_QOS_POLICY_RELIABILITY_SYSTEM_DEFAULT: return "SYSTEM_DEFAULT";
    default: return "UNKNOWN";
  }
}

static std::string history_name(rmw_qos_history_policy_t value) {
  switch (value) {
    case RMW_QOS_POLICY_HISTORY_KEEP_LAST: return "KEEP_LAST";
    case RMW_QOS_POLICY_HISTORY_KEEP_ALL: return "KEEP_ALL";
    case RMW_QOS_POLICY_HISTORY_SYSTEM_DEFAULT: return "SYSTEM_DEFAULT";
    default: return "UNKNOWN";
  }
}

static std::string durability_name(rmw_qos_durability_policy_t value) {
  switch (value) {
    case RMW_QOS_POLICY_DURABILITY_VOLATILE: return "VOLATILE";
    case RMW_QOS_POLICY_DURABILITY_TRANSIENT_LOCAL: return "TRANSIENT_LOCAL";
    case RMW_QOS_POLICY_DURABILITY_SYSTEM_DEFAULT: return "SYSTEM_DEFAULT";
    default: return "UNKNOWN";
  }
}

static std::string liveliness_name(rmw_qos_liveliness_policy_t value) {
  switch (value) {
    case RMW_QOS_POLICY_LIVELINESS_AUTOMATIC: return "AUTOMATIC";
    case RMW_QOS_POLICY_LIVELINESS_MANUAL_BY_TOPIC: return "MANUAL_BY_TOPIC";
    case RMW_QOS_POLICY_LIVELINESS_SYSTEM_DEFAULT: return "SYSTEM_DEFAULT";
    default: return "UNKNOWN";
  }
}

static std::string duration_name(const rmw_time_t &value) {
  const rmw_time_t infinite = RMW_DURATION_INFINITE;
  const rmw_time_t unspecified = RMW_DURATION_UNSPECIFIED;
  if (value.sec == infinite.sec && value.nsec == infinite.nsec) return "Infinite";
  if (value.sec == unspecified.sec && value.nsec == unspecified.nsec) return "Default";
  return std::to_string(value.sec) + "s " + std::to_string(value.nsec) + "ns";
}

static std::string gid_name(const std::array<uint8_t, RMW_GID_STORAGE_SIZE> &gid) {
  std::ostringstream out;
  for (size_t index = 0; index < gid.size(); ++index) {
    if (index) out << '.';
    out << std::hex << std::setw(2) << std::setfill('0') << static_cast<unsigned>(gid[index]);
  }
  return out.str();
}

static std::string endpoint_json(const rclcpp::TopicEndpointInfo &endpoint) {
  const auto &qos = endpoint.qos_profile().get_rmw_qos_profile();
  std::ostringstream out;
  out << "{\"node_name\":" << json_quote(endpoint.node_name())
      << ",\"node_namespace\":" << json_quote(endpoint.node_namespace())
      << ",\"topic_type\":" << json_quote(endpoint.topic_type())
      << ",\"endpoint_type\":" << json_quote(endpoint.endpoint_type() == rclcpp::EndpointType::Publisher ? "PUBLISHER" : "SUBSCRIPTION")
      << ",\"gid\":" << json_quote(gid_name(endpoint.endpoint_gid()))
      << ",\"qos\":{\"reliability\":" << json_quote(reliability_name(qos.reliability))
      << ",\"history\":" << json_quote(history_name(qos.history))
      << ",\"depth\":" << qos.depth
      << ",\"durability\":" << json_quote(durability_name(qos.durability))
      << ",\"lifespan\":" << json_quote(duration_name(qos.lifespan))
      << ",\"deadline\":" << json_quote(duration_name(qos.deadline))
      << ",\"liveliness\":" << json_quote(liveliness_name(qos.liveliness))
      << ",\"liveliness_lease_duration\":" << json_quote(duration_name(qos.liveliness_lease_duration))
      << "}}";
  return out.str();
}

static std::string endpoints_json(const std::vector<rclcpp::TopicEndpointInfo> &endpoints) {
  std::ostringstream out;
  out << '[';
  for (size_t index = 0; index < endpoints.size(); ++index) {
    if (index) out << ',';
    out << endpoint_json(endpoints[index]);
  }
  out << ']';
  return out.str();
}

static std::string image_metadata_json(const sensor_msgs::msg::Image &image) {
  return "{\"header\":" + header_json(image.header) +
         ",\"height\":" + std::to_string(image.height) +
         ",\"width\":" + std::to_string(image.width) +
         ",\"encoding\":" + json_quote(image.encoding) +
         ",\"is_bigendian\":" + std::to_string(image.is_bigendian) +
         ",\"step\":" + std::to_string(image.step) +
         ",\"data_length\":" + std::to_string(image.data.size()) + "}";
}

static std::string mime_for(const std::filesystem::path &path) {
  std::string extension = path.extension().string();
  std::transform(extension.begin(), extension.end(), extension.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  if (extension == ".stl") return "model/stl";
  if (extension == ".dae") return "model/vnd.collada+xml";
  if (extension == ".obj") return "model/obj";
  if (extension == ".png") return "image/png";
  if (extension == ".jpg" || extension == ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

class BridgeNode;

class WebSocketSession : public std::enable_shared_from_this<WebSocketSession> {
 public:
  WebSocketSession(tcp::socket socket, std::shared_ptr<BridgeNode> bridge)
      : socket_(std::move(socket)), bridge_(std::move(bridge)) {}

  void run();
  uint64_t id() const { return id_; }

  bool send(const std::string &payload) {
    std::lock_guard<std::mutex> lock(write_mutex_);
    if (!open_.load()) return false;
    beast::error_code error;
    socket_.text(true);
    socket_.write(asio::buffer(payload), error);
    if (error) open_.store(false);
    return !error;
  }

  bool send_binary(const std::vector<uint8_t> &payload) {
    std::lock_guard<std::mutex> lock(write_mutex_);
    if (!open_.load()) return false;
    beast::error_code error;
    socket_.binary(true);
    socket_.write(asio::buffer(payload), error);
    if (error) open_.store(false);
    return !error;
  }

  void image_interest(const std::string &topic, bool enabled) {
    std::lock_guard<std::mutex> lock(image_mutex_);
    if (enabled) image_topics_.insert(topic); else image_topics_.erase(topic);
  }
  bool send_image(const std::string &topic, const std::vector<uint8_t> &payload) {
    std::lock_guard<std::mutex> lock(image_mutex_);
    return image_topics_.count(topic) && send_binary(payload);
  }

 private:
  inline static std::atomic<uint64_t> next_id_{1};
  const uint64_t id_ = next_id_++;
  std::mutex image_mutex_;
  std::set<std::string> image_topics_;
  websocket::stream<tcp::socket> socket_;
  std::shared_ptr<BridgeNode> bridge_;
  std::mutex write_mutex_;
  std::atomic<bool> open_{false};
};

class BridgeNode : public rclcpp::Node {
 public:
  BridgeNode() : Node("easy_debug_bridge") {
    port_ = declare_parameter<int>("port", 8765);
    command_topic_ = declare_parameter<std::string>("command_topic", "/stm32/joint_commands");
    status_topic_ = declare_parameter<std::string>("status_topic", "/stm32/status");
    joint_state_topic_ = declare_parameter<std::string>("joint_state_topic", "/stm32/joint_states");
    // Humble's executor can retain its last subscription while waiting for work.
    // A one-shot executable releases that reference even if the camera stops.
    image_cleanup_timer_ = create_wall_timer(std::chrono::milliseconds(10), [this] {
      image_cleanup_timer_->cancel();
    });
    image_cleanup_timer_->cancel();
    tf_buffer_ = std::make_shared<tf2_ros::Buffer>(get_clock());
    tf_listener_ = std::make_shared<tf2_ros::TransformListener>(*tf_buffer_);
    auto qos = rclcpp::QoS(10).best_effort().durability_volatile();
    command_publisher_ = create_publisher<microros_stm32h723_bridge::msg::JointCommand>(
        command_topic_, qos);
    safety_status_subscription_ = create_subscription<microros_stm32h723_bridge::msg::HardwareStatus>(
        status_topic_, qos,
        [this](const microros_stm32h723_bridge::msg::HardwareStatus::SharedPtr message) {
          std::lock_guard<std::mutex> lock(control_mutex_);
          latest_status_ = *message;
          have_status_ = true;
          status_received_at_ = std::chrono::steady_clock::now();
          if (sequence_ < message->last_command_sequence) {
            sequence_ = message->last_command_sequence;
          }
        });
    safety_joint_subscription_ = create_subscription<sensor_msgs::msg::JointState>(
        joint_state_topic_, qos, [this](const sensor_msgs::msg::JointState::SharedPtr message) {
          std::lock_guard<std::mutex> lock(control_mutex_);
          latest_joint_state_ = *message;
          have_joint_state_ = !message->position.empty() && !message->velocity.empty() &&
                              !message->effort.empty();
          joint_received_at_ = std::chrono::steady_clock::now();
        });
    RCLCPP_INFO(get_logger(), "Easy Debug Bridge configured on 127.0.0.1:%d", port_);
  }

  int port() const { return port_; }

  void add_session(const std::shared_ptr<WebSocketSession> &session) {
    std::lock_guard<std::mutex> lock(session_mutex_);
    sessions_.push_back(session);
  }

  void broadcast(const std::string &payload) {
    std::lock_guard<std::mutex> lock(session_mutex_);
    sessions_.erase(
        std::remove_if(sessions_.begin(), sessions_.end(), [&](auto &weak) {
          auto session = weak.lock();
          return !session || !session->send(payload);
        }),
        sessions_.end());
  }

  void broadcast_image(const std::string &topic, const std::vector<uint8_t> &payload) {
    std::set<uint64_t> clients;
    { std::lock_guard<std::mutex> lock(subscription_mutex_); clients = image_interests_.clients(topic); }
    std::vector<std::shared_ptr<WebSocketSession>> targets;
    {
      std::lock_guard<std::mutex> lock(session_mutex_);
      for (auto &weak : sessions_) if (auto session = weak.lock()) {
        if (clients.count(session->id())) targets.push_back(session);
      }
    }
    for (auto &session : targets) session->send_image(topic, payload);
  }

  void remove_session(uint64_t client) {
    {
      std::lock_guard<std::mutex> lock(subscription_mutex_);
      for (const auto &topic : image_interests_.disconnect(client)) {
        subscriptions_.erase(topic); subscription_types_.erase(topic);
        image_cleanup_timer_->reset();
      }
    }
    clear_rgbd_session(client);
    std::lock_guard<std::mutex> sessions_lock(session_mutex_);
    sessions_.erase(std::remove_if(sessions_.begin(), sessions_.end(), [client](auto &weak) {
      const auto session = weak.lock(); return !session || session->id() == client;
    }), sessions_.end());
  }

  void unsubscribe_image(const std::shared_ptr<WebSocketSession> &session, const std::string &topic, const std::string &request_id) {
    if (!easy_debug_bridge::is_valid_graph_name(topic)) { session->send(error_message(request_id, "无效的 Topic 名称")); return; }
    {
      std::lock_guard<std::mutex> lock(subscription_mutex_);
      const auto type = subscription_types_.find(topic);
      if (type != subscription_types_.end() && type->second != "sensor_msgs/msg/Image") {
        session->send(error_message(request_id, "unsubscribe 当前仅支持图像 Topic")); return;
      }
      session->image_interest(topic, false);
      if (image_interests_.remove(topic, session->id())) {
        subscriptions_.erase(topic); subscription_types_.erase(topic);
        image_cleanup_timer_->reset();
      }
    }
    session->send("{\"op\":\"unsubscribed\",\"request_id\":" + json_quote(request_id) + ",\"topic\":" + json_quote(topic) + "}");
  }

  void handle(const std::shared_ptr<WebSocketSession> &session, const std::string &payload) {
    boost::property_tree::ptree request;
    try {
      std::istringstream input(payload);
      boost::property_tree::read_json(input, request);
    } catch (const std::exception &error) {
      session->send(error_message("", std::string("JSON 解析失败：") + error.what()));
      return;
    }
    const std::string op = request.get<std::string>("op", "");
    const std::string request_id = request.get<std::string>("request_id", "");
    try {
      if (op == "hello") {
        session->send(std::string("{\"op\":\"hello\",\"bridge_version\":\"") +
                     EASY_DEBUG_BRIDGE_VERSION + "\",\"bridge_build_id\":\"" +
                     EASY_DEBUG_BRIDGE_BUILD_ID + "\",\"ros_distro\":\"humble\"}");
      } else if (op == "topics") {
        send_topics(session, request_id);
      } else if (op == "graph") {
        send_graph(session, request_id);
      } else if (op == "topic_info") {
        send_topic_info(session, request.get<std::string>("topic", ""), request_id);
      } else if (op == "node_info") {
        send_node_info(session, request.get<std::string>("node", ""), request_id);
      } else if (op == "subscribe") {
        subscribe(session, request.get<std::string>("topic", ""),
                  request.get<std::string>("type", ""), request_id);
      } else if (op == "unsubscribe") {
        unsubscribe_image(session, request.get<std::string>("topic", ""), request_id);
      } else if (op == "subscribe_rgbd") {
        subscribe_rgbd(session, request, request_id);
      } else if (op == "unsubscribe_rgbd") {
        unsubscribe_rgbd(session, request_id);
      } else if (op == "resource") {
        send_resource(session, request.get<std::string>("uri", ""), request_id, request.get<std::string>("encoding", "base64"));
      } else if (op == "joint_command") {
        publish_joint_command(session, request, request_id);
      } else if (op == "trajectory_command") {
        publish_trajectory_command(session, request, request_id);
      } else if (op == "gravity_id_send_goal") {
        gravity_id_send_goal(session, request, request_id);
      } else if (op == "gravity_id_cancel") {
        gravity_id_cancel(session, request_id);
      } else if (op == "gravity_id_status") {
        gravity_id_send_status(session, request_id);
      } else {
        session->send(error_message(request_id, "未知操作：" + op));
      }
    } catch (const std::exception &error) {
      session->send(error_message(request_id, std::string("请求字段无效：") + error.what()));
    }
  }

 private:
  std::string error_message(const std::string &request_id, const std::string &message) const {
    return "{\"op\":\"error\",\"request_id\":" + json_quote(request_id) +
           ",\"message\":" + json_quote(message) + "}";
  }

  rclcpp::QoS compatible_qos(const std::string &topic) {
    // robot_state_publisher normally publishes the URDF once with transient-local durability.
    // Do not depend on graph discovery timing here: a volatile late-joiner cannot recover it.
    if (easy_debug_bridge::is_robot_description_topic(topic)) {
      return rclcpp::QoS(1).reliable().transient_local();
    }
    rclcpp::QoS qos(10);
    const auto publishers = get_publishers_info_by_topic(topic);
    if (publishers.empty()) return qos.best_effort().durability_volatile();
    const auto offered = publishers.front().qos_profile();
    if (offered.reliability() == rclcpp::ReliabilityPolicy::BestEffort) qos.best_effort();
    else qos.reliable();
    if (offered.durability() == rclcpp::DurabilityPolicy::TransientLocal) qos.transient_local();
    else qos.durability_volatile();
    return qos;
  }

  void send_topics(const std::shared_ptr<WebSocketSession> &session, const std::string &request_id) {
    const auto graph = get_topic_names_and_types();
    std::ostringstream out;
    out << "{\"op\":\"topics\",\"request_id\":" << json_quote(request_id) << ",\"topics\":[";
    bool first_topic = true;
    for (const auto &[name, types] : graph) {
      if (!first_topic) out << ',';
      first_topic = false;
      out << "{\"name\":" << json_quote(name) << ",\"types\":" << string_array(types) << '}';
    }
    out << "]}";
    session->send(out.str());
  }

  void send_graph(const std::shared_ptr<WebSocketSession> &session, const std::string &request_id) {
    auto topics = get_topic_names_and_types();
    const auto graph_interface = get_node_graph_interface();
    std::set<std::string> nodes;
    std::set<std::tuple<std::string, std::string, std::string>> edges;
    for (const auto &[node_name, node_namespace] : graph_interface->get_node_names_and_namespaces()) {
      const std::string full_name =
          easy_debug_bridge::fully_qualified_node_name(node_namespace, node_name);
      nodes.insert(full_name);
      try {
        for (const auto &[topic, types] :
             graph_interface->get_publisher_names_and_types_by_node(node_name, node_namespace)) {
          topics[topic] = types;
          edges.emplace("node:" + full_name, "topic:" + topic, "publish");
        }
        for (const auto &[topic, types] :
             graph_interface->get_subscriber_names_and_types_by_node(node_name, node_namespace)) {
          topics[topic] = types;
          edges.emplace("topic:" + topic, "node:" + full_name, "subscribe");
        }
      } catch (const std::exception &) {
        // ROS graph can change between listing a node and querying its endpoints.
      }
    }

    std::ostringstream out;
    out << "{\"op\":\"graph\",\"request_id\":" << json_quote(request_id)
        << ",\"nodes\":[";
    bool first = true;
    for (const auto &node : nodes) {
      if (!first) out << ',';
      first = false;
      out << "{\"id\":" << json_quote("node:" + node)
          << ",\"label\":" << json_quote(node)
          << ",\"kind\":\"node\",\"types\":[]}";
    }
    for (const auto &[topic, types] : topics) {
      if (!first) out << ',';
      first = false;
      out << "{\"id\":" << json_quote("topic:" + topic)
          << ",\"label\":" << json_quote(topic)
          << ",\"kind\":\"topic\",\"types\":" << string_array(types) << '}';
    }
    out << "],\"edges\":[";
    first = true;
    for (const auto &[source, target, relation] : edges) {
      if (!first) out << ',';
      first = false;
      out << "{\"source\":" << json_quote(source)
          << ",\"target\":" << json_quote(target)
          << ",\"relation\":" << json_quote(relation) << '}';
    }
    out << "]}";
    session->send(out.str());
  }

  void send_topic_info(const std::shared_ptr<WebSocketSession> &session,
                       const std::string &topic, const std::string &request_id) {
    if (!easy_debug_bridge::is_valid_graph_name(topic)) {
      session->send(error_message(request_id, "无效 Topic 名称"));
      return;
    }
    const auto topics = get_topic_names_and_types();
    const auto found = topics.find(topic);
    if (found == topics.end()) {
      session->send(error_message(request_id, "Topic 不存在或已离线：" + topic));
      return;
    }
    const auto publishers = get_publishers_info_by_topic(topic);
    const auto subscriptions = get_subscriptions_info_by_topic(topic);
    std::ostringstream out;
    out << "{\"op\":\"topic_info\",\"request_id\":" << json_quote(request_id)
        << ",\"topic_info\":{\"name\":" << json_quote(topic)
        << ",\"types\":" << string_array(found->second)
        << ",\"publishers\":" << endpoints_json(publishers)
        << ",\"subscriptions\":" << endpoints_json(subscriptions) << "}}";
    session->send(out.str());
  }

  void send_node_info(const std::shared_ptr<WebSocketSession> &session,
                      const std::string &full_name, const std::string &request_id) {
    if (!easy_debug_bridge::is_valid_graph_name(full_name)) {
      session->send(error_message(request_id, "无效 Node 名称"));
      return;
    }
    const auto graph_interface = get_node_graph_interface();
    for (const auto &[name, node_namespace] : graph_interface->get_node_names_and_namespaces()) {
      if (easy_debug_bridge::fully_qualified_node_name(node_namespace, name) != full_name) continue;
      std::ostringstream out;
      out << "{\"op\":\"node_info\",\"request_id\":" << json_quote(request_id)
          << ",\"node_info\":{\"name\":" << json_quote(full_name)
          << ",\"namespace\":" << json_quote(node_namespace)
          << ",\"publishers\":" << names_and_types_json(graph_interface->get_publisher_names_and_types_by_node(name, node_namespace))
          << ",\"subscriptions\":" << names_and_types_json(graph_interface->get_subscriber_names_and_types_by_node(name, node_namespace))
          << ",\"services\":" << names_and_types_json(graph_interface->get_service_names_and_types_by_node(name, node_namespace))
          << ",\"clients\":" << names_and_types_json(graph_interface->get_client_names_and_types_by_node(name, node_namespace))
          << "}}";
      session->send(out.str());
      return;
    }
    session->send(error_message(request_id, "Node 不存在或已离线：" + full_name));
  }

  template <typename Message, typename Encoder>
  void create_typed_subscription(const std::string &topic, Encoder encoder) {
    auto subscription = create_subscription<Message>(
        topic, compatible_qos(topic),
        [this, topic, encoder](const typename Message::SharedPtr message) {
          broadcast("{\"op\":\"topic_message\",\"topic\":" + json_quote(topic) +
                    ",\"data\":" + encoder(*message) + "}");
        });
    subscriptions_[topic] = subscription;
  }

  void subscribe(const std::shared_ptr<WebSocketSession> &session, const std::string &topic,
                 const std::string &type, const std::string &request_id) {
    if (topic.empty() || type.empty()) {
      session->send(error_message(request_id, "Topic 和类型不能为空"));
      return;
    }
    const auto discovered = get_topic_names_and_types();
    const auto topic_types = discovered.find(topic);
    if (topic_types != discovered.end() &&
        std::find(topic_types->second.begin(), topic_types->second.end(), type) == topic_types->second.end()) {
      session->send(error_message(request_id, "Topic 的实际类型与请求不符：" + type));
      return;
    }
    {
      std::lock_guard<std::mutex> lock(subscription_mutex_);
      if (subscriptions_.count(topic)) {
        if (subscription_types_.at(topic) != type) {
          session->send(error_message(request_id, "该 Topic 已按其他消息类型订阅：" + subscription_types_.at(topic)));
          return;
        }
        if (type == "sensor_msgs/msg/Image") { image_interests_.add(topic, session->id()); session->image_interest(topic, true); }
        session->send("{\"op\":\"subscribed\",\"request_id\":" + json_quote(request_id) +
                      ",\"topic\":" + json_quote(topic) + "}");
        return;
      }
      if (type == "std_msgs/msg/String") {
        create_typed_subscription<std_msgs::msg::String>(topic,
          [](const auto &m) { return json_quote(m.data); });
      } else if (type == "std_msgs/msg/Float64") {
        create_typed_subscription<std_msgs::msg::Float64>(topic,
          [](const auto &m) { return std::isfinite(m.data) ? std::to_string(m.data) : std::string("null"); });
      } else if (type == "std_msgs/msg/Float32") {
        create_typed_subscription<std_msgs::msg::Float32>(topic,
          [](const auto &m) { return std::isfinite(m.data) ? std::to_string(m.data) : std::string("null"); });
      } else if (type == "std_msgs/msg/Int32") {
        create_typed_subscription<std_msgs::msg::Int32>(topic,
          [](const auto &m) { return std::to_string(m.data); });
      } else if (type == "std_msgs/msg/UInt32") {
        create_typed_subscription<std_msgs::msg::UInt32>(topic,
          [](const auto &m) { return std::to_string(m.data); });
      } else if (type == "std_msgs/msg/Bool") {
        create_typed_subscription<std_msgs::msg::Bool>(topic,
          [](const auto &m) { return m.data ? std::string("true") : std::string("false"); });
      } else if (type == "std_msgs/msg/Float64MultiArray") {
        create_typed_subscription<std_msgs::msg::Float64MultiArray>(topic,
          [](const auto &m) { return "{\"data\":" + number_array(m.data) + "}"; });
      } else if (type == "std_msgs/msg/Float32MultiArray") {
        create_typed_subscription<std_msgs::msg::Float32MultiArray>(topic,
          [](const auto &m) { return "{\"data\":" + number_array(m.data) + "}"; });
      } else if (type == "sensor_msgs/msg/JointState") {
        create_typed_subscription<sensor_msgs::msg::JointState>(topic, [](const auto &m) {
          return "{\"name\":" + string_array(m.name) + ",\"position\":" + number_array(m.position) +
                 ",\"velocity\":" + number_array(m.velocity) + ",\"effort\":" + number_array(m.effort) + "}";
        });
      } else if (type == "sensor_msgs/msg/Image") {
        auto subscription = create_subscription<sensor_msgs::msg::Image>(
            topic, compatible_qos(topic), [this, topic](const sensor_msgs::msg::Image::SharedPtr message) {
              const std::string metadata = "{\"op\":\"topic_message\",\"topic\":" +
                  json_quote(topic) + ",\"data\":" + image_metadata_json(*message) + "}";
              broadcast_image(topic, easy_debug_bridge::binary_image_frame(metadata, message->data));
            });
        subscriptions_[topic] = subscription;
        image_interests_.add(topic, session->id());
        session->image_interest(topic, true);
      } else if (type == "microros_stm32h723_bridge/msg/JointCommand") {
        create_typed_subscription<microros_stm32h723_bridge::msg::JointCommand>(topic, [](const auto &m) {
          return "{\"header\":" + header_json(m.header) +
                 ",\"sequence\":" + std::to_string(m.sequence) +
                 ",\"mode\":" + std::to_string(m.mode) +
                 ",\"mode_name\":" + json_quote(mode_name(m.mode)) +
                 ",\"position\":" + number_array(m.position) +
                 ",\"velocity\":" + number_array(m.velocity) +
                 ",\"kp\":" + number_array(m.kp) +
                 ",\"kd\":" + number_array(m.kd) +
                 ",\"effort\":" + number_array(m.effort) + "}";
        });
      } else if (type == "microros_stm32h723_bridge/msg/HardwareStatus") {
        create_typed_subscription<microros_stm32h723_bridge::msg::HardwareStatus>(topic, [](const auto &m) {
          return "{\"header\":" + header_json(m.header) +
                 ",\"last_command_sequence\":" + std::to_string(m.last_command_sequence) +
                 ",\"mode\":" + std::to_string(m.mode) +
                 ",\"mode_name\":" + json_quote(mode_name(m.mode)) +
                 ",\"active_joint_mask\":" + std::to_string(m.active_joint_mask) +
                 ",\"active_joints\":" + active_joints_json(m.active_joint_mask) +
                 ",\"fault_code\":" + std::to_string(m.fault_code) + "}";
        });
      } else {
        try {
          constexpr const char *identifier = "rosidl_typesupport_introspection_cpp";
          auto library = rclcpp::get_typesupport_library(type, identifier);
          const auto *handle = rclcpp::get_typesupport_handle(type, identifier, *library);
          if (!handle || !handle->data) throw std::runtime_error("缺少消息字段描述");
          const auto *members = static_cast<const rosidl_typesupport_introspection_cpp::MessageMembers *>(handle->data);
          if (!members->init_function || !members->fini_function) {
            throw std::runtime_error("缺少消息构造或释放函数");
          }
          auto serialization_library = rclcpp::get_typesupport_library(type, "rosidl_typesupport_cpp");
          const auto *serialization_handle = rclcpp::get_typesupport_handle(
              type, "rosidl_typesupport_cpp", *serialization_library);
          if (!serialization_handle) throw std::runtime_error("缺少序列化类型支持");
          auto serializer = std::make_shared<rclcpp::SerializationBase>(serialization_handle);
          auto subscription = create_generic_subscription(
              topic, type, compatible_qos(topic),
              [this, topic, library, serialization_library, members, serializer](
                  std::shared_ptr<rclcpp::SerializedMessage> serialized) {
                try {
                  void *storage = ::operator new(members->size_of_);
                  try {
                    members->init_function(storage, rosidl_runtime_cpp::MessageInitialization::ALL);
                  } catch (...) {
                    ::operator delete(storage);
                    throw;
                  }
                  const auto cleanup = [members](void *value) {
                    members->fini_function(value);
                    ::operator delete(value);
                  };
                  std::unique_ptr<void, decltype(cleanup)> message(storage, cleanup);
                  serializer->deserialize_message(serialized.get(), message.get());
                  broadcast("{\"op\":\"topic_message\",\"topic\":" + json_quote(topic) +
                            ",\"data\":" + easy_debug_bridge::message_to_json(message.get(), *members) + "}");
                } catch (const std::exception &error) {
                  RCLCPP_ERROR(get_logger(), "Topic %s 解码失败：%s", topic.c_str(), error.what());
                }
              });
          subscriptions_[topic] = subscription;
        } catch (const std::exception &error) {
          session->send(error_message(request_id, "无法加载消息类型 " + type + "：" + error.what()));
          return;
        }
      }
      subscription_types_[topic] = type;
    }
    session->send("{\"op\":\"subscribed\",\"request_id\":" + json_quote(request_id) +
                  ",\"topic\":" + json_quote(topic) + "}");
  }

  void send_resource(const std::shared_ptr<WebSocketSession> &session, const std::string &uri,
                     const std::string &request_id, const std::string &encoding) {
    if (encoding != "base64" && encoding != "binary") { session->send(error_message(request_id, "不支持的资源编码")); return; }
    constexpr const char *prefix = "package://";
    if (uri.rfind(prefix, 0) != 0) {
      session->send(error_message(request_id, "仅允许 package:// 资源"));
      return;
    }
    const std::string remainder = uri.substr(std::char_traits<char>::length(prefix));
    const auto slash = remainder.find('/');
    if (slash == std::string::npos) {
      session->send(error_message(request_id, "无效的 package URI"));
      return;
    }
    try {
      const auto root = std::filesystem::canonical(
          ament_index_cpp::get_package_share_directory(remainder.substr(0, slash)));
      const auto path = easy_debug_bridge::package_resource_path(
          root, std::filesystem::path(remainder.substr(slash + 1)));
      if (!path) {
        session->send(error_message(request_id, "资源路径越过 package 目录"));
        return;
      }
      if (!std::filesystem::is_regular_file(*path)) {
        session->send(error_message(request_id, "资源不存在或不是普通文件"));
        return;
      }
      std::ifstream file(*path, std::ios::binary);
      if (!file) {
        session->send(error_message(request_id, "资源文件无法读取"));
        return;
      }
      const auto size = std::filesystem::file_size(*path);
      if (size > 64 * 1024 * 1024) { session->send(error_message(request_id, "资源超过 64 MiB 上限")); return; }
      std::vector<uint8_t> bytes(size);
      if (size && !file.read(reinterpret_cast<char *>(bytes.data()), static_cast<std::streamsize>(size))) {
        session->send(error_message(request_id, "资源文件读取不完整")); return;
      }
      const std::string metadata = "{\"op\":\"resource\",\"request_id\":" + json_quote(request_id) +
          ",\"uri\":" + json_quote(uri) + ",\"mime\":" + json_quote(mime_for(*path));
      if (encoding == "binary") {
        session->send_binary(easy_debug_bridge::binary_resource_frame(metadata + ",\"data_length\":" + std::to_string(bytes.size()) + "}", bytes));
      } else {
        session->send(metadata + ",\"base64\":" + json_quote(easy_debug_bridge::base64_encode(bytes)) + "}");
      }
    } catch (const std::exception &error) {
      session->send(error_message(request_id, std::string("资源读取失败：") + error.what()));
    }
  }

  void publish_joint_command(const std::shared_ptr<WebSocketSession> &session,
                             const boost::property_tree::ptree &request,
                             const std::string &request_id) {
    const int mode_value = request.get<int>("mode", -1);
    const double velocity = request.get<double>("velocity", 0.0);
    const double kp = request.get<double>("kp", 0.0);
    const double kd = request.get<double>("kd", 0.0);
    const double effort = request.get<double>("effort", 0.0);
    const bool disable = mode_value == microros_stm32h723_bridge::msg::JointCommand::MODE_DISABLE;

    easy_debug_bridge::CommandFields fields;
    fields.mode = mode_value;
    fields.position = 0.0;
    fields.velocity = velocity;
    fields.kp = kp;
    fields.kd = kd;
    fields.effort = effort;
    fields.confirmation = request.get<std::string>("confirmation", "");
    if (const auto position_node = request.get_child_optional("position")) {
      if (!position_node->empty()) {
        for (const auto &item : *position_node) {
          fields.positions.push_back(item.second.get_value<double>());
        }
      } else {
        fields.position = position_node->get_value<double>();
      }
    }
    if (request.get_child_optional("active_joint_mask")) {
      fields.mask_specified = true;
      fields.requested_joint_mask = request.get<uint32_t>("active_joint_mask", 0);
    }

    switch (easy_debug_bridge::validate_command(fields)) {
      case easy_debug_bridge::CommandValidation::InvalidMode:
        session->send(error_message(request_id, "无效的 JointCommand.mode")); return;
      case easy_debug_bridge::CommandValidation::NotArmed:
        session->send(error_message(request_id, "控制面板尚未解锁")); return;
      case easy_debug_bridge::CommandValidation::NonFinite:
        session->send(error_message(request_id, "控制指令包含非有限数值")); return;
      case easy_debug_bridge::CommandValidation::EffortLimit:
        session->send(error_message(request_id, "超过安全限幅：|effort|≤1")); return;
      case easy_debug_bridge::CommandValidation::EmptyJointMask:
        session->send(error_message(request_id, "未选择要控制的关节")); return;
      case easy_debug_bridge::CommandValidation::Ok:
        break;
    }
    if (command_publisher_->get_subscription_count() == 0) {
      session->send(error_message(request_id, "STM32 command subscriber 不可用"));
      return;
    }

    microros_stm32h723_bridge::msg::JointCommand command;
    std::vector<uint32_t> sequences;
    uint32_t effective_mask = 0;
    {
      std::lock_guard<std::mutex> lock(control_mutex_);
      const auto now_steady = std::chrono::steady_clock::now();
      if (!disable) {
        if (!have_status_ || !have_joint_state_) {
          session->send(error_message(request_id, "尚未收到 STM32 status 或 joint feedback"));
          return;
        }
        const auto status_age = std::chrono::duration_cast<std::chrono::milliseconds>(
            now_steady - status_received_at_).count();
        const auto joint_age = std::chrono::duration_cast<std::chrono::milliseconds>(
            now_steady - joint_received_at_).count();
        if (status_age > 1000 || joint_age > 1000) {
          session->send(error_message(request_id, "STM32 status 或 joint feedback 已过期"));
          return;
        }
        const uint32_t requested = easy_debug_bridge::requested_command_mask(fields);
        effective_mask = easy_debug_bridge::resolve_command_mask(
            requested, latest_status_.active_joint_mask);
        if (effective_mask == 0) {
          session->send(error_message(
              request_id, "所选关节未全部处于固件 active_joint_mask"));
          return;
        }
      }
      sequences = easy_debug_bridge::allocate_sequences(sequence_, disable ? 3U : 1U);
      command.sequence = sequences.front();
    }

    command.header.stamp = now();
    command.header.frame_id = "base_link";
    command.mode = static_cast<uint8_t>(mode_value);
    command.position.fill(0.0F);
    command.velocity.fill(0.0F);
    command.kp.fill(0.0F);
    command.kd.fill(0.0F);
    command.effort.fill(0.0F);
    if (!disable) {
      const size_t joint_count = command.position.size();
      std::vector<double> positions(joint_count, 0.0);
      std::vector<double> velocities(joint_count, 0.0);
      std::vector<double> kps(joint_count, 0.0);
      std::vector<double> kds(joint_count, 0.0);
      std::vector<double> efforts(joint_count, 0.0);
      easy_debug_bridge::fill_joint_command_channels(
          effective_mask, fields, joint_count,
          positions.data(), velocities.data(), kps.data(), kds.data(), efforts.data());
      for (size_t index = 0; index < joint_count; ++index) {
        command.position[index] = static_cast<float>(positions[index]);
        command.velocity[index] = static_cast<float>(velocities[index]);
        command.kp[index] = static_cast<float>(kps[index]);
        command.kd[index] = static_cast<float>(kds[index]);
        command.effort[index] = static_cast<float>(efforts[index]);
      }
    }
    for (const uint32_t sequence : sequences) {
      command.sequence = sequence;
      command.header.stamp = now();
      command_publisher_->publish(command);
    }
    session->send("{\"op\":\"joint_command_ack\",\"request_id\":" + json_quote(request_id) +
                  ",\"sequence\":" + std::to_string(command.sequence) +
                  ",\"mode\":" + std::to_string(command.mode) + "}");
  }

  // 轨迹指令发往 JointTrajectoryController 的 ~/joint_trajectory 订阅，
  // 因此 Topic 由前端按当前 active 的控制器指定，Bridge 只做校验和转发。
  void publish_trajectory_command(const std::shared_ptr<WebSocketSession> &session,
                                  const boost::property_tree::ptree &request,
                                  const std::string &request_id) {
    easy_debug_bridge::TrajectoryCommand command;
    command.topic = request.get<std::string>("topic", "");
    if (const auto names = request.get_child_optional("joint_names")) {
      for (const auto &item : *names) {
        command.joint_names.push_back(item.second.get_value<std::string>());
      }
    }
    if (const auto points = request.get_child_optional("trajectory_points")) {
      for (const auto &item : *points) {
        const auto &node = item.second;
        easy_debug_bridge::TrajectoryPointSpec point;
        if (const auto positions = node.get_child_optional("positions")) {
          for (const auto &value : *positions) {
            point.positions.push_back(value.second.get_value<double>());
          }
        }
        if (const auto velocities = node.get_child_optional("velocities")) {
          for (const auto &value : *velocities) {
            point.velocities.push_back(value.second.get_value<double>());
          }
        }
        point.time_from_start = node.get<double>("time_from_start", 0.0);
        command.points.push_back(std::move(point));
      }
    }

    const auto validation = easy_debug_bridge::validate_trajectory_command(command);
    if (validation != easy_debug_bridge::TrajectoryValidation::Ok) {
      session->send(error_message(request_id, easy_debug_bridge::trajectory_validation_message(validation)));
      return;
    }

    auto publisher = trajectory_publisher(command.topic);
    if (publisher->get_subscription_count() == 0) {
      session->send(error_message(request_id, "轨迹控制器订阅不可用"));
      return;
    }

    trajectory_msgs::msg::JointTrajectory message;
    message.header.stamp = now();
    message.joint_names = command.joint_names;
    message.points.reserve(command.points.size());
    for (const auto &point : command.points) {
      trajectory_msgs::msg::JointTrajectoryPoint target;
      target.positions = point.positions;
      target.velocities = point.velocities;
      const auto stamp = easy_debug_bridge::duration_fields(point.time_from_start);
      target.time_from_start.sec = stamp.first;
      target.time_from_start.nanosec = stamp.second;
      message.points.push_back(std::move(target));
    }
    publisher->publish(message);
    session->send("{\"op\":\"trajectory_command_ack\",\"request_id\":" + json_quote(request_id) +
                  ",\"joints\":" + std::to_string(command.joint_names.size()) +
                  ",\"points\":" + std::to_string(command.points.size()) + "}");
  }


  static std::string float_array_json(const std::vector<float> &values) {
    std::ostringstream out;
    out << '[';
    for (size_t i = 0; i < values.size(); ++i) {
      if (i) out << ',';
      if (std::isfinite(values[i])) out << values[i];
      else out << "null";
    }
    out << ']';
    return out.str();
  }

  static std::string string_array_json(const std::vector<std::string> &values) {
    std::ostringstream out;
    out << '[';
    for (size_t i = 0; i < values.size(); ++i) {
      if (i) out << ',';
      out << json_quote(values[i]);
    }
    out << ']';
    return out.str();
  }

#if defined(EASY_DEBUG_BRIDGE_HAS_GRAVITY_ID) && EASY_DEBUG_BRIDGE_HAS_GRAVITY_ID
  using GravityIdentification = microros_stm32h723_bridge::action::GravityIdentification;
  using GoalHandleGravityId = rclcpp_action::ClientGoalHandle<GravityIdentification>;

  void ensure_gravity_id_client() {
    if (!gravity_id_client_) {
      gravity_id_client_ = rclcpp_action::create_client<GravityIdentification>(
          this, "/StartGravityID");
    }
  }
#endif

    easy_debug_bridge::GravityIdGoalFields parse_gravity_id_goal(
      const boost::property_tree::ptree &request) const {
    easy_debug_bridge::GravityIdGoalFields goal;
    goal.joint_mask = request.get<uint32_t>("joint_mask", easy_debug_bridge::GRAVITY_ID_DEFAULT_JOINT_MASK);
    goal.mode = static_cast<uint8_t>(request.get<int>("mode", 0));
    goal.settle_time_s = request.get<double>("settle_time_s", 1.5);
    goal.capture_window_s = request.get<double>("capture_window_s", 1.0);
    goal.write_yaml = request.get<bool>("write_yaml", true);
    goal.hot_reload = request.get<bool>("hot_reload", true);
    goal.output_yaml_path = request.get<std::string>("output_yaml_path", "");
    goal.max_effort_nm = request.get<double>("max_effort_nm", 1.0);
    goal.max_velocity_rad_s = request.get<double>("max_velocity_rad_s", 0.15);
    goal.command_timeout_ms = request.get<double>("command_timeout_ms", 100.0);
    goal.lock_gripper = request.get<bool>("lock_gripper", true);
    goal.confirmation = request.get<std::string>("confirmation", "");
    if (const auto ids = request.get_child_optional("pose_set_id")) {
      for (const auto &item : *ids) {
        goal.pose_set_id.push_back(item.second.get_value<std::string>());
      }
    }
    return goal;
  }

  void gravity_id_send_status(const std::shared_ptr<WebSocketSession> &session,
                              const std::string &request_id) {
#if defined(EASY_DEBUG_BRIDGE_HAS_GRAVITY_ID) && EASY_DEBUG_BRIDGE_HAS_GRAVITY_ID
    std::string status = "idle";
    {
      std::lock_guard<std::mutex> lock(gravity_id_mutex_);
      status = gravity_id_status_;
    }
    session->send("{\"op\":\"gravity_id_status\",\"request_id\":" + json_quote(request_id) +
                  ",\"status\":" + json_quote(status) + "}");
#else
    session->send(error_message(
        request_id,
        "GravityIdentification action 未编译进 Bridge（Jetson 需 stack PR #23 的 "
        "microros_stm32h723_bridge，并重新 colcon build easy_debug_bridge）"));
#endif
  }

  void gravity_id_cancel(const std::shared_ptr<WebSocketSession> &session,
                         const std::string &request_id) {
#if defined(EASY_DEBUG_BRIDGE_HAS_GRAVITY_ID) && EASY_DEBUG_BRIDGE_HAS_GRAVITY_ID
    std::shared_ptr<GoalHandleGravityId> handle;
    {
      std::lock_guard<std::mutex> lock(gravity_id_mutex_);
      handle = gravity_id_goal_handle_;
      gravity_id_status_ = "canceling";
    }
    if (!handle) {
      session->send(error_message(request_id, "没有正在执行的 GravityIdentification goal"));
      return;
    }
    ensure_gravity_id_client();
    gravity_id_client_->async_cancel_goal(
        handle,
        [this, session, request_id](auto /*cancel_response*/) {
          session->send("{\"op\":\"gravity_id_cancel_ack\",\"request_id\":" +
                        json_quote(request_id) + "}");
          broadcast("{\"op\":\"gravity_id_status\",\"status\":\"canceling\"}");
        });
#else
    session->send(error_message(
        request_id,
        "GravityIdentification action 未编译进 Bridge（Jetson 需 stack PR #23 的 "
        "microros_stm32h723_bridge，并重新 colcon build easy_debug_bridge）"));
#endif
  }

  void gravity_id_send_goal(const std::shared_ptr<WebSocketSession> &session,
                            const boost::property_tree::ptree &request,
                            const std::string &request_id) {
    const auto fields = parse_gravity_id_goal(request);
    const auto validation = easy_debug_bridge::validate_gravity_id_goal(fields);
    if (validation != easy_debug_bridge::GravityIdGoalValidation::Ok) {
      session->send(error_message(
          request_id, easy_debug_bridge::gravity_id_goal_validation_message(validation)));
      return;
    }
#if defined(EASY_DEBUG_BRIDGE_HAS_GRAVITY_ID) && EASY_DEBUG_BRIDGE_HAS_GRAVITY_ID
    ensure_gravity_id_client();
    if (!gravity_id_client_->wait_for_action_server(std::chrono::milliseconds(500))) {
      session->send(error_message(request_id, "GravityIdentification action 服务器 /StartGravityID 不可用"));
      return;
    }
    {
      std::lock_guard<std::mutex> lock(gravity_id_mutex_);
      if (gravity_id_goal_handle_) {
        session->send(error_message(request_id, "已有 GravityIdentification goal 在执行，请先 Abort"));
        return;
      }
    }

    using GravityIdentification = microros_stm32h723_bridge::action::GravityIdentification;
    auto goal = GravityIdentification::Goal();
    goal.joint_mask = easy_debug_bridge::gravity_id_effective_mask(fields.joint_mask);
    goal.mode = fields.mode;
    goal.pose_set_id = fields.pose_set_id;
    goal.settle_time_s = static_cast<float>(fields.settle_time_s);
    goal.capture_window_s = static_cast<float>(fields.capture_window_s);
    goal.write_yaml = fields.write_yaml;
    goal.hot_reload = fields.hot_reload;
    goal.output_yaml_path = fields.output_yaml_path;
    goal.max_effort_nm = static_cast<float>(fields.max_effort_nm);
    goal.max_velocity_rad_s = static_cast<float>(fields.max_velocity_rad_s);
    goal.command_timeout_ms = static_cast<float>(fields.command_timeout_ms);
    goal.lock_gripper = fields.lock_gripper;

    auto options = rclcpp_action::Client<GravityIdentification>::SendGoalOptions();
    options.goal_response_callback =
        [this, session, request_id](std::shared_ptr<GoalHandleGravityId> handle) {
          if (!handle) {
            {
              std::lock_guard<std::mutex> lock(gravity_id_mutex_);
              gravity_id_status_ = "idle";
              gravity_id_goal_handle_.reset();
            }
            session->send(error_message(request_id, "GravityIdentification goal 被拒绝"));
            broadcast("{\"op\":\"gravity_id_status\",\"status\":\"rejected\"}");
            return;
          }
          {
            std::lock_guard<std::mutex> lock(gravity_id_mutex_);
            gravity_id_goal_handle_ = handle;
            gravity_id_status_ = "executing";
            gravity_id_last_feedback_at_ = std::chrono::steady_clock::time_point{};
          }
          session->send("{\"op\":\"gravity_id_send_goal_ack\",\"request_id\":" +
                        json_quote(request_id) + ",\"accepted\":true}");
          broadcast("{\"op\":\"gravity_id_status\",\"status\":\"executing\"}");
        };
    options.feedback_callback =
        [this](GoalHandleGravityId::SharedPtr,
               const std::shared_ptr<const GravityIdentification::Feedback> feedback) {
          const auto now = std::chrono::steady_clock::now();
          {
            std::lock_guard<std::mutex> lock(gravity_id_mutex_);
            if (gravity_id_last_feedback_at_.time_since_epoch().count() != 0) {
              const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                  now - gravity_id_last_feedback_at_).count();
              if (elapsed < 100) return;  // throttle ≤10 Hz
            }
            gravity_id_last_feedback_at_ = now;
          }
          std::ostringstream out;
          out << "{\"op\":\"gravity_id_feedback\""
              << ",\"phase\":" << static_cast<int>(feedback->phase)
              << ",\"pose_index\":" << feedback->pose_index
              << ",\"pose_count\":" << feedback->pose_count
              << ",\"active_joint_mask\":" << feedback->active_joint_mask
              << ",\"residual_nm\":" << float_array_json(feedback->residual_nm)
              << ",\"measured_effort_nm\":" << float_array_json(feedback->measured_effort_nm)
              << ",\"model_effort_nm\":" << float_array_json(feedback->model_effort_nm)
              << ",\"rmse_running\":" << feedback->rmse_running
              << ",\"fault_code\":" << feedback->fault_code
              << ",\"message\":" << json_quote(feedback->message) << '}';
          broadcast(out.str());
        };
    options.result_callback =
        [this](const GoalHandleGravityId::WrappedResult &result) {
          {
            std::lock_guard<std::mutex> lock(gravity_id_mutex_);
            gravity_id_goal_handle_.reset();
            gravity_id_status_ = "idle";
          }
          const bool success = result.code == rclcpp_action::ResultCode::SUCCEEDED &&
                               result.result && result.result->success;
          std::ostringstream out;
          out << "{\"op\":\"gravity_id_result\""
              << ",\"success\":" << (success ? "true" : "false")
              << ",\"code\":" << static_cast<int>(result.code);
          if (result.result) {
            out << ",\"fault_code\":" << result.result->fault_code
                << ",\"gravity_scales\":" << float_array_json(result.result->gravity_scales)
                << ",\"torque_biases_nm\":" << float_array_json(result.result->torque_biases_nm)
                << ",\"rmse_per_joint\":" << float_array_json(result.result->rmse_per_joint)
                << ",\"rmse_total\":" << result.result->rmse_total
                << ",\"yaml_path\":" << json_quote(result.result->yaml_path)
                << ",\"message\":" << json_quote(result.result->message);
          } else {
            out << ",\"fault_code\":0,\"gravity_scales\":[],\"torque_biases_nm\":[],"
                   "\"rmse_per_joint\":[],\"rmse_total\":0,\"yaml_path\":\"\","
                   "\"message\":" << json_quote("GravityIdentification 无 result 载荷");
          }
          out << '}';
          broadcast(out.str());
          broadcast("{\"op\":\"gravity_id_status\",\"status\":\"idle\"}");
        };

    {
      std::lock_guard<std::mutex> lock(gravity_id_mutex_);
      gravity_id_status_ = "accepted";
    }
    gravity_id_client_->async_send_goal(goal, options);
#else
    session->send(error_message(
        request_id,
        "GravityIdentification action 未编译进 Bridge（Jetson 需 stack PR #23 的 "
        "microros_stm32h723_bridge，并重新 colcon build easy_debug_bridge）"));
#endif
  }


  struct RgbdSession {
    uint64_t client_id = 0;
    std::string rgb_topic;
    std::string depth_topic;
    std::string camera_info_topic;
    std::string target_frame{"base_link"};
    uint32_t max_width = 320;
    uint32_t max_height = 240;
    double max_fps = 12.0;
    int64_t stamp_tolerance_ns = 50000000;
    rclcpp::Subscription<sensor_msgs::msg::Image>::SharedPtr rgb_sub;
    rclcpp::Subscription<sensor_msgs::msg::Image>::SharedPtr depth_sub;
    rclcpp::Subscription<sensor_msgs::msg::CameraInfo>::SharedPtr info_sub;
    sensor_msgs::msg::Image::SharedPtr latest_rgb;
    sensor_msgs::msg::Image::SharedPtr latest_depth;
    sensor_msgs::msg::CameraInfo::SharedPtr latest_info;
    std::chrono::steady_clock::time_point last_sent{};
    std::mutex mutex;
  };

  void clear_rgbd_session(uint64_t client) {
    std::lock_guard<std::mutex> lock(rgbd_mutex_);
    rgbd_sessions_.erase(client);
  }

  std::shared_ptr<WebSocketSession> find_session(uint64_t client) {
    std::lock_guard<std::mutex> lock(session_mutex_);
    for (auto &weak : sessions_) {
      if (auto session = weak.lock()) {
        if (session->id() == client) return session;
      }
    }
    return nullptr;
  }

  void unsubscribe_rgbd(const std::shared_ptr<WebSocketSession> &session, const std::string &request_id) {
    clear_rgbd_session(session->id());
    session->send("{\"op\":\"unsubscribed_rgbd\",\"request_id\":" + json_quote(request_id) + "}");
  }

  void subscribe_rgbd(const std::shared_ptr<WebSocketSession> &session,
                      const boost::property_tree::ptree &request,
                      const std::string &request_id) {
    const std::string rgb_topic = request.get<std::string>("rgb_topic", "/camera/color/image_raw");
    const std::string depth_topic = request.get<std::string>(
        "depth_topic", "/camera/aligned_depth_to_color/image_raw");
    const std::string info_topic = request.get<std::string>(
        "camera_info_topic", "/camera/color/camera_info");
    const std::string target_frame = request.get<std::string>("target_frame", "base_link");
    const uint32_t max_width = static_cast<uint32_t>(request.get<int>("max_width", 320));
    const uint32_t max_height = static_cast<uint32_t>(request.get<int>("max_height", 240));
    const double max_fps = request.get<double>("max_fps", 12.0);
    for (const auto &name : {rgb_topic, depth_topic, info_topic, target_frame}) {
      if (!easy_debug_bridge::is_valid_graph_name(name) && name != target_frame) {
        // target_frame is a TF frame id, may be relative; allow non-absolute for TF names
      }
      if ((name == rgb_topic || name == depth_topic || name == info_topic) &&
          !easy_debug_bridge::is_valid_graph_name(name)) {
        session->send(error_message(request_id, "无效的 RGBD Topic 名称"));
        return;
      }
    }
    if (target_frame.empty()) {
      session->send(error_message(request_id, "target_frame 不能为空"));
      return;
    }
    if (max_width == 0 || max_height == 0 || !(max_fps > 0.0) || !std::isfinite(max_fps)) {
      session->send(error_message(request_id, "RGBD 预览宽高或帧率无效"));
      return;
    }

    auto rgbd = std::make_shared<RgbdSession>();
    rgbd->client_id = session->id();
    rgbd->rgb_topic = rgb_topic;
    rgbd->depth_topic = depth_topic;
    rgbd->camera_info_topic = info_topic;
    rgbd->target_frame = target_frame;
    rgbd->max_width = max_width;
    rgbd->max_height = max_height;
    rgbd->max_fps = max_fps;

    // Own ROS subscriptions — never touch ImageInterests / shared image map.
    auto qos = compatible_qos(rgb_topic);
    const uint64_t client = session->id();
    rgbd->rgb_sub = create_subscription<sensor_msgs::msg::Image>(
        rgb_topic, qos,
        [this, client](const sensor_msgs::msg::Image::SharedPtr message) {
          on_rgbd_rgb(client, message);
        });
    rgbd->depth_sub = create_subscription<sensor_msgs::msg::Image>(
        depth_topic, qos,
        [this, client](const sensor_msgs::msg::Image::SharedPtr message) {
          on_rgbd_depth(client, message);
        });
    rgbd->info_sub = create_subscription<sensor_msgs::msg::CameraInfo>(
        info_topic, qos,
        [this, client](const sensor_msgs::msg::CameraInfo::SharedPtr message) {
          on_rgbd_info(client, message);
        });

    {
      std::lock_guard<std::mutex> lock(rgbd_mutex_);
      rgbd_sessions_[client] = rgbd;
    }
    session->send("{\"op\":\"subscribed_rgbd\",\"request_id\":" + json_quote(request_id) +
                  ",\"rgb_topic\":" + json_quote(rgb_topic) +
                  ",\"depth_topic\":" + json_quote(depth_topic) +
                  ",\"camera_info_topic\":" + json_quote(info_topic) +
                  ",\"target_frame\":" + json_quote(target_frame) + "}");
  }

  std::shared_ptr<RgbdSession> get_rgbd(uint64_t client) {
    std::lock_guard<std::mutex> lock(rgbd_mutex_);
    const auto it = rgbd_sessions_.find(client);
    return it == rgbd_sessions_.end() ? nullptr : it->second;
  }

  void on_rgbd_rgb(uint64_t client, const sensor_msgs::msg::Image::SharedPtr &message) {
    auto session = get_rgbd(client);
    if (!session) return;
    {
      std::lock_guard<std::mutex> lock(session->mutex);
      session->latest_rgb = message;
    }
    try_emit_rgbd(client);
  }

  void on_rgbd_depth(uint64_t client, const sensor_msgs::msg::Image::SharedPtr &message) {
    auto session = get_rgbd(client);
    if (!session) return;
    {
      std::lock_guard<std::mutex> lock(session->mutex);
      session->latest_depth = message;
    }
    try_emit_rgbd(client);
  }

  void on_rgbd_info(uint64_t client, const sensor_msgs::msg::CameraInfo::SharedPtr &message) {
    auto session = get_rgbd(client);
    if (!session) return;
    {
      std::lock_guard<std::mutex> lock(session->mutex);
      session->latest_info = message;
    }
    try_emit_rgbd(client);
  }

  static std::string image_part_json(const easy_debug_bridge::DownsampledImage &image,
                                     const std_msgs::msg::Header &header,
                                     size_t data_offset) {
    return "{\"header\":" + header_json(header) +
           ",\"height\":" + std::to_string(image.height) +
           ",\"width\":" + std::to_string(image.width) +
           ",\"encoding\":" + json_quote(image.encoding) +
           ",\"is_bigendian\":" + std::to_string(image.is_bigendian) +
           ",\"step\":" + std::to_string(image.step) +
           ",\"data_length\":" + std::to_string(image.data.size()) +
           ",\"data_offset\":" + std::to_string(data_offset) + "}";
  }

  void send_rgbd_tf_failure(const std::shared_ptr<WebSocketSession> &ws,
                            const std::shared_ptr<RgbdSession> &session,
                            const std::string &source_frame,
                            const std::string &error) {
    std::ostringstream out;
    out << "{\"op\":\"rgbd_frame\",\"tf_ok\":false,\"tf_error\":" << json_quote(error)
        << ",\"source_frame\":" << json_quote(source_frame)
        << ",\"target_frame\":" << json_quote(session->target_frame)
        << ",\"rgb_topic\":" << json_quote(session->rgb_topic)
        << ",\"depth_topic\":" << json_quote(session->depth_topic)
        << ",\"camera_info_topic\":" << json_quote(session->camera_info_topic) << "}";
    ws->send(out.str());
  }

  void try_emit_rgbd(uint64_t client) {
    auto session = get_rgbd(client);
    if (!session) return;
    sensor_msgs::msg::Image::SharedPtr rgb;
    sensor_msgs::msg::Image::SharedPtr depth;
    sensor_msgs::msg::CameraInfo::SharedPtr info;
    {
      std::lock_guard<std::mutex> lock(session->mutex);
      rgb = session->latest_rgb;
      depth = session->latest_depth;
      info = session->latest_info;
    }
    if (!rgb || !depth || !info) return;
    if (!easy_debug_bridge::stamps_within_tolerance(
            rgb->header.stamp.sec, rgb->header.stamp.nanosec,
            depth->header.stamp.sec, depth->header.stamp.nanosec,
            session->stamp_tolerance_ns)) {
      return;
    }
    const auto now = std::chrono::steady_clock::now();
    const auto min_interval = std::chrono::duration<double>(1.0 / session->max_fps);
    if (session->last_sent.time_since_epoch().count() != 0 &&
        (now - session->last_sent) < min_interval) {
      return;
    }

    auto ws = find_session(client);
    if (!ws) return;

    const std::string source_frame = rgb->header.frame_id;
    geometry_msgs::msg::TransformStamped transform;
    try {
      transform = tf_buffer_->lookupTransform(
          session->target_frame, source_frame, rgb->header.stamp,
          tf2::durationFromSec(0.05));
    } catch (const tf2::TransformException &ex) {
      send_rgbd_tf_failure(ws, session, source_frame, ex.what());
      return;
    }

    if (rgb->width != depth->width || rgb->height != depth->height) {
      send_rgbd_tf_failure(ws, session, source_frame, "RGB 与 Depth 分辨率不一致");
      return;
    }

    const auto preview = easy_debug_bridge::choose_preview_size(
        rgb->width, rgb->height, session->max_width, session->max_height);
    auto rgb_ds = easy_debug_bridge::downsample_image_nn(
        rgb->data.data(), rgb->width, rgb->height, rgb->step, rgb->encoding, rgb->is_bigendian,
        preview.width, preview.height);
    auto depth_ds = easy_debug_bridge::downsample_image_nn(
        depth->data.data(), depth->width, depth->height, depth->step, depth->encoding,
        depth->is_bigendian, preview.width, preview.height);
    if (!rgb_ds || !depth_ds) {
      send_rgbd_tf_failure(ws, session, source_frame, "RGBD 降采样失败或不支持的编码");
      return;
    }

    double k_src[9];
    for (int i = 0; i < 9; ++i) k_src[i] = info->k[static_cast<size_t>(i)];
    const auto k = easy_debug_bridge::scale_intrinsics(
        k_src, rgb->width, rgb->height, preview.width, preview.height);
    const int64_t diff_ns = easy_debug_bridge::stamp_diff_ns(
        rgb->header.stamp.sec, rgb->header.stamp.nanosec,
        depth->header.stamp.sec, depth->header.stamp.nanosec);

    std::vector<uint8_t> payload;
    payload.reserve(rgb_ds->data.size() + depth_ds->data.size());
    payload.insert(payload.end(), rgb_ds->data.begin(), rgb_ds->data.end());
    const size_t depth_offset = payload.size();
    payload.insert(payload.end(), depth_ds->data.begin(), depth_ds->data.end());

    std::ostringstream meta;
    meta << "{\"op\":\"rgbd_frame\",\"tf_ok\":true"
         << ",\"rgb_topic\":" << json_quote(session->rgb_topic)
         << ",\"depth_topic\":" << json_quote(session->depth_topic)
         << ",\"camera_info_topic\":" << json_quote(session->camera_info_topic)
         << ",\"target_frame\":" << json_quote(session->target_frame)
         << ",\"source_frame\":" << json_quote(source_frame)
         << ",\"stamp_diff_ns\":" << diff_ns
         << ",\"rgb\":" << image_part_json(*rgb_ds, rgb->header, 0)
         << ",\"depth\":" << image_part_json(*depth_ds, depth->header, depth_offset)
         << ",\"camera_info\":{\"header\":" << header_json(info->header)
         << ",\"width\":" << preview.width
         << ",\"height\":" << preview.height
         << ",\"distortion_model\":" << json_quote(info->distortion_model)
         << ",\"d\":" << number_array(info->d)
         << ",\"k\":[" << k[0] << "," << k[1] << "," << k[2] << "," << k[3] << "," << k[4]
         << "," << k[5] << "," << k[6] << "," << k[7] << "," << k[8] << "]}"
         << ",\"pose\":{\"translation\":{\"x\":" << transform.transform.translation.x
         << ",\"y\":" << transform.transform.translation.y
         << ",\"z\":" << transform.transform.translation.z
         << "},\"rotation\":{\"x\":" << transform.transform.rotation.x
         << ",\"y\":" << transform.transform.rotation.y
         << ",\"z\":" << transform.transform.rotation.z
         << ",\"w\":" << transform.transform.rotation.w << "}}"
         << ",\"data_length\":" << payload.size() << "}";

    if (!ws->send_binary(easy_debug_bridge::binary_rgbd_frame(meta.str(), payload))) return;
    session->last_sent = now;
    // Drop consumed pair so a lone late frame cannot rematch with a stale sibling.
    {
      std::lock_guard<std::mutex> lock(session->mutex);
      if (session->latest_rgb == rgb) session->latest_rgb.reset();
      if (session->latest_depth == depth) session->latest_depth.reset();
    }
  }

  rclcpp::Publisher<trajectory_msgs::msg::JointTrajectory>::SharedPtr
  trajectory_publisher(const std::string &topic) {
    std::lock_guard<std::mutex> lock(trajectory_mutex_);
    auto &publisher = trajectory_publishers_[topic];
    if (!publisher) {
      publisher = create_publisher<trajectory_msgs::msg::JointTrajectory>(topic, rclcpp::QoS(10));
    }
    return publisher;
  }

  int port_;
  std::string command_topic_;
  std::string status_topic_;
  std::string joint_state_topic_;
  std::mutex session_mutex_;
  std::vector<std::weak_ptr<WebSocketSession>> sessions_;
  std::mutex subscription_mutex_;
  rclcpp::TimerBase::SharedPtr image_cleanup_timer_;
  easy_debug_bridge::ImageInterests image_interests_;
  std::unordered_map<std::string, rclcpp::SubscriptionBase::SharedPtr> subscriptions_;
  std::unordered_map<std::string, std::string> subscription_types_;
  std::mutex rgbd_mutex_;
  std::unordered_map<uint64_t, std::shared_ptr<RgbdSession>> rgbd_sessions_;
  std::shared_ptr<tf2_ros::Buffer> tf_buffer_;
  std::shared_ptr<tf2_ros::TransformListener> tf_listener_;
  rclcpp::Publisher<microros_stm32h723_bridge::msg::JointCommand>::SharedPtr command_publisher_;
  std::mutex trajectory_mutex_;
  std::unordered_map<std::string, rclcpp::Publisher<trajectory_msgs::msg::JointTrajectory>::SharedPtr>
      trajectory_publishers_;
  rclcpp::Subscription<microros_stm32h723_bridge::msg::HardwareStatus>::SharedPtr
      safety_status_subscription_;
  rclcpp::Subscription<sensor_msgs::msg::JointState>::SharedPtr safety_joint_subscription_;
  std::mutex control_mutex_;
  microros_stm32h723_bridge::msg::HardwareStatus latest_status_;
  sensor_msgs::msg::JointState latest_joint_state_;
  bool have_status_{false};
  bool have_joint_state_{false};
  uint32_t sequence_{0};
  std::chrono::steady_clock::time_point status_received_at_{};
  std::chrono::steady_clock::time_point joint_received_at_{};
#if defined(EASY_DEBUG_BRIDGE_HAS_GRAVITY_ID) && EASY_DEBUG_BRIDGE_HAS_GRAVITY_ID
  rclcpp_action::Client<microros_stm32h723_bridge::action::GravityIdentification>::SharedPtr
      gravity_id_client_;
  std::shared_ptr<rclcpp_action::ClientGoalHandle<
      microros_stm32h723_bridge::action::GravityIdentification>> gravity_id_goal_handle_;
#endif
  std::mutex gravity_id_mutex_;
  std::string gravity_id_status_{"idle"};
  std::chrono::steady_clock::time_point gravity_id_last_feedback_at_{};
};

void WebSocketSession::run() {
  beast::error_code error;
  socket_.set_option(websocket::stream_base::timeout::suggested(beast::role_type::server));
  socket_.accept(error);
  if (error) return;
  open_.store(true);
  bridge_->add_session(shared_from_this());
  while (open_.load() && rclcpp::ok()) {
    beast::flat_buffer buffer;
    socket_.read(buffer, error);
    if (error) break;
    bridge_->handle(shared_from_this(), beast::buffers_to_string(buffer.data()));
  }
  open_.store(false);
  bridge_->remove_session(id());
}

class WebSocketServer {
 public:
  explicit WebSocketServer(std::shared_ptr<BridgeNode> bridge)
      : bridge_(std::move(bridge)), context_(1),
        acceptor_(context_, tcp::endpoint(asio::ip::make_address("127.0.0.1"), bridge_->port())) {
    acceptor_.non_blocking(true);
  }

  void start() {
    thread_ = std::thread([this] {
      RCLCPP_INFO(bridge_->get_logger(), "WebSocket listening on 127.0.0.1:%d", bridge_->port());
      while (rclcpp::ok()) {
        beast::error_code error;
        tcp::socket socket(context_);
        acceptor_.accept(socket, error);
        if (error == asio::error::would_block || error == asio::error::try_again) {
          std::this_thread::sleep_for(std::chrono::milliseconds(50));
          continue;
        }
        if (error) continue;
        auto session = std::make_shared<WebSocketSession>(std::move(socket), bridge_);
        std::thread([session] { session->run(); }).detach();
      }
    });
  }

  ~WebSocketServer() {
    beast::error_code error;
    acceptor_.close(error);
    if (thread_.joinable()) thread_.join();
  }

 private:
  std::shared_ptr<BridgeNode> bridge_;
  asio::io_context context_;
  tcp::acceptor acceptor_;
  std::thread thread_;
};

int main(int argc, char **argv) {
  rclcpp::init(argc, argv);
  auto node = std::make_shared<BridgeNode>();
  WebSocketServer server(node);
  server.start();
  rclcpp::executors::MultiThreadedExecutor executor;
  executor.add_node(node);
  executor.spin();
  rclcpp::shutdown();
  return 0;
}
