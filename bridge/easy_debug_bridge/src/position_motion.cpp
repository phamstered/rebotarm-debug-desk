#include "easy_debug_bridge/position_motion.hpp"
#include "easy_debug_bridge/position_motion_model.hpp"
#include "easy_debug_bridge/position_motion_core.hpp"
#include "easy_debug_bridge/motion_timing.hpp"
#include <rclcpp_action/rclcpp_action.hpp>
#include <rclcpp/parameter_client.hpp>
#include <moveit_msgs/action/move_group.hpp>
#include <moveit_msgs/action/execute_trajectory.hpp>
#include <controller_manager_msgs/srv/list_controllers.hpp>
#include <control_msgs/msg/joint_trajectory_controller_state.hpp>
#include <sensor_msgs/msg/joint_state.hpp>
#include <microros_stm32h723_bridge/msg/hardware_status.hpp>
#include <deque>
#include <mutex>
#include <set>
#include <atomic>

namespace easy_debug_bridge {
namespace {
using Clock = std::chrono::steady_clock;
using Group = moveit_msgs::action::MoveGroup;
using Handle = rclcpp_action::ClientGoalHandle<Group>;
using Execute = moveit_msgs::action::ExecuteTrajectory;
using ExecuteHandle = rclcpp_action::ClientGoalHandle<Execute>;
using Controllers = controller_manager_msgs::srv::ListControllers;
using Joints = sensor_msgs::msg::JointState;
using State = control_msgs::msg::JointTrajectoryControllerState;
using Hardware = microros_stm32h723_bridge::msg::HardwareStatus;
using Tree = boost::property_tree::ptree;
const std::string controller = "arm_trajectory_controller";
std::string quote(const std::string &value) { return position_json_quote(value); }
std::string numbers(const std::vector<double> &values) {
  std::ostringstream out; out << '[' << std::setprecision(17);
  for (size_t i = 0; i < values.size(); ++i) { if (i) out << ','; out << values[i]; }
  return out.str() + ']';
}
bool fresh(Clock::time_point at, double seconds = 1.0) {
  return at != Clock::time_point{} && std::chrono::duration<double>(Clock::now() - at).count() < seconds;
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
  struct Motion {
    uint64_t owner{}; std::string id, label, phase{"validating"}, message;
    std::vector<double> target; Send send; Handle::SharedPtr handle;
    ExecuteHandle::SharedPtr execution_handle;
    std::vector<size_t> held_axes;
    double duration{0}, recommended_duration{0};
    Clock::time_point started{Clock::now()}, lease_at{Clock::now()}, result_at{}, settled_at{}, cancel_at{};
    bool cancel_requested{false}, terminal{false};
    int code{0}; bool failed_result{false};
  };
  rclcpp::Node &node;
  std::mutex queue_mutex; std::deque<Request> requests;
  std::atomic<bool> in_motion{false};
  rclcpp_action::Client<Group>::SharedPtr action;
  rclcpp_action::Client<Execute>::SharedPtr execute_action;
  double start_tolerance{.01};
  std::vector<double> velocity_limits, acceleration_limits;
  rclcpp::Client<Controllers>::SharedPtr controllers;
  std::shared_ptr<rclcpp::AsyncParametersClient> parameters;
  rclcpp::Subscription<Joints>::SharedPtr joints_sub;
  rclcpp::Subscription<State>::SharedPtr state_sub;
  rclcpp::Subscription<Hardware>::SharedPtr hardware_sub;
  rclcpp::TimerBase::SharedPtr timer;
  Joints joints; State state; Hardware hardware;
  Clock::time_point joints_at{}, state_at{}, hardware_at{}, controller_at{}, controller_request_at{}, model_at{}, model_request_at{};
  bool controller_pending{false}, controller_active{false}, model_pending{false};
  int64_t controller_request_id{0}; uint64_t controller_generation{0}, model_generation{0};
  std::string model_error{"等待 MoveIt 模型"}, model_signature;
  std::string controller_error{"arm_trajectory_controller 未激活或状态已过期"};
  PositionMotionModel model;
  std::shared_ptr<Motion> current;
  std::deque<std::pair<std::string, uint64_t>> seen;

  Impl(rclcpp::Node &n, const std::string &joint_topic, const std::string &status_topic) : node(n) {
    action = rclcpp_action::create_client<Group>(node.get_node_base_interface(), node.get_node_graph_interface(),
        node.get_node_logging_interface(), node.get_node_waitables_interface(), "/move_action");
    execute_action = rclcpp_action::create_client<Execute>(node.get_node_base_interface(), node.get_node_graph_interface(),
        node.get_node_logging_interface(), node.get_node_waitables_interface(), "/execute_trajectory");
    controllers = node.create_client<Controllers>("/controller_manager/list_controllers");
    parameters = std::make_shared<rclcpp::AsyncParametersClient>(&node, "/move_group");
    const auto qos = rclcpp::QoS(10).best_effort();
    joints_sub = node.create_subscription<Joints>(joint_topic, qos, [this](Joints::ConstSharedPtr m) { joints = *m; joints_at = Clock::now(); });
    hardware_sub = node.create_subscription<Hardware>(status_topic, qos, [this](Hardware::ConstSharedPtr m) { hardware = *m; hardware_at = Clock::now(); });
    state_sub = node.create_subscription<State>("/" + controller + "/controller_state", qos, [this](State::ConstSharedPtr m) { state = *m; state_at = Clock::now(); });
    timer = node.create_wall_timer(std::chrono::milliseconds(100), [this] { tick(); });
  }
  std::string event(const Motion &m) const {
    return "{\"op\":\"position_motion\",\"command_id\":" + quote(m.id) + ",\"label\":" + quote(m.label) +
        ",\"motion_phase\":" + quote(m.phase) + ",\"message\":" + quote(m.message) + ",\"code\":" + std::to_string(m.code) +
        ",\"recommended_duration_s\":" + std::to_string(m.recommended_duration) + ",\"elapsed_s\":" + std::to_string(std::chrono::duration<double>(Clock::now()-m.started).count()) + "}";
  }
  void update(const std::shared_ptr<Motion> &m, const std::string &phase, const std::string &message, bool terminal = false) {
    m->phase = phase; m->message = message; m->terminal = terminal;
    m->send(event(*m));
    if (terminal && current == m) in_motion.store(false);
  }
  void error(const Request &r, const std::string &message) {
    r.send("{\"op\":\"error\",\"request_id\":" + quote(r.data.get<std::string>("request_id", "")) + ",\"message\":" + quote(message) + "}");
  }
  void poll_controllers() {
    if (controller_pending) {
      if (fresh(controller_request_at, 2)) return;
      controllers->remove_pending_request(controller_request_id);
      controller_pending = false; controller_active = false;
    }
    if (!controllers->service_is_ready()) return;
    controller_pending = true; controller_request_at = Clock::now();
    const auto generation = ++controller_generation;
    controller_request_id = controllers->async_send_request(std::make_shared<Controllers::Request>(), [this, generation](rclcpp::Client<Controllers>::SharedFuture future) {
      if (generation != controller_generation) return;
      controller_pending = false; controller_active = false;
      try {
        controller_error = "arm_trajectory_controller 未激活或状态已过期";
        for (const auto &c : future.get()->controller) if (c.name == controller && c.state == "active"
            && c.type == "joint_trajectory_controller/JointTrajectoryController") {
          if (!arm_position_velocity_claimed(c.claimed_interfaces))
            controller_error = "轨迹控制器必须认领六关节 position+velocity 接口，请更新控制栈并重新启用轨迹控制";
          else { controller_active = true; controller_error.clear(); }
        }
        controller_at = Clock::now();
      } catch (...) { controller_at = {}; }
    }).request_id;
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
    return keys;
  }
  void poll_model() {
    if (model_pending) {
      if (fresh(model_request_at, 3)) return;
      model_pending = false; model_error = "MoveIt 模型查询超时"; model_at = {};
      parameters = std::make_shared<rclcpp::AsyncParametersClient>(&node, "/move_group");
    }
    if (!parameters->service_is_ready()) return;
    model_pending = true; model_request_at = Clock::now();
    const auto generation = ++model_generation;
    parameters->get_parameters(model_keys(), [this, generation](std::shared_future<std::vector<rclcpp::Parameter>> future) {
      if (generation != model_generation) return;
      model_pending = false;
      try {
        auto p = future.get();
        if (p.size() != 33 || p[2].as_bool()) throw std::runtime_error("MoveIt 必须配置 moveit_manage_controllers=false");
        if (p[3].as_string_array() != std::vector<std::string>{controller} || !arm_joint_set(p[4].as_string_array()))
          throw std::runtime_error("MoveIt 只能配置真实 arm_trajectory_controller 六关节");
        const auto configured_start_tolerance = p[5].as_double();
        if (!std::isfinite(configured_start_tolerance) || configured_start_tolerance <= 0 || configured_start_tolerance > 0.02)
          throw std::runtime_error("MoveIt 起点容差必须在 (0, 0.02] rad");
        if (p[6].as_string() != "moveit_simple_controller_manager/MoveItSimpleControllerManager"
            || p[7].as_string() != "FollowJointTrajectory" || p[8].as_string() != "follow_joint_trajectory")
          throw std::runtime_error("MoveIt 执行控制器 Action 配置不匹配");
        for (size_t i = 9; i < p.size(); i += 4) {
          const double velocity = p[i].as_double(), acceleration = p[i+1].as_double();
          if (!std::isfinite(velocity) || velocity <= 0 || velocity > 1 || !std::isfinite(acceleration)
              || acceleration <= 0 || acceleration > 1 || !p[i+2].as_bool() || !p[i+3].as_bool())
            throw std::runtime_error("MoveIt 必须启用不超过 1 rad/s、1 rad/s² 的速度/加速度限幅，请使用 real_move_group.launch.py");
        }
        velocity_limits.clear(); acceleration_limits.clear();
        for (size_t i=9;i<p.size();i+=4) { velocity_limits.push_back(p[i].as_double()); acceleration_limits.push_back(p[i+1].as_double()); }
        auto parsed = position_motion_model(p[0].as_string(), p[1].as_string());
        std::string signature;
        for (const auto &value : p) signature += value.value_to_string();
        if (current && !current->terminal && !model_signature.empty() && signature != model_signature)
          cancel(current, "MoveIt 模型或配置改变，已请求取消");
        start_tolerance = configured_start_tolerance;
        model = std::move(parsed); model_signature = std::move(signature); model_error.clear(); model_at = Clock::now();
      } catch (const std::exception &e) { model_error = std::string("MoveIt 配置不可用：") + e.what(); model_at = {}; }
    });
  }
  std::string readiness(bool starting = true) {
    if (!action->action_server_is_ready()) return "MoveIt /move_action 未启动，请启动 real_move_group.launch.py";
    if (!fresh(model_at, 10) || !model_error.empty()) return model_error.empty() ? "MoveIt 模型信息已过期" : model_error;
    if (!fresh(controller_at)) return "arm_trajectory_controller 状态已过期";
    if (!controller_active) return controller_error;
    if (!fresh(joints_at) || !fresh(state_at) || !fresh(hardware_at)) return "JointState、控制器或硬件反馈缺失/已过期";
    if (hardware.mode != Hardware::MODE_TRACK || hardware.fault_code != 0 || (hardware.active_joint_mask & 0x3f) != 0x3f) return "硬件未处于 TRACK、存在故障或六关节未全部使能";
    if (!arm_joint_set(state.joint_names)) return "轨迹控制器关节集合与 arm 不匹配";
    try {
      const auto actual = ordered_arm_values(joints.name, joints.position);
      const auto velocity = ordered_arm_values(joints.name, joints.velocity);
      const auto control = ordered_arm_values(state.joint_names, state.actual.positions);
      validate_position_target(actual, model);
      for (size_t i = 0; i < 6; ++i) {
        if (std::abs(actual[i] - control[i]) > 0.02) return "控制器反馈与 STM32 不一致";
        if (starting && std::abs(velocity[i]) > 0.05) return "机械臂尚未停稳";
      }
    } catch (const std::exception &e) { return e.what(); }
    return "";
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
    update(m, "canceling", message);
    request_cancel_handle(m);
  }
  void move(const Request &r) {
    const auto id = r.data.get<std::string>("command_id", "");
    if (id.empty() || id.size() > 80 || id.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-") != std::string::npos)
      throw std::runtime_error("command_id 无效");
    if (r.data.get<std::string>("confirmation", "") != "ARMED") throw std::runtime_error("请先确认工作区安全并解锁点位执行");
    for (const auto &old : seen) if (old.first == id) {
      if (current && current->id == id && current->owner == r.owner) {
        r.send("{\"op\":\"position_move_ack\",\"accepted\":true,\"request_id\":" + quote(r.data.get<std::string>("request_id", "")) + ",\"command_id\":" + quote(id) + "}");
        r.send(event(*current)); return;
      }
      throw std::runtime_error("重复的运动 command_id，未重复执行");
    }
    if (current && !current->terminal) throw std::runtime_error("已有点位运动，等待完成或取消确认后再试");
    const auto reason = readiness(); if (!reason.empty()) throw std::runtime_error(reason);
    const auto rotation_joint = r.data.get_optional<std::string>("joint_name");
    const auto joint_targets = r.data.get_child_optional("joint_targets");
    const auto actual = ordered_arm_values(joints.name, joints.position);
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
    auto target = joint_targets || rotation_joint ? combined_joint_target(actual, edits, model)
      : r.data.get<bool>("home", false) ? model.home : read_values(r.data);
    double duration = 0;
    if (r.data.get_child_optional("motion_duration_s")) {
      duration = r.data.get<double>("motion_duration_s"); validate_motion_duration(duration);
      if (!execute_action->action_server_is_ready()) throw std::runtime_error("MoveIt /execute_trajectory 未启动");
    }
    validate_position_target(target, model);
    auto m = std::make_shared<Motion>(); m->owner = r.owner; m->id = id;
    m->label = r.data.get<bool>("home", false) ? "HOME" : r.data.get<std::string>("label", "位置");
    if (m->label.size() > 512) throw std::runtime_error("点位名称过长");
    m->target = target; m->send = r.send; m->duration = duration;
    current = m; in_motion.store(true);
    seen.emplace_back(id, r.owner); if (seen.size() > 256) seen.pop_front();
    Group::Goal goal;
    goal.request.group_name = "arm"; goal.request.pipeline_id = "ompl";
    goal.request.allowed_planning_time = 5; goal.request.num_planning_attempts = 1;
    goal.request.max_velocity_scaling_factor = 1.0; goal.request.max_acceleration_scaling_factor = 1.0;
    goal.request.start_state.is_diff = true;
    goal.request.start_state.joint_state.name = arm_motion_joints();
    goal.request.start_state.joint_state.position = actual;
    goal.request.start_state.joint_state.header.stamp = node.now();
    moveit_msgs::msg::Constraints constraints;
    for (size_t i = 0; i < 6; ++i) {
      moveit_msgs::msg::JointConstraint c; c.joint_name = arm_motion_joints()[i]; c.position = target[i];
      c.tolerance_above = c.tolerance_below = 0.005; c.weight = 1; constraints.joint_constraints.push_back(c);
      if ((joint_targets || rotation_joint) && std::none_of(edits.begin(), edits.end(),
          [&](const auto &edit) { return edit.first == c.joint_name; })) {
        c.position = actual[i];
        c.tolerance_above = c.tolerance_below = joint_rotation_hold_tolerance;
        goal.request.path_constraints.joint_constraints.push_back(c);
        m->held_axes.push_back(i);
      }
    }
    goal.request.goal_constraints.push_back(constraints);
    goal.planning_options.plan_only = duration > 0; goal.planning_options.replan = false;
    goal.planning_options.planning_scene_diff.is_diff = true;
    goal.planning_options.planning_scene_diff.robot_state.is_diff = true;
    r.send("{\"op\":\"position_move_ack\",\"request_id\":" + quote(r.data.get<std::string>("request_id", "")) +
        ",\"command_id\":" + quote(id) + "}");
    update(m, "planning", "MoveIt2 正在规划（自碰撞和已知环境碰撞检查）");
    rclcpp_action::Client<Group>::SendGoalOptions options;
    options.goal_response_callback = [this, m](Handle::SharedPtr handle) {
      m->handle = handle;
      if (!handle) { update(m, "failed", "MoveIt 拒绝目标", true); return; }
      if (m->cancel_requested) request_cancel_handle(m);
    };
    options.feedback_callback = [this, m](Handle::SharedPtr, const std::shared_ptr<const Group::Feedback> f) {
      if (m->terminal || m->cancel_requested) return;
      const bool executing = m->duration == 0 && (f->state.find("MONITOR") != std::string::npos || f->state.find("EXECUT") != std::string::npos);
      update(m, executing ? "executing" : "planning", "MoveIt：" + f->state);
    };
    options.result_callback = [this, m](const Handle::WrappedResult &result) {
      m->handle.reset();
      if (m->duration > 0 && !m->cancel_requested && result.code == rclcpp_action::ResultCode::SUCCEEDED &&
          result.result && result.result->error_code.val == 1) {
        try { execute_plan(m, result.result->planned_trajectory); }
        catch (const std::exception &e) { update(m, "failed", e.what(), true); }
        return;
      }
      finish_result(m, result.code, result.result ? result.result->error_code.val : 0);
    };
    try { action->async_send_goal(goal, options); }
    catch (const std::exception &e) { update(m, "failed", e.what(), true); }
  }
  void finish_result(const std::shared_ptr<Motion> &m, rclcpp_action::ResultCode code, int error_code) {
      if (m->terminal) return;
      m->result_at = Clock::now(); m->code = error_code;
      if (m->cancel_requested) { update(m, "stopping", "MoveIt 已返回，等待关节停稳"); return; }
      if (code != rclcpp_action::ResultCode::SUCCEEDED || m->code != 1) {
        m->failed_result = true; update(m, "stopping", "MoveIt 规划/执行失败，error_code=" + std::to_string(m->code) + "；等待停稳确认"); return;
      }
      update(m, "verifying", "执行 Action 成功，正在核对实际到位反馈");
  }
  void execute_plan(const std::shared_ptr<Motion> &m, const moveit_msgs::msg::RobotTrajectory &plan) {
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
    if (!fresh(m->lease_at, 5)) throw std::runtime_error("会话心跳已过期，未执行规划轨迹");
    if (!execute_action->action_server_is_ready()) throw std::runtime_error("MoveIt /execute_trajectory 未启动");
    if (!arm_joint_set(plan.joint_trajectory.joint_names) || !plan.multi_dof_joint_trajectory.points.empty() ||
        !plan.multi_dof_joint_trajectory.joint_names.empty()) throw std::runtime_error("规划轨迹必须仅包含 arm 六关节");
    const auto &names = plan.joint_trajectory.joint_names;
    if (plan.joint_trajectory.points.size() < 2 || plan.joint_trajectory.points.size() > 10000)
      throw std::runtime_error("规划轨迹点数无效");
    std::vector<TimedMotionPoint> points;
    for (const auto &point : plan.joint_trajectory.points) {
      if (point.time_from_start.nanosec >= 1000000000) throw std::runtime_error("规划轨迹时间无效");
      points.push_back({ordered_arm_values(names, point.positions),
          point.velocities.empty() ? std::vector<double>{} : ordered_arm_values(names, point.velocities),
          point.accelerations.empty() ? std::vector<double>{} : ordered_arm_values(names, point.accelerations),
          point.effort.empty() ? std::vector<double>{} : ordered_arm_values(names, point.effort),
          static_cast<int64_t>(point.time_from_start.sec) * 1000000000 + point.time_from_start.nanosec});
    }
    if (!points.empty()) { m->recommended_duration=points.back().time_ns/1e9; update(m,"planning","MoveIt 推荐运动时长："+std::to_string(m->recommended_duration)+" 秒（仅供参考）"); }
    points = stretch_motion(std::move(points), m->duration, model, velocity_limits, acceleration_limits);
    const auto actual = ordered_arm_values(joints.name, joints.position);
    for (size_t i = 0; i < 6; ++i) {
      if (std::abs(points.front().positions[i] - actual[i]) > start_tolerance)
        throw std::runtime_error("规划后实测起点已变化，请重新规划");
      if (std::abs(points.back().positions[i] - m->target[i]) > .005 + 1e-9)
        throw std::runtime_error("规划轨迹终点与目标不匹配");
    }
    for (const auto &point : points) for (const auto i : m->held_axes)
      if (std::abs(point.positions[i] - m->target[i]) > joint_rotation_hold_tolerance + 1e-9)
        throw std::runtime_error("规划轨迹不满足未编辑关节的保持约束");
    Execute::Goal goal;
    goal.trajectory.joint_trajectory.joint_names = arm_motion_joints();
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
    options.goal_response_callback = [this, m](ExecuteHandle::SharedPtr handle) {
      m->execution_handle = handle;
      if (!handle) { finish_result(m, rclcpp_action::ResultCode::ABORTED, 0); return; }
      if (m->cancel_requested) request_cancel_handle(m);
      else update(m, "executing", "按指定运动时长执行：" + std::to_string(m->duration) + " 秒");
    };
    options.result_callback = [this, m](const ExecuteHandle::WrappedResult &result) {
      m->execution_handle.reset();
      finish_result(m, result.code, result.result ? result.result->error_code.val : 0);
    };
    update(m, "planning", "规划完成，等待 MoveIt 执行调整后的完整轨迹");
    try { execute_action->async_send_goal(goal, options); }
    catch (const std::exception &e) {
      m->cancel_requested = true; m->cancel_at = Clock::now();
      update(m, "stop_failed", std::string("轨迹受理状态未确认，保持锁定：") + e.what());
    }
  }
  void process(const Request &r) {
    if (r.disconnect) { if (current && (r.owner == 0 || current->owner == r.owner)) cancel(current, r.owner == 0 ? "已请求 DISABLE，取消点位运动" : "连接已断开，已请求取消"); return; }
    const auto op = r.data.get<std::string>("op", "");
    if (op == "position_motion_info") {
      if (current && current->owner == r.owner && !current->terminal) current->lease_at = Clock::now();
      const auto reason = readiness();
      const bool home = fresh(model_at, 10) && model.home.size() == 6 && model_error.empty();
      r.send("{\"op\":\"position_motion_info\",\"request_id\":" + quote(r.data.get<std::string>("request_id", "")) +
          ",\"available\":" + (reason.empty() ? "true" : "false") + ",\"message\":" + quote(reason) +
          ",\"joint_rotation_supported\":true,\"joint_targets_supported\":true,\"motion_duration_supported\":true" +
          ",\"motion_duration_message\":" + quote(execute_action->action_server_is_ready() ? "" : "MoveIt /execute_trajectory 未启动") +
          ",\"command_id\":" + quote(current && current->owner == r.owner ? current->id : "") +
          ",\"busy\":" + ((current && !current->terminal) ? "true" : "false") +
          ",\"home_positions\":" + (home ? numbers(model.home) : "[]") + "}");
      if (current && current->owner == r.owner) r.send(event(*current));
    } else if (op == "position_move") move(r);
    else if (op == "position_cancel") {
      if (!current || current->owner != r.owner || current->id != r.data.get<std::string>("command_id", ""))
        throw std::runtime_error("本会话没有对应的运动");
      cancel(current, "用户请求取消，等待停止确认");
      r.send("{\"op\":\"position_cancel_ack\",\"request_id\":" + quote(r.data.get<std::string>("request_id", "")) + "}");
    }
  }
  void tick() {
    if (!fresh(controller_request_at, 0.4)) poll_controllers();
    if (!fresh(model_request_at, 3)) poll_model();
    std::deque<Request> pending;
    { std::lock_guard<std::mutex> lock(queue_mutex); pending.swap(requests); }
    for (const auto &r : pending) try { process(r); } catch (const std::exception &e) {
      if (r.data.get<std::string>("op", "") == "position_move")
        r.send("{\"op\":\"position_move_ack\",\"accepted\":false,\"request_id\":" + quote(r.data.get<std::string>("request_id", "")) +
          ",\"command_id\":" + quote(r.data.get<std::string>("command_id", "")) + ",\"message\":" + quote(e.what()) + "}");
      else error(r, e.what());
    }
    const auto m = current;
    if (!m || m->terminal) return;
    if (!m->cancel_requested) {
      const auto reason = readiness(false);
      if (!reason.empty()) cancel(m, reason + "，已请求取消");
      if (!fresh(m->started, std::max(180.,m->duration+60.))) cancel(m, "运动超时，已请求取消");
      if (!fresh(m->lease_at, 5)) cancel(m, "会话心跳超过 5 秒，已请求取消");
    }
    if (m->cancel_requested && !fresh(m->cancel_at, 5) && m->phase != "stop_failed")
      update(m, "stop_failed", "停止未确认；保留控制进程，请检查现场并使用既有安全停机入口");
    if (!m->result_at.time_since_epoch().count() || !fresh(joints_at) || joints_at < m->result_at) return;
    try {
      const auto actual = ordered_arm_values(joints.name, joints.position), velocity = ordered_arm_values(joints.name, joints.velocity);
      const bool stopped = std::all_of(velocity.begin(), velocity.end(), [](double v) { return std::abs(v) <= 0.03; });
      const bool reached = position_target_reached(m->target, actual, velocity);
      if (((m->cancel_requested || m->failed_result) && stopped) || (m->phase == "verifying" && reached)) {
        if (m->settled_at == Clock::time_point{}) m->settled_at = Clock::now();
        if (!fresh(m->settled_at, 0.2)) update(m, m->cancel_requested ? "canceled" : m->failed_result ? "failed" : "succeeded",
            m->cancel_requested ? "已取消且确认关节停稳" : m->failed_result ? (m->code == 1 ? "执行已结束但未到达目标，已确认停稳" : "MoveIt 失败（error_code=" + std::to_string(m->code) + "），已确认停稳") : "已到达目标点位（六关节误差 ≤0.02 rad，已停稳）", true);
      } else {
        m->settled_at = {};
        if (!m->cancel_requested && !fresh(m->result_at, 3)) {
          m->failed_result = true;
          if (stopped) update(m, "stopping", "执行已结束但目标误差超限，正在确认停稳");
          else cancel(m, "Action 已结束但仍未停稳，请检查现场停止状态");
        }
      }
    } catch (...) {}
  }
};

PositionMotion::PositionMotion(rclcpp::Node &n, const std::string &joints, const std::string &status)
    : impl_(std::make_unique<Impl>(n, joints, status)) {}
PositionMotion::~PositionMotion() = default;
void PositionMotion::request(uint64_t owner, const Tree &data, Send send) {
  std::lock_guard<std::mutex> lock(impl_->queue_mutex);
  if (impl_->requests.size() >= 64) {
    send("{\"op\":\"error\",\"request_id\":" + quote(data.get<std::string>("request_id", "")) + ",\"message\":\"运动请求队列已满\"}"); return;
  }
  impl_->requests.push_back({owner, data, std::move(send), false});
}
void PositionMotion::disconnected(uint64_t owner) {
  std::lock_guard<std::mutex> lock(impl_->queue_mutex);
  impl_->requests.push_back({owner, {}, [](const std::string &) {}, true});
}
bool PositionMotion::busy() const { return impl_->in_motion.load(); }
}
