#include "easy_debug_bridge/position_motion.hpp"
#include "easy_debug_bridge/position_motion_model.hpp"
#include "easy_debug_bridge/position_motion_core.hpp"
#include "easy_debug_bridge/controller_feedback_core.hpp"
#include "easy_debug_bridge/motion_timing.hpp"
#include "easy_debug_bridge/motion_plan_diagnostics.hpp"
#include "easy_debug_bridge/motion_arrival.hpp"
#include "easy_debug_bridge/group_hold_core.hpp"
#include "easy_debug_bridge/position_group_parser.hpp"
#include "easy_debug_bridge/tcp_pose_model.hpp"
#include <shape_msgs/msg/solid_primitive.hpp>
#include <rclcpp_action/rclcpp_action.hpp>
#include <rclcpp/parameter_client.hpp>
#include <moveit_msgs/action/move_group.hpp>
#include <moveit_msgs/action/execute_trajectory.hpp>
#include "easy_debug_bridge/controller_registry.hpp"
#include <control_msgs/msg/joint_trajectory_controller_state.hpp>
#include <sensor_msgs/msg/joint_state.hpp>
#include <sensor_msgs/msg/image.hpp>
#include <filesystem>
#include <fstream>
#include <thread>
#include <microros_stm32h723_bridge/msg/hardware_status.hpp>
#include <deque>
#include <mutex>
#include <set>
#include <atomic>
#include <optional>
#include "easy_debug_bridge/motion_log.hpp"
#include "easy_debug_bridge/controller_health.hpp"
#include "easy_debug_bridge/clock_sync_core.hpp"
#include <std_msgs/msg/u_int32_multi_array.hpp>

namespace easy_debug_bridge {
namespace {
using Clock = std::chrono::steady_clock;
using Group = moveit_msgs::action::MoveGroup;
using Handle = rclcpp_action::ClientGoalHandle<Group>;
using Execute = moveit_msgs::action::ExecuteTrajectory;
using ExecuteHandle = rclcpp_action::ClientGoalHandle<Execute>;
using Joints = sensor_msgs::msg::JointState;
using State = control_msgs::msg::JointTrajectoryControllerState;
using Hardware = microros_stm32h723_bridge::msg::HardwareStatus;
using Tree = boost::property_tree::ptree;
const std::string controller = "arm_trajectory_controller";
const std::string gripper_controller = "gripper_trajectory_controller";
std::string quote(const std::string &value) { return position_json_quote(value); }
std::string capture_names(const std::vector<std::string> &names) {
  std::string result = "[";
  for (size_t i = 0; i < names.size(); ++i) { if (i) result += ','; result += quote(names[i]); }
  return result + ']';
}
std::string numbers(const std::vector<double> &values) {
  std::ostringstream out; out << '[' << std::setprecision(17);
  for (size_t i = 0; i < values.size(); ++i) { if (i) out << ','; out << values[i]; }
  return out.str() + ']';
}
bool fresh(Clock::time_point at, double seconds = 1.0) {
  return at != Clock::time_point{} && std::chrono::duration<double>(Clock::now() - at).count() < seconds;
}
TcpPose read_tcp_pose(const Tree &request) {
  const auto &field = request.get_child("tcp_pose");
  if (!field.data().empty()) throw std::runtime_error("tcp_pose 必须是完整位姿对象");
  std::set<std::string> fields;
  for (const auto &item : field) {
    if (!fields.insert(item.first).second || (item.first != "frame_id" && item.first != "tcp_link" && item.first != "position" && item.first != "orientation"))
      throw std::runtime_error("tcp_pose 字段无效或重复");
  }
  if (fields.size() != 4) throw std::runtime_error("tcp_pose 缺少坐标系、TCP link 或位姿字段");
  TcpPose pose;
  auto read_array = [&](const std::string &key, auto &out) {
    const auto &array = field.get_child(key);
    if (!array.data().empty() || array.size() != out.size()) throw std::runtime_error("TCP 位姿数组长度无效");
    size_t index = 0;
    for (const auto &item : array) {
      if (!item.first.empty() || !item.second.empty()) throw std::runtime_error("TCP 位姿必须使用数值数组");
      out[index++] = item.second.get_value<double>();
    }
  };
  read_array("position", pose.position); read_array("orientation", pose.orientation);
  return validate_tcp_pose(pose);
}
std::vector<double> read_values(const Tree &request) {
  std::vector<double> values;
  if (const auto field = request.get_child_optional("positions"))
    for (const auto &v : *field) values.push_back(v.second.get_value<double>());
  return values;
}
}

struct PositionMotion::Impl {
  struct Request { uint64_t owner; Tree data; Send send; bool disconnect{false}; };
  struct GroupRun {
    PositionGroupSpec spec;
    PositionGroupTimeline timeline;
    std::string model_signature;
    uint64_t clock_generation{};
    bool done{false}, failed{false};
    std::string last_capture;
  };
  struct CaptureJob {
    std::atomic<bool> canceled{false}, started{false}, done{false};
    std::mutex mutex;
    std::string result, error;
  };
  struct Motion {
    uint64_t owner{}; std::string id, label, phase{"validating"}, message;
    uint64_t clock_generation{};
    std::vector<double> target; PositionMotionModel model;
    std::vector<double> velocity_limits, acceleration_limits;
    bool gripper{false}, plan_only{false}, tcp{false}; TcpPoseModel tcp_model; TcpPose tcp_target;
    GripperCalibration calibration; Send send; Handle::SharedPtr handle;
    ExecuteHandle::SharedPtr execution_handle;
    std::vector<size_t> held_axes;
    double duration{0}, recommended_duration{0};
    std::string validation_stage;
    Clock::time_point started{Clock::now()}, lease_at{Clock::now()}, result_at{}, settled_at{}, cancel_at{};
    bool cancel_requested{false}, terminal{false}, no_motion{false};
    int code{0}; bool failed_result{false}, planning_finished{false};
    std::shared_ptr<GroupRun> group;
    std::vector<double> hold_reference;
    std::optional<std::vector<MotionArrivalError>> arrival_errors;
    GroupHoldRecovery hold_recovery;
    std::optional<GroupHoldFailure> hold_failure;
    size_t capture_index{};
    Clock::time_point capture_started{};
    rclcpp::Subscription<sensor_msgs::msg::Image>::SharedPtr capture_sub;
    std::shared_ptr<CaptureJob> capture_job;
  };
  rclcpp::Node &node;
  rclcpp::CallbackGroup::SharedPtr callback_group;
  std::mutex queue_mutex; std::deque<Request> requests;
  std::atomic<bool> in_motion{false};
  rclcpp_action::Client<Group>::SharedPtr action;
  rclcpp_action::Client<Execute>::SharedPtr execute_action;
  double start_tolerance{.01};
  std::vector<double> velocity_limits, acceleration_limits;
  std::shared_ptr<ControllerRegistry> controller_registry;
  std::shared_ptr<rclcpp::AsyncParametersClient> parameters;
  rclcpp::Subscription<Joints>::SharedPtr joints_sub, broadcaster_sub;
  rclcpp::Subscription<State>::SharedPtr state_sub, gripper_state_sub;
  rclcpp::Subscription<Hardware>::SharedPtr hardware_sub;
  rclcpp::Subscription<std_msgs::msg::UInt32MultiArray>::SharedPtr clock_diagnostics_sub;
  ClockSyncMonitor clock_monitor;
  FirmwareClockMonitor firmware_clock;
  rclcpp::TimerBase::SharedPtr timer;
  Joints joints, broadcaster_joints;
  Clock::time_point broadcaster_at{};
  State state, gripper_state; Hardware hardware;
  Clock::time_point gripper_state_at{};
  bool gripper_controller_active{false}, gripper_supported{false};
  std::string gripper_error{"等待夹爪模型"};
  GripperCalibration gripper_calibration;
  double gripper_velocity_limit{}, gripper_acceleration_limit{};
  Clock::time_point joints_at{}, state_at{}, hardware_at{}, controller_at{}, model_at{}, model_request_at{};
  bool controller_active{false}, model_pending{false}, controller_slow{false};
  uint64_t controller_sequence{0}, model_generation{0};
  std::string model_error{"等待 MoveIt 模型"}, model_signature, model_urdf;
  std::string controller_error{"arm_trajectory_controller 未激活或状态已过期"};
  MotionLog logs;
  std::string health_reason;
  std::string controller_health_reason;
  const std::string log_session = std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
  PositionMotionModel model;
  std::shared_ptr<Motion> current;
  std::deque<std::pair<std::string, uint64_t>> seen;

  Impl(rclcpp::Node &n, const std::string &joint_topic, const std::string &status_topic, std::shared_ptr<ControllerRegistry> registry)
      : node(n), controller_registry(std::move(registry)) {
    callback_group = controller_registry->callback_group();
    action = rclcpp_action::create_client<Group>(node.get_node_base_interface(), node.get_node_graph_interface(),
        node.get_node_logging_interface(), node.get_node_waitables_interface(), "/move_action", callback_group);
    execute_action = rclcpp_action::create_client<Execute>(node.get_node_base_interface(), node.get_node_graph_interface(),
        node.get_node_logging_interface(), node.get_node_waitables_interface(), "/execute_trajectory", callback_group);
    parameters = std::make_shared<rclcpp::AsyncParametersClient>(&node, "/move_group", rmw_qos_profile_parameters, callback_group);
    const auto qos = rclcpp::QoS(10).best_effort();
    rclcpp::SubscriptionOptions options; options.callback_group = callback_group;
    joints_sub = node.create_subscription<Joints>(joint_topic, qos, [this](Joints::ConstSharedPtr m) {
      joints = *m; joints_at = Clock::now();
      clock_monitor.observe(m->header.stamp.sec, m->header.stamp.nanosec, node.now().nanoseconds(), joints_at);
    }, options);
    // Compare controller-exported feedback with controller-exported feedback.
    // Raw STM32 input remains the independent clock/stop/arrival source below.
    broadcaster_sub = node.create_subscription<Joints>("/joint_states", qos, [this](Joints::ConstSharedPtr m) {
      // Duplicate source frames cannot keep an old snapshot fresh indefinitely.
      const bool repeated = m->header.stamp == broadcaster_joints.header.stamp;
      broadcaster_joints = *m;
      if (!repeated) broadcaster_at = Clock::now();
    }, options);
    clock_diagnostics_sub = node.create_subscription<std_msgs::msg::UInt32MultiArray>(
        "/stm32/microros_diagnostics", qos, [this](std_msgs::msg::UInt32MultiArray::ConstSharedPtr m) {
          if (firmware_clock.observe(m->data, Clock::now())) clock_monitor.new_epoch();
        }, options);
    hardware_sub = node.create_subscription<Hardware>(status_topic, qos, [this](Hardware::ConstSharedPtr m) { hardware = *m; hardware_at = Clock::now(); }, options);
    state_sub = node.create_subscription<State>("/" + controller + "/controller_state", qos, [this](State::ConstSharedPtr m) { state = *m; state_at = Clock::now(); }, options);
    gripper_state_sub = node.create_subscription<State>("/" + gripper_controller + "/controller_state", qos, [this](State::ConstSharedPtr m) { gripper_state = *m; gripper_state_at = Clock::now(); }, options);
    timer = node.create_wall_timer(std::chrono::milliseconds(100), [this] { tick(); }, callback_group);
  }
  ~Impl() { if (current && current->capture_job) current->capture_job->canceled.store(true); }
  std::string event(const Motion &m) const {
    std::string group_fields;
    if (m.group) {
      auto timeline = m.group->timeline;
      if (!m.group->done) timeline.advance(steady_seconds());
      group_fields = ",\"group_id\":" + quote(m.group->spec.id) + ",\"group_index\":" + std::to_string(timeline.index) +
          ",\"group_count\":" + std::to_string(m.group->spec.steps.size()) + ",\"group_phase\":" + quote(timeline.phase) +
          ",\"group_elapsed_s\":" + std::to_string(timeline.elapsed_s) +
          ",\"group_step_label\":" + quote(m.group->spec.steps.at(timeline.index).label);
    }
    return "{\"op\":\"position_motion\",\"command_id\":" + quote(m.id) + ",\"label\":" + quote(m.label) +
        ",\"motion_phase\":" + quote(m.phase) + ",\"message\":" + quote(m.message) + ",\"code\":" + std::to_string(m.code) +
        ",\"position_error_check_enforced\":false" + (m.arrival_errors ? ",\"arrival_errors\":" + motion_arrival_json(*m.arrival_errors) : "") +
        (m.hold_failure ? ",\"hold_failure\":" + group_hold_failure_json(*m.hold_failure) : "") +
        ",\"recommended_duration_s\":" + std::to_string(m.recommended_duration) + ",\"elapsed_s\":" + std::to_string(std::chrono::duration<double>(Clock::now()-m.started).count()) + group_fields + (m.group && !m.group->last_capture.empty() ? ",\"capture_result\":" + m.group->last_capture : "") + "}";
  }
  static double steady_seconds() { return std::chrono::duration<double>(Clock::now().time_since_epoch()).count(); }
  static bool at_group_boundary(const std::shared_ptr<Motion> &m) { return m->group && !m->hold_reference.empty(); }
  void log(uint64_t owner, const std::string &id, const std::string &phase, const std::string &message, const std::string &level = "info") {
    logs.append(owner, id, phase, message, level);
    RCLCPP_INFO(node.get_logger(), "[motion][%s][%s][%s] %s", level.c_str(), id.c_str(), phase.c_str(), message.c_str());
  }
  void update(const std::shared_ptr<Motion> &m, const std::string &phase, const std::string &message, bool terminal = false) {
    // Capture only at a transition using fresh, valid source feedback. Terminal
    // events replay this checked snapshot, never later samples from another pose.
    m->arrival_errors.reset();
    if ((m->result_at != Clock::time_point{} || phase == "stop_failed") && fresh(joints_at) && clock_snapshot().healthy() &&
        (m->result_at == Clock::time_point{} || joints_at >= m->result_at)) {
      try { m->arrival_errors = motion_arrival_errors(m->model.joint_names, m->target,
          measured(m->model, false, &m->calibration), measured(m->model, true, &m->calibration)); } catch (...) {}
    }
    const auto detail = phase == "stop_failed" && !m->arrival_errors ? message + "；当前无新鲜有效反馈，未提供误差快照" : message;
    if (m->phase != phase || m->message != detail)
      log(m->owner, m->id, phase, m->label + " · " + detail, phase == "failed" || phase == "stop_failed" ? "error" : phase == "canceling" ? "warn" : "info");
    m->phase = phase; m->message = detail; m->terminal = terminal;
    if (terminal && m->group) { m->group->timeline.advance(steady_seconds()); m->group->done = true; }
    m->send(event(*m));
    if (terminal && current == m) in_motion.store(false);
  }
  void error(const Request &r, const std::string &message) {
    r.send("{\"op\":\"error\",\"request_id\":" + quote(r.data.get<std::string>("request_id", "")) + ",\"message\":" + quote(message) + "}");
  }
  void poll_controllers() {
    const auto snapshot = controller_registry->snapshot();
    if (!snapshot.fresh) {
      controller_active = false; gripper_controller_active = false; controller_at = {};
      controller_error = snapshot.message.empty() ? "等待 ControllerManager 有效快照" : snapshot.message;
      return;
    }
    if (snapshot.sequence == controller_sequence) return;
    controller_sequence = snapshot.sequence;
    controller_active = false; gripper_controller_active = false;
    controller_error = "arm_trajectory_controller 未激活、缺失或类型不匹配";
    bool gripper_conflict = false;
    size_t gripper_count = 0;
    for (const auto &c : snapshot.controllers) {
      if (c.name == gripper_controller && c.state == "active" && c.type_name == "joint_trajectory_controller/JointTrajectoryController") {
        ++gripper_count;
        gripper_controller_active = same_motion_joints(c.claimed_interfaces,
            {gripper_motion_joint() + "/position", gripper_motion_joint() + "/velocity"});
      } else if (c.state == "active") {
        for (const auto &claim : c.claimed_interfaces)
          if (claim.rfind(gripper_motion_joint() + "/", 0) == 0) gripper_conflict = true;
      }
      if (c.name != controller || c.state != "active" || c.type_name != "joint_trajectory_controller/JointTrajectoryController") continue;
      if (!arm_position_velocity_claimed(c.claimed_interfaces))
        controller_error = "轨迹控制器必须认领六关节 position+velocity 接口，请更新控制栈并重新启用轨迹控制";
      else { controller_active = true; controller_error.clear(); }
    }
    gripper_controller_active = gripper_controller_active && !gripper_conflict && gripper_count == 1;
    controller_at = snapshot.received_at;
    const bool slow = snapshot.latency_s > .8;
    if (slow != controller_slow) {
      log(0, "", "controller", slow ? "ListControllers 响应较慢（" + std::to_string(snapshot.latency_s) + " s），保持单请求轮询"
          : "ListControllers 响应耗时已恢复正常", slow ? "warn" : "info");
      controller_slow = slow;
    }
  }
  std::vector<std::string> model_keys() {
    std::vector<std::string> keys{"robot_description", "robot_description_semantic", "moveit_manage_controllers",
        "moveit_simple_controller_manager.controller_names", "moveit_simple_controller_manager." + controller + ".joints",
        "trajectory_execution.allowed_start_tolerance", "moveit_controller_manager",
        "moveit_simple_controller_manager." + controller + ".type",
        "moveit_simple_controller_manager." + controller + ".action_ns"};
    for (const auto &j : arm_motion_joints()) {
      keys.push_back("robot_description_planning.joint_limits." + j + ".max_velocity");
      keys.push_back("robot_description_planning.joint_limits." + j + ".max_acceleration");
      keys.push_back("robot_description_planning.joint_limits." + j + ".has_velocity_limits");
      keys.push_back("robot_description_planning.joint_limits." + j + ".has_acceleration_limits");
    }
    for (const auto &suffix : {"joints", "type", "action_ns"})
      keys.push_back("moveit_simple_controller_manager." + gripper_controller + "." + suffix);
    for (const auto &suffix : {"gripper_position_scale", "gripper_position_offset", "gripper_lower", "gripper_upper"})
      keys.push_back("debug_desk." + std::string(suffix));
    for (const auto &suffix : {"max_velocity", "max_acceleration", "has_velocity_limits", "has_acceleration_limits"})
      keys.push_back("robot_description_planning.joint_limits." + gripper_motion_joint() + "." + suffix);
    return keys;
  }
  void poll_model() {
    if (model_pending) {
      if (fresh(model_request_at, 3)) return;
      model_pending = false; model_error = "MoveIt 模型查询超时"; model_at = {};
      parameters = std::make_shared<rclcpp::AsyncParametersClient>(&node, "/move_group", rmw_qos_profile_parameters, callback_group);
    }
    if (!parameters->service_is_ready()) return;
    model_pending = true; model_request_at = Clock::now();
    const auto generation = ++model_generation;
    parameters->get_parameters(model_keys(), [this, generation](std::shared_future<std::vector<rclcpp::Parameter>> future) {
      if (generation != model_generation) return;
      model_pending = false;
      try {
        auto p = future.get();
        if (p.size() != 44 || p[2].as_bool()) throw std::runtime_error("MoveIt 必须配置 moveit_manage_controllers=false");
        const auto configured_controllers = p[3].as_string_array();
        const bool includes_gripper = same_motion_joints(configured_controllers, {controller, gripper_controller});
        if ((!includes_gripper && configured_controllers != std::vector<std::string>{controller}) || !arm_joint_set(p[4].as_string_array()))
          throw std::runtime_error("MoveIt 必须仅配置审核过的 arm/gripper 轨迹控制器");
        const auto configured_start_tolerance = p[5].as_double();
        if (!std::isfinite(configured_start_tolerance) || configured_start_tolerance <= 0 || configured_start_tolerance > 0.02)
          throw std::runtime_error("MoveIt 起点容差必须在 (0, 0.02] rad");
        if (p[6].as_string() != "moveit_simple_controller_manager/MoveItSimpleControllerManager"
            || p[7].as_string() != "FollowJointTrajectory" || p[8].as_string() != "follow_joint_trajectory")
          throw std::runtime_error("MoveIt 执行控制器 Action 配置不匹配");
        for (size_t i = 9; i < 33; i += 4) {
          const double velocity = p[i].as_double(), acceleration = p[i+1].as_double();
          validate_arm_planning_limits(velocity, acceleration, p[i+2].as_bool(), p[i+3].as_bool());
        }
        velocity_limits.clear(); acceleration_limits.clear();
        for (size_t i=9;i<33;i+=4) { velocity_limits.push_back(p[i].as_double()); acceleration_limits.push_back(p[i+1].as_double()); }
        auto parsed = position_motion_model(p[0].as_string(), p[1].as_string());
        gripper_supported = false; gripper_error = "当前 MoveIt 未配置夹爪轨迹控制";
        if (includes_gripper) try {
          if (p[33].as_string_array() != std::vector<std::string>{gripper_motion_joint()} ||
              p[34].as_string() != "FollowJointTrajectory" || p[35].as_string() != "follow_joint_trajectory")
            throw std::runtime_error("夹爪执行控制器 Action 配置不匹配");
          GripperCalibration calibration{p[36].as_double(), p[37].as_double(), p[38].as_double(), p[39].as_double()};
          validate_gripper_motion_model(p[0].as_string(), p[1].as_string(), calibration);
          const double v = p[40].as_double(), a = p[41].as_double();
          if (!p[42].as_bool() || !p[43].as_bool() || !std::isfinite(v) || v <= 0 || v > .02 || !std::isfinite(a) || a <= 0 || a > .04)
            throw std::runtime_error("夹爪须启用不超过 0.02 m/s、0.04 m/s² 的运动限幅");
          gripper_calibration = calibration; gripper_velocity_limit = v; gripper_acceleration_limit = a;
          gripper_supported = true; gripper_error.clear();
        } catch (const std::exception &e) { gripper_error = std::string("夹爪配置不可用：") + e.what(); }
        std::string signature;
        for (const auto &value : p) signature += value.value_to_string();
        if (current && !current->terminal && !model_signature.empty() && signature != model_signature) {
          if (current->group) current->group->failed = true;
          cancel(current, "MoveIt 模型或配置改变，已请求取消");
        }
        start_tolerance = configured_start_tolerance;
        model = std::move(parsed); model_signature = std::move(signature); model_urdf = p[0].as_string(); model_error.clear(); model_at = Clock::now();
      } catch (const std::exception &e) { model_error = std::string("MoveIt 配置不可用：") + e.what(); model_at = {}; }
    });
  }
  std::string controller_readiness() const {
    const auto latest = controller_registry->snapshot();
    if (!latest.fresh) return latest.message.empty() ? "等待 ControllerManager 有效快照" : latest.message;
    if (latest.sequence != controller_sequence) return "等待验证 ControllerManager 最新快照";
    if (!controller_active) return controller_error;
    if (!fresh(controller_at, ControllerHealthPoll::validity_seconds))
      return "arm_trajectory_controller 状态已过期（ListControllers >3.1s）";
    return "";
  }
  ClockSyncSnapshot clock_snapshot() const {
    const auto steady = Clock::now();
    auto snapshot = clock_monitor.snapshot(node.now().nanoseconds(), steady);
    firmware_clock.apply(snapshot, steady);
    return snapshot;
  }
  std::string broadcaster_readiness() const {
    if (!fresh(broadcaster_at)) return "JointState Broadcaster /joint_states 反馈缺失/已过期";
    const auto &stamp = broadcaster_joints.header.stamp;
    if (!broadcaster_stamp_fresh(stamp.sec, stamp.nanosec, node.now().nanoseconds()))
      return "JointState Broadcaster /joint_states 源时间戳无效/已过期";
    return "";
  }
  std::string readiness(bool starting = true) {
    poll_controllers();
    if (!action->action_server_is_ready()) return "MoveIt /move_action 未启动，请启动 real_move_group.launch.py";
    if (!fresh(model_at, 10) || !model_error.empty()) return model_error.empty() ? "MoveIt 模型信息已过期" : model_error;
    const auto controller_reason = controller_readiness();
    if (!controller_reason.empty()) return controller_reason;
    if (!fresh(joints_at) || !fresh(state_at) || !fresh(hardware_at)) return "JointState、控制器或硬件反馈缺失/已过期";
    const auto broadcaster_reason = broadcaster_readiness();
    if (!broadcaster_reason.empty()) return broadcaster_reason;
    const auto sync = clock_snapshot();
    if (!sync.healthy()) return sync.message;
    if (hardware.mode != Hardware::MODE_TRACK || hardware.fault_code != 0 || (hardware.active_joint_mask & 0x3f) != 0x3f) return "硬件未处于 TRACK、存在故障或六关节未全部使能";
    if (!arm_joint_set(state.joint_names)) return "轨迹控制器关节集合与 arm 不匹配";
    try {
      const auto actual = ordered_arm_values(joints.name, joints.position);
      const auto velocity = ordered_arm_values(joints.name, joints.velocity);
      validate_position_target(actual, model);
      const auto consistency = controller_feedback_consistency(arm_motion_joints(),
          broadcaster_joints.name, broadcaster_joints.position, state.joint_names, state.actual.positions, .02, "rad");
      if (!consistency.empty()) return consistency;
      for (size_t i = 0; i < 6; ++i) {
        if (starting && std::abs(velocity[i]) > 0.05) return "机械臂尚未停稳";
      }
    } catch (const std::exception &e) { return e.what(); }
    return "";
  }
  std::string gripper_readiness(bool starting = true) {
    poll_controllers();
    const auto registry_reason = controller_readiness(); if (!registry_reason.empty()) return registry_reason;
    if (!execute_action->action_server_is_ready()) return "MoveIt /execute_trajectory 未启动";
    if (!gripper_supported || !fresh(model_at, 10) || !model_error.empty()) return gripper_error.empty() ? "夹爪模型已过期" : gripper_error;
    if (!gripper_controller_active || !fresh(controller_at, ControllerHealthPoll::validity_seconds)) return "夹爪轨迹控制器未激活或未认领 position+velocity 接口";
    if (!fresh(gripper_state_at) || !fresh(joints_at) || !fresh(hardware_at)) return "夹爪反馈缺失或已过期";
    const auto broadcaster_reason = broadcaster_readiness();
    if (!broadcaster_reason.empty()) return broadcaster_reason;
    if (hardware.mode != Hardware::MODE_TRACK || hardware.fault_code != 0 || !(hardware.active_joint_mask & 0x40)) return "夹爪未使能、未处于 TRACK 或存在故障";
    try {
      if (gripper_state.joint_names != std::vector<std::string>{gripper_motion_joint()}) return "夹爪控制器关节集合不匹配";
      const auto actual = calibrated_gripper_value(joints.name, joints.position, gripper_calibration);
      const auto velocity = calibrated_gripper_value(joints.name, joints.velocity, gripper_calibration, true);
      const auto consistency = controller_feedback_consistency({gripper_motion_joint()},
          broadcaster_joints.name, broadcaster_joints.position, gripper_state.joint_names, gripper_state.actual.positions, .001, "m");
      if (!consistency.empty()) return consistency;
      const auto broadcast = ordered_motion_values({gripper_motion_joint()}, broadcaster_joints.name, broadcaster_joints.position).front();
      if (actual < gripper_calibration.lower - .001 || actual > gripper_calibration.upper + .001 ||
          broadcast < gripper_calibration.lower - .001 || broadcast > gripper_calibration.upper + .001)
        return "夹爪标定后的 STM32 或 JointState Broadcaster 反馈超出行程";
      if (starting && std::abs(velocity) > .001) return "夹爪尚未停稳";
    } catch (const std::exception &e) { return e.what(); }
    return "";
  }
  std::vector<double> measured(const PositionMotionModel &motion_model, bool velocity = false, const GripperCalibration *saved = nullptr) const {
    auto values = velocity ? joints.velocity : joints.position;
    if (std::find(motion_model.joint_names.begin(), motion_model.joint_names.end(), gripper_motion_joint()) != motion_model.joint_names.end()) {
      const auto converted = calibrated_gripper_value(joints.name, values, saved ? *saved : gripper_calibration, velocity);
      const auto found = std::find(joints.name.begin(), joints.name.end(), gripper_motion_joint());
      values[found - joints.name.begin()] = converted;
    }
    return ordered_motion_values(motion_model.joint_names, joints.name, values);
  }
  void request_cancel_handle(const std::shared_ptr<Motion> &m) {
    // rclcpp_action forgets completed goals. Canceling such a handle throws;
    // a terminal action can only be checked against fresh stop feedback.
    if (m->result_at != Clock::time_point{}) return;
    try {
      if (m->execution_handle) execute_action->async_cancel_goal(m->execution_handle);
      else if (m->handle) action->async_cancel_goal(m->handle);
    }
    catch (const std::exception &e) { update(m, "stop_failed", std::string("MoveIt 取消失败，停止未确认：") + e.what()); }
  }
  void cancel(const std::shared_ptr<Motion> &m, const std::string &message) {
    if (m->terminal || m->cancel_requested) return;
    m->cancel_requested = true; m->cancel_at = Clock::now();
    if (m->capture_job) m->capture_job->canceled.store(true);
    m->capture_sub.reset();
    m->settled_at = {};
    if (at_group_boundary(m)) m->result_at = Clock::now();
    update(m, "canceling", message);
    request_cancel_handle(m);
  }
  void move(const Request &r, const std::shared_ptr<GroupRun> &group = nullptr) {
    const auto id = r.data.get<std::string>("command_id", "");
    if (id.empty() || id.size() > 80 || id.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-") != std::string::npos)
      throw std::runtime_error("command_id 无效");
    if (r.data.get<std::string>("confirmation", "") != "ARMED") throw std::runtime_error("请先确认工作区安全并解锁点位执行");
    for (const auto &old : seen) if (!group && old.first == id) {
      if (current && !current->group && current->id == id && current->owner == r.owner) {
        r.send("{\"op\":\"position_move_ack\",\"accepted\":true,\"request_id\":" + quote(r.data.get<std::string>("request_id", "")) + ",\"command_id\":" + quote(id) + "}");
        r.send(event(*current)); return;
      }
      throw std::runtime_error("重复的运动 command_id，未重复执行");
    }
    if (current && !current->terminal && !group) throw std::runtime_error("已有点位运动，等待完成或取消确认后再试");
    if (group && (group->done || (current && current->group == group && current->cancel_requested)))
      throw std::runtime_error("动作组已取消或结束");
    if (group && (group->model_signature != model_signature || group->clock_generation != clock_snapshot().generation))
      throw std::runtime_error("动作组模型或时钟基准改变，禁止继续");
    const auto reason = readiness(); if (!reason.empty()) throw std::runtime_error(reason);
    const auto rotation_joint = r.data.get_optional<std::string>("joint_name");
    const auto joint_targets = r.data.get_child_optional("joint_targets");
    const auto pose_field = r.data.get_child_optional("tcp_pose");
    if (pose_field && (joint_targets || rotation_joint || r.data.get_child_optional("joint_position") ||
        r.data.get_child_optional("positions") || r.data.get_child_optional("home")))
      throw std::runtime_error("tcp_pose 不能与关节目标或 HOME 字段混用");
    TcpPose pose_target; TcpPoseModel pose_model;
    if (pose_field) {
      pose_target = read_tcp_pose(r.data);
      const auto frame = pose_field->get<std::string>("frame_id"), link = pose_field->get<std::string>("tcp_link");
      if (frame.empty() || link.empty()) throw std::runtime_error("TCP 坐标系与 link 不能为空");
      pose_model = parse_tcp_pose_model(model_urdf, link, frame);
    }
    std::optional<double> gripper_position;
    if (const auto field = r.data.get_child_optional("gripper_position")) {
      if (!field->empty() || field->data().empty()) throw std::runtime_error("gripper_position 必须为有限数值");
      // get_optional<T> hides conversion errors; a malformed gripper target must never disappear.
      gripper_position = r.data.get<double>("gripper_position");
      if (!std::isfinite(*gripper_position)) throw std::runtime_error("gripper_position 必须为有限数值");
    }
    if (gripper_position && (joint_targets || rotation_joint || r.data.get<bool>("home", false)))
      throw std::runtime_error("gripper_position 只能与六轴 positions 或 tcp_pose 一起指定");
    std::vector<std::pair<std::string, double>> edits;
    if (joint_targets) {
      if (!joint_targets->data().empty() || rotation_joint || r.data.get_child_optional("joint_position") ||
          r.data.get<bool>("home", false) || r.data.get_child_optional("positions"))
        throw std::runtime_error("joint_targets 必须为关节目标对象，不能与其他目标形式混用");
      for (const auto &entry : *joint_targets) edits.emplace_back(entry.first, entry.second.get_value<double>());
    }
    if (rotation_joint && (r.data.get<bool>("home", false) || r.data.get_child_optional("positions")))
      throw std::runtime_error("单关节旋转不能与 HOME/positions 同时指定");
    if (!rotation_joint && r.data.get_child_optional("joint_position"))
      throw std::runtime_error("单关节旋转缺少 joint_name");
    if (rotation_joint) edits.emplace_back(*rotation_joint, r.data.get<double>("joint_position"));
    const bool has_gripper = gripper_position || std::any_of(edits.begin(), edits.end(), [](const auto &e) { return e.first == gripper_motion_joint(); });
    const bool has_arm = !(joint_targets || rotation_joint) || std::any_of(edits.begin(), edits.end(), [](const auto &e) { return e.first != gripper_motion_joint(); });
    if (has_gripper) { const auto why = gripper_readiness(); if (!why.empty()) throw std::runtime_error(why); }
    const auto motion_model = has_gripper ? gripper_motion_model(model, gripper_calibration, has_arm) : model;
    const auto actual = measured(motion_model);
    auto target = pose_field ? actual : joint_targets || rotation_joint ? edited_motion_target(actual, edits, motion_model)
      : r.data.get<bool>("home", false) ? model.home : read_values(r.data);
    if (gripper_position) { if (pose_field) target.back() = *gripper_position; else target.push_back(*gripper_position); }
    double duration = 0;
    if (r.data.get_child_optional("motion_duration_s")) {
      duration = r.data.get<double>("motion_duration_s"); validate_motion_duration(duration);
      if (!execute_action->action_server_is_ready()) throw std::runtime_error("MoveIt /execute_trajectory 未启动");
    }
    validate_position_target(target, motion_model);
    auto m = std::make_shared<Motion>(); m->owner = r.owner; m->id = id;
    m->clock_generation = group ? group->clock_generation : clock_snapshot().generation;
    m->group = group;
    m->label = r.data.get<bool>("home", false) ? "HOME" : r.data.get<std::string>("label", "位置");
    if (m->label.size() > 512) throw std::runtime_error("点位名称过长");
    m->target = target; m->model = motion_model; m->gripper = has_gripper; m->calibration = gripper_calibration;
    m->velocity_limits = has_arm ? velocity_limits : std::vector<double>{};
    m->acceleration_limits = has_arm ? acceleration_limits : std::vector<double>{};
    if (has_gripper) { m->velocity_limits.push_back(gripper_velocity_limit); m->acceleration_limits.push_back(gripper_acceleration_limit); }
    m->send = r.send; m->duration = duration; m->plan_only = bool(group) || duration > 0 || has_gripper || bool(pose_field);
    m->tcp = bool(pose_field); m->tcp_model = std::move(pose_model); m->tcp_target = pose_target;
    if (m->plan_only && !execute_action->action_server_is_ready()) throw std::runtime_error("MoveIt /execute_trajectory 未启动");
    if (group && current && current->group == group) m->lease_at = current->lease_at;
    current = m; in_motion.store(true);
    if (!group || group->timeline.index == 0) { seen.emplace_back(id, r.owner); if (seen.size() > 256) seen.pop_front(); }
    Group::Goal goal;
    goal.request.group_name = has_gripper ? (has_arm ? "arm_with_gripper" : "gripper") : "arm"; goal.request.pipeline_id = "ompl";
    goal.request.allowed_planning_time = 5; goal.request.num_planning_attempts = 1;
    goal.request.max_velocity_scaling_factor = 1.0; goal.request.max_acceleration_scaling_factor = 1.0;
    goal.request.start_state.is_diff = true;
    goal.request.start_state.joint_state.name = arm_motion_joints();
    goal.request.start_state.joint_state.position = ordered_arm_values(joints.name, joints.position);
    if (has_gripper) {
      goal.request.start_state.joint_state.name.push_back(gripper_motion_joint());
      goal.request.start_state.joint_state.position.push_back(calibrated_gripper_value(joints.name, joints.position, gripper_calibration));
    }
    goal.request.start_state.joint_state.header.stamp = node.now();
    moveit_msgs::msg::Constraints constraints;
    if (m->tcp) {
      // KDL arm IK solves for joint6's child. Retain the complete fixed TCP offset.
      const auto tip = tcp_target_to_arm_tip(m->tcp_model, m->tcp_target);
      moveit_msgs::msg::PositionConstraint position;
      position.header.frame_id = m->tcp_model.root_link;
      position.link_name = m->tcp_model.arm_tip_link; position.weight = 1;
      shape_msgs::msg::SolidPrimitive sphere;
      const auto actual_tcp = tcp_forward_pose(m->tcp_model, ordered_arm_values(joints.name, joints.position));
      sphere.type = shape_msgs::msg::SolidPrimitive::SPHERE;
      sphere.dimensions = {tcp_planning_position_radius(tcp_pose_position_error(actual_tcp,m->tcp_target))};
      geometry_msgs::msg::Pose region;
      region.position.x = tip.position[0]; region.position.y = tip.position[1]; region.position.z = tip.position[2];
      region.orientation.w = 1;
      position.constraint_region.primitives.push_back(sphere);
      position.constraint_region.primitive_poses.push_back(region);
      constraints.position_constraints.push_back(position);
      moveit_msgs::msg::OrientationConstraint orientation;
      orientation.header.frame_id = m->tcp_model.root_link; orientation.link_name = m->tcp_model.arm_tip_link;
      orientation.orientation.x = tip.orientation[0]; orientation.orientation.y = tip.orientation[1];
      orientation.orientation.z = tip.orientation[2]; orientation.orientation.w = tip.orientation[3];
      orientation.absolute_x_axis_tolerance = orientation.absolute_y_axis_tolerance = orientation.absolute_z_axis_tolerance = .005;
      orientation.parameterization = moveit_msgs::msg::OrientationConstraint::ROTATION_VECTOR; orientation.weight = 1;
      constraints.orientation_constraints.push_back(orientation);
    }
    for (size_t i = 0; i < motion_model.joint_names.size(); ++i) {
      if (m->tcp && motion_model.joint_names[i] != gripper_motion_joint()) continue;
      moveit_msgs::msg::JointConstraint c; c.joint_name = motion_model.joint_names[i]; c.position = target[i];
      c.tolerance_above = c.tolerance_below = motion_goal_tolerance(c.joint_name); c.weight = 1; constraints.joint_constraints.push_back(c);
      const bool group_gripper_hold = group && group->spec.uses_gripper && c.joint_name == gripper_motion_joint() &&
          !group->spec.steps.at(group->timeline.index).gripper_position;
      if (group_gripper_hold || ((joint_targets || rotation_joint) && std::none_of(edits.begin(), edits.end(),
          [&](const auto &edit) { return edit.first == c.joint_name; }))) {
        c.position = actual[i];
        c.tolerance_above = c.tolerance_below = motion_hold_tolerance(c.joint_name);
        goal.request.path_constraints.joint_constraints.push_back(c);
        m->held_axes.push_back(i);
      }
    }
    log(m->owner, m->id, "validating", m->label + " · start=" + numbers(actual) + " target=" + numbers(target) +
        " duration_s=" + std::to_string(duration) + " scaling=1/1");
    if (m->tcp) {
      const auto tip = tcp_target_to_arm_tip(m->tcp_model, m->tcp_target);
      log(m->owner, m->id, "plan_tcp_goal", "frame=" + m->tcp_model.root_link + " tcp_link=" + pose_field->get<std::string>("tcp_link") +
          " planning_position_radius_m=" + motion_number(constraints.position_constraints.front().constraint_region.primitives.front().dimensions.front()) +
          " tcp_position_m=" + numbers(std::vector<double>(m->tcp_target.position.begin(), m->tcp_target.position.end())) +
          " tcp_quaternion_xyzw=" + numbers(std::vector<double>(m->tcp_target.orientation.begin(), m->tcp_target.orientation.end())) +
          " arm_tip_link=" + m->tcp_model.arm_tip_link + " arm_tip_position_m=" + numbers(std::vector<double>(tip.position.begin(), tip.position.end())) +
          " arm_tip_quaternion_xyzw=" + numbers(std::vector<double>(tip.orientation.begin(), tip.orientation.end())));
    }
    for (const auto &c : constraints.joint_constraints) {
      const auto it = std::find(motion_model.joint_names.begin(), motion_model.joint_names.end(), c.joint_name);
      const auto index = size_t(it - motion_model.joint_names.begin());
      log(m->owner, m->id, "plan_joint_goal", "joint=" + c.joint_name + " unit=" + (c.joint_name == gripper_motion_joint() ? "m" : "rad") +
          " actual=" + motion_number(actual.at(index)) + " target=" + motion_number(c.position) +
          " target_delta=" + motion_number(c.position-actual.at(index)) + " tolerance_above=" + motion_number(c.tolerance_above) +
          " tolerance_below=" + motion_number(c.tolerance_below));
    }
    goal.request.goal_constraints.push_back(constraints);
    goal.planning_options.plan_only = m->plan_only; goal.planning_options.replan = false;
    goal.planning_options.planning_scene_diff.is_diff = true;
    goal.planning_options.planning_scene_diff.robot_state.is_diff = true;
    if (!group || group->timeline.index == 0)
      r.send("{\"op\":" + quote(group ? "position_group_start_ack" : "position_move_ack") + ",\"accepted\":true,\"request_id\":" + quote(r.data.get<std::string>("request_id", "")) +
          ",\"command_id\":" + quote(id) + "}");
    log(m->owner, m->id, "plan_request", "group=" + goal.request.group_name + " pipeline=" + goal.request.pipeline_id +
        " allowed_planning_time_s=" + motion_number(goal.request.allowed_planning_time) + " attempts=" + std::to_string(goal.request.num_planning_attempts) +
        " plan_only=" + (m->plan_only ? "true" : "false") + " duration_source=" + (duration > 0 ? "explicit" : "automatic") +
        " requested_duration_s=" + motion_number(duration) + " joints=" + capture_names(m->model.joint_names) +
        " velocity_limits=" + numbers(m->velocity_limits) + " acceleration_limits=" + numbers(m->acceleration_limits));
    update(m, "planning", "MoveIt2 正在规划（自碰撞和已知环境碰撞检查）");
    rclcpp_action::Client<Group>::SendGoalOptions options;
    options.goal_response_callback = [this, m](Handle::SharedPtr handle) {
      if (m->terminal || current != m || m->planning_finished) {
        if (handle) try { action->async_cancel_goal(handle); } catch (...) {}
        return;
      }
      m->handle = handle;
      if (!handle) { finish_result(m, rclcpp_action::ResultCode::ABORTED, 0); return; }
      log(m->owner, m->id, "planning", "MoveGroup 已受理目标");
      if (m->cancel_requested) request_cancel_handle(m);
    };
    options.feedback_callback = [this, m](Handle::SharedPtr, const std::shared_ptr<const Group::Feedback> f) {
      if (m->terminal || m->cancel_requested || m->planning_finished || current != m || m->result_at != Clock::time_point{}) return;
      const bool executing = !m->plan_only && (f->state.find("MONITOR") != std::string::npos || f->state.find("EXECUT") != std::string::npos);
      update(m, executing ? "executing" : "planning", "MoveIt：" + f->state);
    };
    options.result_callback = [this, m](const Handle::WrappedResult &result) {
      if (m->terminal || current != m || m->planning_finished || m->result_at != Clock::time_point{}) return;
      m->planning_finished = true;
      m->handle.reset();
      log(m->owner, m->id, "result", "MoveGroup result=" + std::to_string(static_cast<int>(result.code)) +
          " error_code=" + std::to_string(result.result ? result.result->error_code.val : 0) +
          " points=" + std::to_string(result.result ? result.result->planned_trajectory.joint_trajectory.points.size() : 0) +
          " request_elapsed_s=" + motion_number(std::chrono::duration<double>(Clock::now()-m->started).count()) +
          " moveit_planning_time_s=" + (result.result ? motion_number(result.result->planning_time) : "unavailable"));
      if (m->plan_only && !m->cancel_requested && result.code == rclcpp_action::ResultCode::SUCCEEDED &&
          result.result && result.result->error_code.val == 1) {
        try { execute_plan(m, result.result->planned_trajectory); }
        catch (const std::exception &e) { update(m, "failed", e.what(), true); }
        return;
      }
      finish_result(m, result.code, result.result ? result.result->error_code.val : 0);
    };
    try { action->async_send_goal(goal, options); }
    catch (const std::exception &e) {
      m->cancel_requested = true; m->cancel_at = Clock::now();
      update(m, "stop_failed", std::string("规划受理状态未确认，保持锁定：") + e.what());
    }
  }
  void finish_result(const std::shared_ptr<Motion> &m, rclcpp_action::ResultCode code, int error_code) {
      if (m->terminal || current != m || m->result_at != Clock::time_point{}) return;
      log(m->owner, m->id, "result", "Action result=" + std::to_string(static_cast<int>(code)) + " error_code=" + std::to_string(error_code),
          code == rclcpp_action::ResultCode::SUCCEEDED && error_code == 1 ? "info" : "warn");
      m->result_at = Clock::now(); m->code = error_code;
      if (m->cancel_requested) { update(m, "stopping", "MoveIt 已返回，等待关节停稳"); return; }
      if (code != rclcpp_action::ResultCode::SUCCEEDED || m->code != 1) {
        m->failed_result = true; update(m, "stopping", "MoveIt 规划/执行失败，error_code=" + std::to_string(m->code) + "；等待停稳确认"); return;
      }
      update(m, "verifying", "执行 Action 成功，正在核对实际到位反馈");
  }
  void execute_plan(const std::shared_ptr<Motion> &m, const moveit_msgs::msg::RobotTrajectory &plan) {
    const auto &trajectory = plan.joint_trajectory;
    log(m->owner, m->id, "plan_result", "joints=" + capture_names(trajectory.joint_names) +
        " points=" + std::to_string(trajectory.points.size()) +
        " first_time_s=" + (trajectory.points.empty() ? "missing" : motion_number(trajectory.points.front().time_from_start.sec + trajectory.points.front().time_from_start.nanosec/1e9)) +
        " last_time_s=" + (trajectory.points.empty() ? "missing" : motion_number(trajectory.points.back().time_from_start.sec + trajectory.points.back().time_from_start.nanosec/1e9)));
    m->validation_stage = "preflight";
    try { execute_plan_checked(m, plan); }
    catch (const std::exception &e) {
      log(m->owner, m->id, "plan_rejected", "stage=" + m->validation_stage + " reason=" + e.what(), "error");
      throw;
    }
  }
  void execute_plan_checked(const std::shared_ptr<Motion> &m, const moveit_msgs::msg::RobotTrajectory &plan) {
    if (m->terminal || m->cancel_requested || current != m) return;
    bool pending_cancel = false;
    {
      std::lock_guard<std::mutex> lock(queue_mutex);
      pending_cancel = std::any_of(requests.begin(), requests.end(), [&](const auto &request) {
        return (request.disconnect && (request.owner == 0 || request.owner == m->owner)) ||
            (request.owner == m->owner && request.data.template get<std::string>("op", "") == "position_cancel" &&
             request.data.template get<std::string>("command_id", "") == m->id);
      });
    }
    if (pending_cancel) {
      cancel(m, "执行前已收到取消或断线请求");
      finish_result(m, rclcpp_action::ResultCode::CANCELED, -7);
      return;
    }
    const auto reason = readiness();
    if (!reason.empty()) throw std::runtime_error(reason);
    if (clock_snapshot().generation != m->clock_generation)
      throw std::runtime_error("规划期间时钟基准改变，未执行旧时间基准的轨迹");
    if (!fresh(m->lease_at, 5)) throw std::runtime_error("会话心跳已过期，未执行规划轨迹");
    if (!execute_action->action_server_is_ready()) throw std::runtime_error("MoveIt /execute_trajectory 未启动");
    if (m->gripper) { const auto why = gripper_readiness(); if (!why.empty()) throw std::runtime_error(why); }
    if (m->group && m->group->spec.uses_gripper) { const auto why = gripper_readiness(); if (!why.empty()) throw std::runtime_error(why); }
    m->validation_stage = "trajectory_shape";
    if (!same_motion_joints(plan.joint_trajectory.joint_names, m->model.joint_names) || !plan.multi_dof_joint_trajectory.points.empty() ||
        !plan.multi_dof_joint_trajectory.joint_names.empty()) throw std::runtime_error("规划轨迹关节集合与请求不匹配");
    const auto &names = plan.joint_trajectory.joint_names;
    const auto log_point = [&](size_t index) {
      const auto &p = plan.joint_trajectory.points[index];
      log(m->owner, m->id, "plan_point", motion_point_summary({p.positions,p.velocities,p.accelerations,{},
          int64_t(p.time_from_start.sec)*1000000000LL+p.time_from_start.nanosec}, index));
    };
    if (!plan.joint_trajectory.points.empty()) {
      log_point(0);
      if (plan.joint_trajectory.points.size() > 1) log_point(plan.joint_trajectory.points.size()-1);
    }
    if (plan.joint_trajectory.points.empty() || plan.joint_trajectory.points.size() > 10000)
      throw std::runtime_error("规划轨迹点数无效 points=" + std::to_string(plan.joint_trajectory.points.size()) + " required=1..10000（单点仅支持已到位夹爪核验）");
    std::vector<TimedMotionPoint> points;
    for (const auto &point : plan.joint_trajectory.points) {
      m->validation_stage = "decode_point_" + std::to_string(points.size());
      if (point.time_from_start.nanosec >= 1000000000) throw std::runtime_error("规划轨迹时间无效");
      points.push_back({ordered_motion_values(m->model.joint_names, names, point.positions),
          point.velocities.empty() ? std::vector<double>{} : ordered_motion_values(m->model.joint_names, names, point.velocities),
          point.accelerations.empty() ? std::vector<double>{} : ordered_motion_values(m->model.joint_names, names, point.accelerations),
          point.effort.empty() ? std::vector<double>{} : ordered_motion_values(m->model.joint_names, names, point.effort),
          static_cast<int64_t>(point.time_from_start.sec) * 1000000000 + point.time_from_start.nanosec});
    }
    if (points.size() == 1) {
      m->validation_stage = "no_motion_goal";
      const auto actual = measured(m->model, false, &m->calibration);
      if (m->tcp || !valid_gripper_no_motion_plan(points.front(), m->model, m->target, actual))
        throw std::runtime_error("单点规划不满足已到位夹爪核验条件；未下发轨迹 target=" + numbers(m->target) + " actual=" + numbers(actual));
      m->no_motion = true;
      m->code = 1;
      m->result_at = Clock::now();
      log(m->owner, m->id, "plan_no_motion", "gripper already within planning tolerance; no ExecuteTrajectory dispatched target=" +
          numbers(m->target) + " actual=" + numbers(actual) + " tolerance_m=0.0005 verification_s=0.2");
      update(m, "verifying", "夹爪已在目标容差内，未下发轨迹；正在核对连续新鲜到位及停稳反馈");
      return;
    }
    if (!points.empty()) { m->recommended_duration=points.back().time_ns/1e9; update(m,"planning","MoveIt 推荐运动时长："+std::to_string(m->recommended_duration)+" 秒（仅供参考）"); }
    const bool automatic_duration = m->duration == 0;
    if (automatic_duration) m->duration = m->recommended_duration;
    log(m->owner, m->id, "plan_timing", std::string("duration_source=") + (automatic_duration ? "automatic" : "explicit") +
        " original_duration_s=" + motion_number(m->recommended_duration) + " execution_duration_s=" + motion_number(m->duration) +
        " time_scale=" + (m->recommended_duration > 0 ? motion_number(m->duration/m->recommended_duration) : "invalid"));
    for (const auto &summary : motion_plan_summaries(points, m->model, m->velocity_limits, m->acceleration_limits))
      log(m->owner, m->id, "plan_joint", summary);
    m->validation_stage = "timing_and_spline";
    if (automatic_duration) {
      auto timed = automatic_motion_timing(points, m->model, m->velocity_limits, m->acceleration_limits,
          [this, m](double previous, double next, const std::string &reason) {
            log(m->owner, m->id, "plan_retime", "自动延长运动时长 previous_duration_s=" + motion_number(previous) +
                " next_duration_s=" + motion_number(next) + " reason=" + reason, "warn");
          });
      points = std::move(timed.points); m->duration = timed.duration_s;
      if (timed.adjustments)
        log(m->owner, m->id, "plan_timing", "duration_source=automatic original_duration_s=" + motion_number(m->recommended_duration) +
            " execution_duration_s=" + motion_number(m->duration) + " time_scale=" + motion_number(m->duration/m->recommended_duration) +
            " adjustments=" + std::to_string(timed.adjustments) + " spline_validation=passed");
    } else {
      points = stretch_motion(std::move(points), m->duration, m->model, m->velocity_limits, m->acceleration_limits);
    }
    m->validation_stage = "start_and_goal";
    const auto actual = measured(m->model, false, &m->calibration);
    for (size_t i = 0; i < m->model.joint_names.size(); ++i) {
      if (std::abs(points.front().positions[i] - actual[i]) > (m->model.joint_names[i] == gripper_motion_joint() ? .001 : start_tolerance))
        throw std::runtime_error("规划后实测起点已变化，请重新规划 joint=" + m->model.joint_names[i] +
            " planned=" + motion_number(points.front().positions[i]) + " actual=" + motion_number(actual[i]) +
            " tolerance=" + motion_number(m->model.joint_names[i] == gripper_motion_joint() ? .001 : start_tolerance));
      if ((!m->tcp || m->model.joint_names[i] == gripper_motion_joint()) && std::abs(points.back().positions[i] - m->target[i]) > motion_goal_tolerance(m->model.joint_names[i]) + 1e-9)
        throw std::runtime_error("规划轨迹终点与目标不匹配 joint=" + m->model.joint_names[i] +
            " planned=" + motion_number(points.back().positions[i]) + " target=" + motion_number(m->target[i]) +
            " tolerance=" + motion_number(motion_goal_tolerance(m->model.joint_names[i])));
    }
    m->validation_stage = "tcp_goal";
    if (m->tcp) {
      const std::vector<double> arm_goal(points.back().positions.begin(), points.back().positions.begin() + 6);
      const auto final_pose = tcp_forward_pose(m->tcp_model, arm_goal);
      if (tcp_pose_position_error(final_pose, m->tcp_target) > .005 || tcp_pose_orientation_error(final_pose, m->tcp_target) > .02)
        throw std::runtime_error("MoveIt 轨迹终点未满足 TCP 位置/姿态目标，未执行 position_error_m=" +
            motion_number(tcp_pose_position_error(final_pose, m->tcp_target)) + " position_tolerance_m=0.005 orientation_error_rad=" +
            motion_number(tcp_pose_orientation_error(final_pose, m->tcp_target)) + " orientation_tolerance_rad=0.02");
      m->target = points.back().positions;
    }
    m->validation_stage = "held_axes";
    for (const auto &point : points) for (const auto i : m->held_axes)
      if (std::abs(point.positions[i] - m->target[i]) > motion_hold_tolerance(m->model.joint_names[i]) + 1e-9)
        throw std::runtime_error("规划轨迹不满足未编辑关节的保持约束 joint=" + m->model.joint_names[i] +
            " t_s=" + motion_number(point.time_ns/1e9) + " planned=" + motion_number(point.positions[i]) +
            " target=" + motion_number(m->target[i]) + " tolerance=" + motion_number(motion_hold_tolerance(m->model.joint_names[i])));
    Execute::Goal goal;
    goal.trajectory.joint_trajectory.joint_names = m->model.joint_names;
    goal.trajectory.joint_trajectory.header.frame_id = plan.joint_trajectory.header.frame_id;
    for (const auto &point : points) {
      trajectory_msgs::msg::JointTrajectoryPoint out;
      out.positions = point.positions; out.velocities = point.velocities;
      out.accelerations = point.accelerations; out.effort = point.effort;
      out.time_from_start.sec = static_cast<int32_t>(point.time_ns / 1000000000);
      out.time_from_start.nanosec = static_cast<uint32_t>(point.time_ns % 1000000000);
      goal.trajectory.joint_trajectory.points.push_back(out);
    }
    rclcpp_action::Client<Execute>::SendGoalOptions options;
    options.goal_response_callback = [this, m, automatic_duration](ExecuteHandle::SharedPtr handle) {
      if (m->terminal || current != m || m->result_at != Clock::time_point{}) {
        if (handle) try { execute_action->async_cancel_goal(handle); } catch (...) {}
        return;
      }
      m->execution_handle = handle;
      if (!handle) { finish_result(m, rclcpp_action::ResultCode::ABORTED, 0); return; }
      if (m->cancel_requested) request_cancel_handle(m);
      else update(m, "executing", std::string(automatic_duration ? "按校验后的自动运动时长执行：" : "按指定运动时长执行：") + std::to_string(m->duration) + " 秒");
    };
    options.result_callback = [this, m](const ExecuteHandle::WrappedResult &result) {
      if (m->terminal || current != m) return;
      m->execution_handle.reset();
      finish_result(m, result.code, result.result ? result.result->error_code.val : 0);
    };
    log(m->owner, m->id, "dispatch", "ExecuteTrajectory points=" + std::to_string(points.size()) + " duration_s=" + std::to_string(m->duration));
    update(m, "planning", "规划完成，等待 MoveIt 执行调整后的完整轨迹");
    try { execute_action->async_send_goal(goal, options); }
    catch (const std::exception &e) {
      m->cancel_requested = true; m->cancel_at = Clock::now();
      update(m, "stop_failed", std::string("轨迹受理状态未确认，保持锁定：") + e.what());
    }
  }
  void dispatch_group_step(const Request &request, const std::shared_ptr<GroupRun> &group) {
    const auto &step = group->spec.steps.at(group->timeline.index);
    Request r{request.owner, {}, request.send};
    r.data.put("op", "position_move"); r.data.put("command_id", request.data.get<std::string>("command_id"));
    r.data.put("request_id", request.data.get<std::string>("request_id", "")); r.data.put("confirmation", "ARMED");
    r.data.put("label", group->spec.label);
    r.data.put("motion_duration_s", group->timeline.index == 0 ? group->spec.preparation_duration_s : step.motion_duration_s);
    Tree positions;
    for (const auto value : step.positions) { Tree entry; entry.put_value(value); positions.push_back({"", entry}); }
    r.data.add_child("positions", positions);
    if (group->spec.uses_gripper) r.data.put("gripper_position", step.gripper_position.value_or(
        calibrated_gripper_value(joints.name, joints.position, gripper_calibration)));
    move(r, group);
  }
  void start_group(const Request &r) {
    const auto id = r.data.get<std::string>("command_id", "");
    if (id.empty() || id.size() > 80 || id.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-") != std::string::npos)
      throw std::runtime_error("command_id 无效");
    if (r.data.get<std::string>("confirmation", "") != "ARMED") throw std::runtime_error("请先确认工作区安全并解锁动作组执行");
    for (const auto &old : seen) if (old.first == id) {
      if (current && current->group && current->owner == r.owner && current->id == id && current->group->spec.id == r.data.get<std::string>("group_id", "")) {
        r.send("{\"op\":\"position_group_start_ack\",\"accepted\":true,\"request_id\":" + quote(r.data.get<std::string>("request_id", "")) + ",\"command_id\":" + quote(id) + "}");
        r.send(event(*current)); return;
      }
      throw std::runtime_error("重复的运动 command_id，未重复执行");
    }
    if (current && !current->terminal) throw std::runtime_error("已有运动或动作组，等待完成或取消确认后再试");
    const auto reason = readiness(); if (!reason.empty()) throw std::runtime_error(reason);
    if (!execute_action->action_server_is_ready()) throw std::runtime_error("MoveIt /execute_trajectory 未启动");
    auto group = std::make_shared<GroupRun>();
    group->spec = read_position_group(r.data, model, gripper_supported, gripper_calibration.lower, gripper_calibration.upper);
    if (group->spec.uses_gripper) { const auto why = gripper_readiness(); if (!why.empty()) throw std::runtime_error(why); }
    group->model_signature = model_signature; group->clock_generation = clock_snapshot().generation;
    group->timeline.last_s = steady_seconds();
    dispatch_group_step(r, group);
  }
  void pause_group(const Request &r, bool resume) {
    const auto id = r.data.get<std::string>("command_id", "");
    const auto m = current;
    if (!m || m->owner != r.owner || m->id != id || !m->group || m->terminal || m->cancel_requested || m->failed_result)
      throw std::runtime_error("本会话没有可暂停/继续的动作组");
    auto &timeline = m->group->timeline;
    if (at_group_boundary(m)) {
      const auto reason = readiness(false); if (!reason.empty()) throw std::runtime_error(reason);
      if (m->group->spec.uses_gripper) { const auto why = gripper_readiness(false); if (!why.empty()) throw std::runtime_error(why); }
      group_wait(m, false);
      if (m->cancel_requested) throw std::runtime_error("停留/暂停保持检查失败，已请求取消");
    }
    if (resume) {
      if (timeline.phase != "paused") throw std::runtime_error("动作组尚未在安全边界暂停");
      const auto reason = readiness(); if (!reason.empty()) throw std::runtime_error(reason);
      if (m->group->spec.uses_gripper) { const auto why = gripper_readiness(); if (!why.empty()) throw std::runtime_error(why); }
      if (m->group->model_signature != model_signature || m->clock_generation != clock_snapshot().generation)
        throw std::runtime_error("动作组模型或时钟基准已改变，禁止继续");
      if (!fresh(m->lease_at, 5)) throw std::runtime_error("会话心跳已过期，禁止继续动作组");
      const auto actual = measured(m->model, false, &m->calibration), velocity = measured(m->model, true, &m->calibration);
      if (!m->hold_recovery.ready || !group_hold_position_valid(m->model.joint_names, m->hold_reference, actual) || !motion_stopped(m->model.joint_names, velocity))
        throw std::runtime_error("暂停反馈尚未连续停稳 200 ms 或偏离实测保持基准，禁止继续");
      if (m->group->spec.uses_gripper && !motion_stopped({gripper_motion_joint()}, {calibrated_gripper_value(joints.name, joints.velocity, m->calibration, true)}))
        throw std::runtime_error("暂停期间夹爪尚未停稳，禁止继续");
      timeline.resume(steady_seconds());
      update(m, "waiting", "动作组已继续，等待本项停留时间结束");
    } else {
      timeline.pause(steady_seconds());
      if (timeline.phase == "paused") update(m, m->hold_recovery.ready ? "paused" : "verifying", m->hold_recovery.ready ? "动作组已在停稳边界暂停，保留运动锁" : "动作组已暂停推进，正在重新确认停稳，继续暂不可用");
    }
    r.send("{\"op\":" + quote(resume ? "position_group_resume_ack" : "position_group_pause_ack") +
        ",\"accepted\":true,\"request_id\":" + quote(r.data.get<std::string>("request_id", "")) + ",\"command_id\":" + quote(id) +
        ",\"pending\":" + (timeline.phase == "paused" || resume ? "false" : "true") + "}");
    if (!resume && timeline.phase != "paused") m->send(event(*m));
  }
  void fail_group_hold(const std::shared_ptr<Motion> &m, const std::string &reason,
      const std::vector<double> &actual, const std::vector<double> &velocity) {
    if (!m->hold_failure) {
      m->hold_failure = GroupHoldFailure{reason, m->group->timeline.phase,
        std::chrono::duration<double, std::milli>(std::chrono::system_clock::now().time_since_epoch()).count(),
        std::chrono::duration<double, std::milli>(Clock::now() - joints_at).count(), m->hold_recovery.stable_for_ms(),
          motion_arrival_errors(m->model.joint_names, m->hold_reference, actual, velocity)};
      log(m->owner, m->id, "hold_failure", group_hold_failure_json(*m->hold_failure), "error");
    }
    m->group->failed = true;
    cancel(m, reason == "position_drift" ? "动作组偏离停留/暂停时的实测保持基准，取消后续步骤" : "停留/暂停反馈持续 5 秒未重新停稳，取消后续步骤");
  }
  // Return true only after a fresh image and matching actual feedback have been
  // committed. Encoding and disk I/O never run on the motion callback group.
  bool capture_group_action(const std::shared_ptr<Motion> &m) {
    const auto &captures = m->group->spec.steps.at(m->group->timeline.index).captures;
    if (m->capture_index >= captures.size()) return true;
    const auto spec = captures[m->capture_index];
    if (m->capture_job) {
      auto job = m->capture_job;
      if (std::chrono::duration<double>(Clock::now() - m->capture_started).count() >= spec.timeout_s) {
        job->canceled.store(true); throw std::runtime_error("拍照 Action「" + spec.label + "」超时，未继续后续步骤");
      }
      if (!job->done.load()) return false;
      std::lock_guard<std::mutex> lock(job->mutex);
      if (!job->error.empty()) throw std::runtime_error("拍照失败：" + job->error);
      m->group->last_capture = job->result;
      log(m->owner, m->id, "capture", job->result.substr(0, job->result.find(",\"thumbnail\"")) + "}");
      m->capture_job.reset(); m->capture_sub.reset(); ++m->capture_index;
      update(m, "waiting", "拍照「" + spec.label + "」图像及实际姿态已保存");
      return m->capture_index == captures.size();
    }
    auto job = std::make_shared<CaptureJob>(); m->capture_job = job; m->capture_started = Clock::now();
    const double requested_stamp = node.now().seconds();
    rclcpp::SubscriptionOptions options; options.callback_group = callback_group;
    m->capture_sub = node.create_subscription<sensor_msgs::msg::Image>(spec.topic, rclcpp::SensorDataQoS(),
      [this, weak = std::weak_ptr<Motion>(m), job, spec, requested_stamp](sensor_msgs::msg::Image::ConstSharedPtr image) {
        const auto task = weak.lock();
        if (!task || task != current || task->terminal || task->cancel_requested || job->canceled.load() || job->started.load() || job->done.load()) return;
        const double image_stamp = double(image->header.stamp.sec) + image->header.stamp.nanosec / 1e9;
        const double joint_stamp = double(joints.header.stamp.sec) + joints.header.stamp.nanosec / 1e9;
        if (image_stamp < requested_stamp || !capture_stamp_valid(node.now().seconds(), image_stamp, joint_stamp) ||
            !fresh(joints_at, .5) || !clock_snapshot().healthy() || !task->hold_recovery.ready) return;
        try {
          const auto actual = measured(task->model, false, &task->calibration), velocity = measured(task->model, true, &task->calibration);
          if (!motion_stopped(task->model.joint_names, velocity) || !group_hold_position_valid(task->model.joint_names, task->hold_reference, actual)) return;
          if (image->data.size() > 64 * 1024 * 1024) throw std::runtime_error("图像超过 64 MiB");
          const auto home = std::getenv("HOME");
          if (!home || !*home) throw std::runtime_error("Jetson HOME 未配置，无法保存采集结果");
          const auto folder = std::filesystem::path(home) / ".local/share/robot-console/captures" / task->id / spec.id;
          const auto metadata = "{\"action_id\":" + quote(spec.id) + ",\"name\":" + quote(spec.label) + ",\"topic\":" + quote(spec.topic) +
              ",\"image_stamp\":" + std::to_string(image_stamp) + ",\"joint_stamp\":" + std::to_string(joint_stamp) +
              ",\"frame_id\":" + quote(image->header.frame_id) + ",\"joint_names\":" + capture_names(task->model.joint_names) +
              ",\"positions\":" + numbers(actual) + ",\"velocities\":" + numbers(velocity) + "}";
          // Own the message, metadata and job only: late writes cannot touch a
          // destroyed node or continue a canceled/reconnected motion session.
          job->started.store(true);
          std::thread([job, image, folder, metadata, spec, image_stamp, joint_stamp] {
            auto temporary = folder; temporary += ".pending";
            bool owns_temporary = false;
            try {
              CaptureImage source{image->width, image->height, image->step, image->encoding, image->data};
              const auto png = capture_png(source), thumbnail = capture_png(source, 120);
              if (job->canceled.load()) return;
              std::filesystem::create_directories(folder.parent_path());
              if (std::filesystem::exists(folder) || !std::filesystem::create_directory(temporary)) throw std::runtime_error("采集目录已存在，拒绝覆盖");
              owns_temporary = true;
              const auto write = [](const std::filesystem::path &path, const char *data, size_t size) {
                std::ofstream file(path, std::ios::binary | std::ios::out); file.exceptions(std::ios::badbit | std::ios::failbit);
                file.write(data, std::streamsize(size)); file.flush(); file.close();
              };
              write(temporary / "image.png", reinterpret_cast<const char *>(png.data()), png.size());
              write(temporary / "pose.json", metadata.data(), metadata.size());
              if (job->canceled.load()) { std::filesystem::remove_all(temporary); return; }
              std::filesystem::rename(temporary, folder);
              std::lock_guard<std::mutex> lock(job->mutex);
              job->result = "{\"id\":" + quote(spec.id) + ",\"name\":" + quote(spec.label) + ",\"path\":" + quote((folder / "image.png").string()) +
                  ",\"image_stamp\":" + std::to_string(image_stamp) + ",\"joint_stamp\":" + std::to_string(joint_stamp) + ",\"thumbnail\":" + quote(capture_base64(thumbnail)) + "}";
            } catch (const std::exception &e) {
              std::error_code ignored; if (owns_temporary) std::filesystem::remove_all(temporary, ignored);
              std::lock_guard<std::mutex> lock(job->mutex); job->error = e.what();
            }
            job->done.store(true);
          }).detach();
        } catch (const std::exception &e) {
          std::lock_guard<std::mutex> lock(job->mutex); job->error = e.what(); job->done.store(true);
        }
      }, options);
    update(m, "waiting", "正在采集「" + spec.label + "」，等待有效图像及实际姿态保存");
    return false;
  }
  void advance_group(const std::shared_ptr<Motion> &m) {
    try { if (!capture_group_action(m)) return; }
    catch (const std::exception &e) { m->group->failed = true; cancel(m, e.what()); return; }
    auto &group = *m->group;
    auto &timeline = group.timeline;
    if (timeline.index + 1 == group.spec.steps.size()) { update(m, "succeeded", "动作组全部步骤 Action 成功、已停稳并完成停留（关节目标误差仅诊断）", true); return; }
    const auto previous = timeline;
    timeline.next(steady_seconds());
    Request r{m->owner, {}, m->send}; r.data.put("command_id", m->id);
    try { dispatch_group_step(r, m->group); }
    catch (const std::exception &e) {
      if (current == m) timeline = previous; // Diagnostics still refer to this completed child.
      group.failed = true; cancel(current, std::string("动作组下一段校验失败：") + e.what());
    }
  }
  void group_wait(const std::shared_ptr<Motion> &m, bool allow_progress = true) {
    auto &timeline = m->group->timeline;
    const auto actual = measured(m->model, false, &m->calibration), velocity = measured(m->model, true, &m->calibration);
    if (!group_hold_position_valid(m->model.joint_names, m->hold_reference, actual)) {
      fail_group_hold(m, "position_drift", actual, velocity); return;
    }
    const bool stopped = motion_stopped(m->model.joint_names, velocity);
    const auto result = m->hold_recovery.observe(steady_seconds(), std::chrono::duration<double>(joints_at.time_since_epoch()).count(), stopped);
    // Freeze the entire interval containing an unstable sample. The interval
    // ending the recovery window is also frozen; countdown resumes afterwards.
    if (result != GroupHoldResult::ready) timeline.hold_blocked = true;
    timeline.advance(steady_seconds());
    timeline.hold_blocked = result != GroupHoldResult::ready;
    if (result == GroupHoldResult::velocity_timeout) { fail_group_hold(m, "velocity_timeout", actual, velocity); return; }
    if (result != GroupHoldResult::ready && m->phase != "verifying")
      update(m, "verifying", "停留/暂停反馈正在重新确认停稳（需连续新鲜反馈 200 ms），剩余停留已冻结");
    else if (result == GroupHoldResult::ready && m->phase == "verifying")
      update(m, timeline.phase == "paused" ? "paused" : "waiting", "已重新确认连续停稳 200 ms，保留实测保持基准");
    if (result != GroupHoldResult::ready || !allow_progress || timeline.phase == "paused" || timeline.hold_remaining_s > 0) return;
    advance_group(m);
  }
  void process(const Request &r) {
    if (r.disconnect) { if (current && (r.owner == 0 || current->owner == r.owner)) cancel(current, r.owner == 0 ? "已请求 DISABLE，取消点位运动" : "连接已断开，已请求取消"); return; }
    const auto op = r.data.get<std::string>("op", "");
    if (op == "position_motion_info") {
      if (current && current->owner == r.owner && !current->terminal) current->lease_at = Clock::now();
      const auto reason = readiness();
      const bool home = fresh(model_at, 10) && model.home.size() == 6 && model_error.empty();
      const auto gripper_reason = reason.empty() ? gripper_readiness() : reason;
      std::string gripper_sample;
      if (gripper_supported && fresh(model_at, 10) && model_error.empty() && fresh(joints_at) && clock_snapshot().healthy()) try {
        const auto position = calibrated_gripper_value(joints.name, joints.position, gripper_calibration);
        if (position >= gripper_calibration.lower - 1e-8 && position <= gripper_calibration.upper + 1e-8) {
          std::ostringstream value; value << std::setprecision(17) << position;
          gripper_sample = value.str();
        }
      } catch (...) {}
      const auto after = r.data.get<std::string>("motion_log_session", "") == log_session ? r.data.get<uint64_t>("motion_log_after", 0) : 0;
      r.send("{\"op\":\"position_motion_info\",\"request_id\":" + quote(r.data.get<std::string>("request_id", "")) +
          ",\"available\":" + (reason.empty() ? "true" : "false") + ",\"message\":" + quote(reason) +
          ",\"joint_rotation_supported\":true,\"joint_targets_supported\":true,\"motion_duration_supported\":true,\"tcp_pose_supported\":true,\"motion_group_supported\":true,\"motion_capture_supported\":true" +
          ",\"position_error_check_enforced\":false" +
          ",\"motion_duration_message\":" + quote(execute_action->action_server_is_ready() ? "" : "MoveIt /execute_trajectory 未启动") +
          ",\"command_id\":" + quote(current && current->owner == r.owner ? current->id : "") +
          ",\"busy\":" + ((current && !current->terminal) ? "true" : "false") +
          ",\"gripper_supported\":" + (gripper_supported && home ? "true" : "false") +
          ",\"gripper_available\":" + (gripper_reason.empty() ? "true" : "false") +
          ",\"gripper_message\":" + quote(gripper_reason) + ",\"gripper_joint_name\":" + quote(gripper_motion_joint()) +
          ",\"gripper_lower\":" + std::to_string(gripper_calibration.lower) + ",\"gripper_upper\":" + std::to_string(gripper_calibration.upper) +
          ",\"gripper_feedback_age_ms\":" + std::to_string(gripper_sample.empty() ? 1000. : std::chrono::duration<double, std::milli>(Clock::now() - joints_at).count()) +
          ",\"gripper_feedback_fresh\":" + (gripper_sample.empty() ? "false" : "true") +
          (gripper_sample.empty() ? "" : ",\"gripper_position\":" + gripper_sample) +
          ",\"home_positions\":" + (home ? numbers(model.home) : "[]") +
          ",\"motion_log_session\":" + quote(log_session) + "," + logs.page(r.owner, after) + "}");
      if (current && current->owner == r.owner) r.send(event(*current));
    } else if (op == "position_move") move(r);
    else if (op == "position_group_start") start_group(r);
    else if (op == "position_group_pause" || op == "position_group_resume") pause_group(r, op == "position_group_resume");
    else if (op == "position_cancel") {
      if (!current || current->owner != r.owner || current->id != r.data.get<std::string>("command_id", ""))
        throw std::runtime_error("本会话没有对应的运动");
      cancel(current, "用户请求取消，等待停止确认");
      r.send("{\"op\":\"position_cancel_ack\",\"request_id\":" + quote(r.data.get<std::string>("request_id", "")) + "}");
    }
  }
  void tick() {
    poll_controllers();
    if (!fresh(model_request_at, 3)) poll_model();
    const auto controller_reason = controller_readiness();
    if (controller_reason != controller_health_reason) {
      log(0, "", "controller", controller_reason.empty() ? "轨迹控制器状态校验已恢复" : controller_reason,
          controller_reason.empty() ? "info" : "warn");
      controller_health_reason = controller_reason;
    }
    const auto health = readiness(false);
    if (health != health_reason) {
      // Controller failures already have a canonical transition above.
      if (health.empty() || health != controller_reason)
        log(0, "", "health", health.empty() ? "规划执行条件已就绪" : health, health.empty() ? "info" : "warn");
      health_reason = health;
    }
    std::deque<Request> pending;
    { std::lock_guard<std::mutex> lock(queue_mutex); pending.swap(requests); }
    for (const auto &r : pending) try { process(r); } catch (const std::exception &e) {
      log(r.owner, r.data.get<std::string>("command_id", ""), "rejected", e.what(), "error");
      const auto op = r.data.get<std::string>("op", "");
      if (op == "position_move" || op == "position_group_start" || op == "position_group_pause" || op == "position_group_resume")
        r.send("{\"op\":" + quote(op + "_ack") + ",\"accepted\":false,\"request_id\":" + quote(r.data.get<std::string>("request_id", "")) +
          ",\"command_id\":" + quote(r.data.get<std::string>("command_id", "")) + ",\"message\":" + quote(e.what()) + "}");
      else error(r, e.what());
    }
    const auto m = current;
    if (!m || m->terminal) return;
    if (!m->cancel_requested) {
      auto reason = readiness(false);
      if (reason.empty() && clock_snapshot().generation != m->clock_generation) reason = "运动期间时钟基准改变";
      if (reason.empty() && m->gripper) reason = gripper_readiness(false);
      if (reason.empty() && m->group && m->group->spec.uses_gripper) reason = gripper_readiness(false);
      if (!reason.empty()) { if (m->group) m->group->failed = true; cancel(m, reason + "，已请求取消"); }
      if (!at_group_boundary(m) && !fresh(m->started, std::max(180.,m->duration+60.))) {
        if (m->group) m->group->failed = true;
        cancel(m, "运动超时，已请求取消");
      }
      if (!fresh(m->lease_at, 5)) cancel(m, "会话心跳超过 5 秒，已请求取消");
    }
    if (m->cancel_requested && !fresh(m->cancel_at, 5) && m->phase != "stop_failed")
      update(m, "stop_failed", "停止未确认；保留控制进程，请检查现场并使用既有安全停机入口");
    if (at_group_boundary(m) && !m->cancel_requested) {
      try { group_wait(m); } catch (const std::exception &e) { m->group->failed = true; cancel(m, e.what()); }
      return;
    }
    if (!m->result_at.time_since_epoch().count() || !fresh(joints_at) || joints_at < m->result_at || !clock_snapshot().healthy() ||
        ((m->gripper || (m->group && m->group->spec.uses_gripper)) && (!fresh(gripper_state_at) || gripper_state_at < m->result_at))) {
      m->settled_at = {}; return;
    }
    try {
      const auto actual = measured(m->model, false, &m->calibration), velocity = measured(m->model, true, &m->calibration);
      // A gripper-only goal still requires the complete arm to be stopped before releasing the shared motion lock.
      const bool stopped = motion_stopped(m->model.joint_names, velocity) && motion_stopped(arm_motion_joints(), ordered_arm_values(joints.name, joints.velocity)) &&
          (!(m->group && m->group->spec.uses_gripper) || motion_stopped({gripper_motion_joint()}, {calibrated_gripper_value(joints.name, joints.velocity, m->calibration, true)}));
      bool pose_reached = true;
      if (m->tcp) {
        const auto measured_pose = tcp_forward_pose(m->tcp_model, ordered_arm_values(joints.name, joints.position));
        pose_reached = tcp_pose_position_error(measured_pose, m->tcp_target) <= .005 && tcp_pose_orientation_error(measured_pose, m->tcp_target) <= .02;
      }
      const bool reached = stopped && pose_reached && (!m->no_motion || gripper_no_motion_reached(m->model, m->target, actual)) && motion_completion_stopped(m->model.joint_names, actual, velocity);
      if (((m->cancel_requested || m->failed_result) && stopped) || (m->phase == "verifying" && reached)) {
        if (m->settled_at == Clock::time_point{}) m->settled_at = Clock::now();
        if (!fresh(m->settled_at, 0.2)) {
          log(m->owner, m->id, "feedback", "target=" + numbers(m->target) + " actual=" + numbers(actual) + " velocity=" + numbers(velocity));
          if (m->group && !m->cancel_requested && !m->failed_result) {
            m->hold_reference = actual;
            m->group->timeline.segment_complete(steady_seconds(), m->group->spec.steps.at(m->group->timeline.index).hold_duration_s);
            if (m->group->timeline.hold_remaining_s == 0 && m->group->timeline.phase != "paused") {
              advance_group(m); return;
            }
            update(m, m->group->timeline.phase == "paused" ? "paused" : "waiting", m->group->timeline.phase == "paused" ? "动作组已在停稳边界暂停，保留运动锁" : "本项 Action 成功且已停稳，正在停留（关节目标误差仅诊断）");
            return;
          }
          update(m, m->group && m->group->failed ? "failed" : m->cancel_requested ? "canceled" : m->failed_result ? "failed" : "succeeded",
            m->group && m->group->failed ? "动作组失败，后续步骤未执行；" + m->message + "；已确认停稳" : m->cancel_requested ? "已取消且确认关节停稳" : m->failed_result ? (m->no_motion ? "夹爪无运动核验未通过，已确认停稳" : m->code == 1 ? "执行已结束但未满足 TCP 位姿精度，已确认停稳" : "MoveIt 失败（error_code=" + std::to_string(m->code) + "），已确认停稳") : (m->no_motion ? "夹爪已在目标容差内并连续停稳 200 ms，未下发轨迹" : m->tcp ? "已到达 TCP 位姿（位置误差 ≤5 mm、姿态误差 ≤0.02 rad，已停稳）" : "Action 成功且已停稳（关节目标误差仅诊断）"), true);
        }
      } else {
        m->settled_at = {};
        if (!m->cancel_requested && !fresh(m->result_at, 3)) {
          m->failed_result = true;
          if (stopped) update(m, "stopping", "执行已结束但目标误差超限，正在确认停稳");
          else cancel(m, "Action 已结束但仍未停稳，请检查现场停止状态");
        }
      }
    } catch (...) { m->settled_at = {}; }
  }
};

PositionMotion::PositionMotion(rclcpp::Node &n, const std::string &joints, const std::string &status, std::shared_ptr<ControllerRegistry> controllers)
    : impl_(std::make_unique<Impl>(n, joints, status, std::move(controllers))) {}
PositionMotion::~PositionMotion() = default;
void PositionMotion::request(uint64_t owner, const Tree &data, Send send) {
  std::lock_guard<std::mutex> lock(impl_->queue_mutex);
  if (impl_->requests.size() >= 64) {
    const auto op = data.get<std::string>("op", "");
    const bool group_op = op == "position_group_start" || op == "position_group_pause" || op == "position_group_resume";
    send("{\"op\":" + quote(group_op ? op + "_ack" : "error") + ",\"request_id\":" + quote(data.get<std::string>("request_id", "")) +
        (group_op ? ",\"accepted\":false,\"command_id\":" + quote(data.get<std::string>("command_id", "")) : "") + ",\"message\":\"运动请求队列已满\"}"); return;
  }
  impl_->requests.push_back({owner, data, std::move(send), false});
}
void PositionMotion::diagnostic(uint64_t owner, const std::string &command, const std::string &phase, const std::string &message) {
  impl_->log(owner, command, phase, message);
}
void PositionMotion::disconnected(uint64_t owner) {
  std::lock_guard<std::mutex> lock(impl_->queue_mutex);
  impl_->requests.push_back({owner, {}, [](const std::string &) {}, true});
}
bool PositionMotion::busy() const { return impl_->in_motion.load(); }
}
