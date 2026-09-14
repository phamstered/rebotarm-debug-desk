#include <ament_index_cpp/get_package_share_directory.hpp>
#include <boost/asio.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/websocket.hpp>
#include <boost/property_tree/json_parser.hpp>
#include <boost/property_tree/ptree.hpp>
#include <microros_stm32h723_bridge/msg/hardware_status.hpp>
#include <microros_stm32h723_bridge/msg/joint_command.hpp>
#include <rclcpp/rclcpp.hpp>
#include <rmw/types.h>
#include <sensor_msgs/msg/joint_state.hpp>
#include <std_msgs/msg/bool.hpp>
#include <std_msgs/msg/float32.hpp>
#include <std_msgs/msg/float32_multi_array.hpp>
#include <std_msgs/msg/float64.hpp>
#include <std_msgs/msg/float64_multi_array.hpp>
#include <std_msgs/msg/int32.hpp>
#include <std_msgs/msg/string.hpp>
#include <std_msgs/msg/u_int32.hpp>
#include "easy_debug_bridge/bridge_core.hpp"

#include <algorithm>
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
    out << std::setprecision(15) << values[index];
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

static std::string base64_encode(const std::vector<unsigned char> &data) {
  static constexpr char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string result;
  result.reserve(((data.size() + 2) / 3) * 4);
  for (size_t i = 0; i < data.size(); i += 3) {
    const uint32_t value = (static_cast<uint32_t>(data[i]) << 16) |
                           (i + 1 < data.size() ? static_cast<uint32_t>(data[i + 1]) << 8 : 0) |
                           (i + 2 < data.size() ? static_cast<uint32_t>(data[i + 2]) : 0);
    result.push_back(alphabet[(value >> 18) & 0x3f]);
    result.push_back(alphabet[(value >> 12) & 0x3f]);
    result.push_back(i + 1 < data.size() ? alphabet[(value >> 6) & 0x3f] : '=');
    result.push_back(i + 2 < data.size() ? alphabet[value & 0x3f] : '=');
  }
  return result;
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

  bool send(const std::string &payload) {
    std::lock_guard<std::mutex> lock(write_mutex_);
    if (!open_.load()) return false;
    beast::error_code error;
    socket_.text(true);
    socket_.write(asio::buffer(payload), error);
    if (error) open_.store(false);
    return !error;
  }

 private:
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
        session->send("{\"op\":\"hello\",\"bridge_version\":\"0.1.0\",\"ros_distro\":\"humble\"}");
      } else if (op == "topics") {
        send_topics(session, request_id);
      } else if (op == "graph") {
        send_graph(session, request_id);
      } else if (op == "subscribe") {
        subscribe(session, request.get<std::string>("topic", ""),
                  request.get<std::string>("type", ""), request_id);
      } else if (op == "resource") {
        send_resource(session, request.get<std::string>("uri", ""), request_id);
      } else if (op == "joint_command") {
        publish_joint_command(session, request, request_id);
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
    {
      std::lock_guard<std::mutex> lock(subscription_mutex_);
      if (subscriptions_.count(topic)) {
        session->send("{\"op\":\"subscribed\",\"request_id\":" + json_quote(request_id) +
                      ",\"topic\":" + json_quote(topic) + "}");
        return;
      }
      if (type == "std_msgs/msg/String") {
        create_typed_subscription<std_msgs::msg::String>(topic,
          [](const auto &m) { return json_quote(m.data); });
      } else if (type == "std_msgs/msg/Float64") {
        create_typed_subscription<std_msgs::msg::Float64>(topic,
          [](const auto &m) { return std::to_string(m.data); });
      } else if (type == "std_msgs/msg/Float32") {
        create_typed_subscription<std_msgs::msg::Float32>(topic,
          [](const auto &m) { return std::to_string(m.data); });
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
        session->send(error_message(request_id, "第一版暂不支持消息内容类型：" + type));
        return;
      }
    }
    session->send("{\"op\":\"subscribed\",\"request_id\":" + json_quote(request_id) +
                  ",\"topic\":" + json_quote(topic) + "}");
  }

  void send_resource(const std::shared_ptr<WebSocketSession> &session, const std::string &uri,
                     const std::string &request_id) {
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
      const auto path = std::filesystem::canonical(root / remainder.substr(slash + 1));
      const auto root_text = root.native();
      const auto path_text = path.native();
      if (path_text.compare(0, root_text.size(), root_text) != 0 ||
          (path_text.size() > root_text.size() && path_text[root_text.size()] != '/')) {
        session->send(error_message(request_id, "资源路径越过 package 目录"));
        return;
      }
      std::ifstream file(path, std::ios::binary);
      std::vector<unsigned char> bytes((std::istreambuf_iterator<char>(file)), {});
      session->send("{\"op\":\"resource\",\"request_id\":" + json_quote(request_id) +
                    ",\"uri\":" + json_quote(uri) + ",\"mime\":" + json_quote(mime_for(path)) +
                    ",\"base64\":" + json_quote(base64_encode(bytes)) + "}");
    } catch (const std::exception &error) {
      session->send(error_message(request_id, std::string("资源读取失败：") + error.what()));
    }
  }

  void publish_joint_command(const std::shared_ptr<WebSocketSession> &session,
                             const boost::property_tree::ptree &request,
                             const std::string &request_id) {
    const int mode_value = request.get<int>("mode", -1);
    const double position = request.get<double>("position", 0.0);
    const double velocity = request.get<double>("velocity", 0.0);
    const double kp = request.get<double>("kp", 0.0);
    const double kd = request.get<double>("kd", 0.0);
    const double effort = request.get<double>("effort", 0.0);
    const bool disable = mode_value == microros_stm32h723_bridge::msg::JointCommand::MODE_DISABLE;

    const easy_debug_bridge::CommandFields fields{
        mode_value, position, velocity, kp, kd, effort,
        request.get<std::string>("confirmation", "")};
    switch (easy_debug_bridge::validate_command(fields)) {
      case easy_debug_bridge::CommandValidation::InvalidMode:
        session->send(error_message(request_id, "无效的 JointCommand.mode")); return;
      case easy_debug_bridge::CommandValidation::NotArmed:
        session->send(error_message(request_id, "控制面板尚未解锁")); return;
      case easy_debug_bridge::CommandValidation::NonFinite:
        session->send(error_message(request_id, "控制指令包含非有限数值")); return;
      case easy_debug_bridge::CommandValidation::EffortLimit:
        session->send(error_message(request_id, "超过安全限幅：|effort|≤1")); return;
      case easy_debug_bridge::CommandValidation::Ok:
        break;
    }
    if (command_publisher_->get_subscription_count() == 0) {
      session->send(error_message(request_id, "STM32 command subscriber 不可用"));
      return;
    }

    microros_stm32h723_bridge::msg::JointCommand command;
    std::vector<uint32_t> sequences;
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
        if ((latest_status_.active_joint_mask & 0x01U) == 0) {
          session->send(error_message(request_id, "joint1 未处于 active_joint_mask"));
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
      command.position[0] = static_cast<float>(position);
      command.velocity[0] = static_cast<float>(velocity);
      command.kp[0] = static_cast<float>(kp);
      command.kd[0] = static_cast<float>(kd);
      command.effort[0] = static_cast<float>(effort);
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

  int port_;
  std::string command_topic_;
  std::string status_topic_;
  std::string joint_state_topic_;
  std::mutex session_mutex_;
  std::vector<std::weak_ptr<WebSocketSession>> sessions_;
  std::mutex subscription_mutex_;
  std::unordered_map<std::string, rclcpp::SubscriptionBase::SharedPtr> subscriptions_;
  rclcpp::Publisher<microros_stm32h723_bridge::msg::JointCommand>::SharedPtr command_publisher_;
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
