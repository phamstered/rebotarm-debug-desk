#include "easy_debug_bridge/bridge_core.hpp"
#include "easy_debug_bridge/position_motion_core.hpp"
#include "easy_debug_bridge/rgbd_core.hpp"

#include <cassert>
#include <cmath>
#include <cstdint>

using easy_debug_bridge::CommandFields;
using easy_debug_bridge::CommandValidation;

int main() {
  {
    using namespace easy_debug_bridge;
    const PositionMotionModel model{{-1, -1, -1, -1, -1, -1}, {1, 1, 1, 1, 1, 1}, {0, 0, 0, 0, 0, 0}};
    assert(arm_joint_set({"joint6", "joint5", "joint4", "joint3", "joint2", "joint1"}));
    assert(!arm_joint_set({"joint1", "joint1", "joint3", "joint4", "joint5", "joint6"}));
    const auto ordered = ordered_arm_values({"joint6", "joint1", "joint2", "joint3", "joint4", "joint5"}, {6, 1, 2, 3, 4, 5});
    assert((ordered == std::vector<double>{1, 2, 3, 4, 5, 6}));
    auto rejected = [](auto operation) { try { operation(); } catch (...) { return true; } return false; };
    assert(rejected([] { ordered_arm_values({"joint1", "joint1"}, {0, 0}); }));
    assert(rejected([] { ordered_arm_values({"joint1"}, {0}); }));
    assert(rejected([&] { validate_position_target({0, 0, 0, 0, 0, 2}, model); }));
    assert(rejected([&] { validate_position_target({0, 0, 0, 0, 0, NAN}, model); }));
    validate_position_target(model.home, model);
    assert(position_target_reached(model.home, model.home, model.home));
    assert(!position_target_reached(model.home, {0, 0, 0, 0, 0, .03}, model.home));
    assert(!position_target_reached(model.home, model.home, {0, 0, 0, 0, 0, .1}));
    assert(!position_target_reached(model.home, model.home, {0, 0, 0, 0, 0, NAN}));
  }

  const auto now = std::chrono::steady_clock::now();
  assert(easy_debug_bridge::should_report_rgbd_tf_failure({}, now));
  assert(!easy_debug_bridge::should_report_rgbd_tf_failure(now - std::chrono::milliseconds(300), now));
  assert(easy_debug_bridge::should_report_rgbd_tf_failure(now - std::chrono::milliseconds(500), now));
  easy_debug_bridge::ImageInterests interests;
  interests.add("/image", 1); interests.add("/image", 1); interests.add("/image", 2);
  assert(interests.clients("/image").size() == 2);
  assert(!interests.remove("/image", 1));
  assert(interests.clients("/image").count(2));
  interests.add("/other_image", 2);
  const auto empty = interests.disconnect(2);
  assert(empty.size() == 2);
  assert(interests.clients("/image").empty());
  assert(!interests.remove("/missing", 1));
  const auto resource = easy_debug_bridge::binary_resource_frame("{}", {1, 2, 3});
  assert(resource.size() == 13 && resource[2] == 'R' && resource[7] == 2 && resource[10] == 1);
  CommandFields command;
  command.mode = 1;
  command.position = 0.6;
  command.velocity = 0.2;
  command.kp = 80.0;
  command.kd = 12.0;
  command.effort = 0.5;
  command.confirmation = "ARMED";
  assert(easy_debug_bridge::validate_command(command) == CommandValidation::Ok);
  assert(easy_debug_bridge::requested_command_mask(command) == 0x01U);

  command.confirmation = "";
  assert(easy_debug_bridge::validate_command(command) == CommandValidation::NotArmed);
  command.confirmation = "ARMED";
  command.mode = 4;
  assert(easy_debug_bridge::validate_command(command) == CommandValidation::InvalidMode);
  command.mode = 1;
  command.position = std::nan("");
  assert(easy_debug_bridge::validate_command(command) == CommandValidation::NonFinite);
  command.position = 0.0;
  command.effort = 1.01;
  assert(easy_debug_bridge::validate_command(command) == CommandValidation::EffortLimit);
  command.effort = 0.5;
  command.mask_specified = true;
  command.requested_joint_mask = 0;
  assert(easy_debug_bridge::validate_command(command) == CommandValidation::EmptyJointMask);
  command.requested_joint_mask = 0x05U;
  command.positions = {0.1, 0.0, 0.2};
  assert(easy_debug_bridge::validate_command(command) == CommandValidation::Ok);
  command.positions[1] = std::nan("");
  assert(easy_debug_bridge::validate_command(command) == CommandValidation::NonFinite);
  command.positions[1] = 0.0;

  assert(easy_debug_bridge::resolve_command_mask(0x01U, 0x01U) == 0x01U);
  assert(easy_debug_bridge::resolve_command_mask(0x05U, 0x01U) == 0);
  assert(easy_debug_bridge::resolve_command_mask(0x05U, 0x07U) == 0x05U);
  assert(easy_debug_bridge::resolve_command_mask(0U, 0xFFU) == 0);

  double position[4] = {9, 9, 9, 9};
  double velocity[4] = {9, 9, 9, 9};
  double kp[4] = {9, 9, 9, 9};
  double kd[4] = {9, 9, 9, 9};
  double effort[4] = {9, 9, 9, 9};
  easy_debug_bridge::fill_joint_command_channels(
      0x05U, command, 4, position, velocity, kp, kd, effort);
  assert(position[0] == 0.1 && position[1] == 0.0 && position[2] == 0.2 && position[3] == 0.0);
  assert(velocity[0] == 0.2 && velocity[1] == 0.0 && velocity[2] == 0.2 && velocity[3] == 0.0);
  assert(kp[0] == 80.0 && kp[2] == 80.0 && kp[1] == 0.0);
  assert(kd[0] == 12.0 && effort[0] == 0.5 && effort[1] == 0.0);

  CommandFields legacy;
  legacy.mode = 1;
  legacy.position = 0.35;
  legacy.velocity = 0.0;
  legacy.kp = 8.0;
  legacy.kd = 2.0;
  legacy.effort = 0.0;
  legacy.confirmation = "ARMED";
  double legacy_position[2] = {};
  double legacy_velocity[2] = {};
  double legacy_kp[2] = {};
  double legacy_kd[2] = {};
  double legacy_effort[2] = {};
  easy_debug_bridge::fill_joint_command_channels(
      0x01U, legacy, 2, legacy_position, legacy_velocity, legacy_kp, legacy_kd, legacy_effort);
  assert(legacy_position[0] == 0.35 && legacy_position[1] == 0.0);
  assert(legacy_kp[0] == 8.0 && legacy_kp[1] == 0.0);

  uint32_t sequence = 41;
  const auto track = easy_debug_bridge::allocate_sequences(sequence, 1);
  assert((track == std::vector<uint32_t>{42}));
  const auto disable = easy_debug_bridge::allocate_sequences(sequence, 3);
  assert((disable == std::vector<uint32_t>{43, 44, 45}));
  assert(sequence == 45);

  assert(easy_debug_bridge::fully_qualified_node_name("/", "controller_manager") ==
         "/controller_manager");
  assert(easy_debug_bridge::fully_qualified_node_name("/robot", "driver") ==
         "/robot/driver");
  assert(easy_debug_bridge::fully_qualified_node_name("robot", "driver") ==
         "/robot/driver");
  assert(easy_debug_bridge::is_valid_graph_name("/stm32/joint_commands"));
  assert(easy_debug_bridge::is_valid_graph_name("/arm/follow_joint_trajectory/_action/status"));
  assert(!easy_debug_bridge::is_valid_graph_name("stm32/joint_commands"));
  assert(!easy_debug_bridge::is_valid_graph_name("/stm32//status"));
  assert(!easy_debug_bridge::is_valid_graph_name("/stm32/status/"));
  assert(!easy_debug_bridge::is_valid_graph_name("/stm32/status;rm"));
  assert(easy_debug_bridge::is_robot_description_topic("/robot_description"));
  assert(easy_debug_bridge::is_robot_description_topic("/arm/robot_description"));
  assert(!easy_debug_bridge::is_robot_description_topic("/robot_description_semantic"));
  assert(!easy_debug_bridge::is_robot_description_topic("/debug/robot_description_copy"));

  const std::filesystem::path package_root("/opt/robot/share/rebotarm_gazebo");
  assert(easy_debug_bridge::package_resource_path(package_root, "meshes/base_link.STL") ==
         package_root / "meshes/base_link.STL");
  assert(easy_debug_bridge::package_resource_path(package_root, "meshes/../textures/base.png") ==
         package_root / "textures/base.png");
  assert(!easy_debug_bridge::package_resource_path(package_root, "../secret.txt"));
  assert(!easy_debug_bridge::package_resource_path(package_root, "/etc/passwd"));
  assert(!easy_debug_bridge::package_resource_path(package_root, "."));

  using easy_debug_bridge::TrajectoryCommand;
  using easy_debug_bridge::TrajectoryPointSpec;
  using easy_debug_bridge::TrajectoryValidation;

  assert(easy_debug_bridge::is_trajectory_topic("/arm/trajectory_controller/joint_trajectory"));
  assert(easy_debug_bridge::is_trajectory_topic("/joint_trajectory"));
  assert(!easy_debug_bridge::is_trajectory_topic("/arm/trajectory_controller/joint_trajectory/"));
  assert(!easy_debug_bridge::is_trajectory_topic("arm/joint_trajectory"));
  assert(!easy_debug_bridge::is_trajectory_topic("/arm//joint_trajectory"));
  assert(!easy_debug_bridge::is_trajectory_topic("/arm/joint trajectory"));
  assert(!easy_debug_bridge::is_trajectory_topic("/stm32/joint_commands"));

  TrajectoryCommand trajectory;
  trajectory.topic = "/arm/trajectory_controller/joint_trajectory";
  trajectory.joint_names = {"joint1", "joint2"};
  trajectory.points = {{ {0.1, 0.2}, {}, 0.1 }, { {0.3, 0.4}, {0.0, 0.0}, 0.5 }};
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::Ok);
  assert(easy_debug_bridge::trajectory_validation_message(TrajectoryValidation::Ok).empty());

  trajectory.topic = "/stm32/joint_commands";
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::InvalidTopic);
  trajectory.topic = "/arm/trajectory_controller/joint_trajectory";

  trajectory.joint_names.clear();
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::EmptyJoints);
  trajectory.joint_names.assign(33, "joint");
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::TooManyJoints);
  trajectory.joint_names = {"joint1", "joint2"};
  trajectory.joint_names[1] = "joint 2";
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::InvalidJointName);
  trajectory.joint_names = {"joint1", "joint1"};
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::DuplicateJointName);
  trajectory.joint_names = {"joint1", "joint2"};

  const auto points = trajectory.points;
  trajectory.points.clear();
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::EmptyPoints);
  trajectory.points.assign(65, TrajectoryPointSpec{{0.0, 0.0}, {}, 1.0});
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::TooManyPoints);

  trajectory.points = {{ {0.1}, {}, 0.1 }, { {0.3, 0.4}, {}, 0.5 }};
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::SizeMismatch);
  trajectory.points = {{ {0.1, 0.2}, {0.0}, 0.1 }, { {0.3, 0.4}, {}, 0.5 }};
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::SizeMismatch);

  trajectory.points = {{ {0.1, std::nan("")}, {}, 0.1 }, { {0.3, 0.4}, {}, 0.5 }};
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::NonFinite);
  trajectory.points = {{ {0.1, 0.2}, {}, 0.0 }, { {0.3, 0.4}, {}, 0.5 }};
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::NonPositiveTime);
  trajectory.points = {{ {0.1, 0.2}, {}, 0.4 }, { {0.3, 0.4}, {}, 0.4 }};
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::NonMonotonicTime);

  trajectory.points = points;
  assert(easy_debug_bridge::validate_trajectory_command(trajectory) == TrajectoryValidation::Ok);
  assert(!easy_debug_bridge::trajectory_validation_message(TrajectoryValidation::SizeMismatch).empty());
  assert(!easy_debug_bridge::trajectory_validation_message(TrajectoryValidation::NonMonotonicTime).empty());

  const auto lead = easy_debug_bridge::duration_fields(0.1);
  assert(lead.first == 0 && lead.second == 100000000);
  const auto total = easy_debug_bridge::duration_fields(1.25);
  assert(total.first == 1 && total.second == 250000000);

  assert(easy_debug_bridge::base64_encode({}) == "");
  assert(easy_debug_bridge::base64_encode({1, 2, 3}) == "AQID");
  assert(easy_debug_bridge::base64_encode({255, 0, 128, 64}) == "/wCAQA==");
  const auto image_frame = easy_debug_bridge::binary_image_frame("{\"width\":2}", {1, 2, 3});
  assert(std::string(image_frame.begin(), image_frame.begin() + 4) == "RCI1");
  assert(image_frame[4] == 0 && image_frame[5] == 0 && image_frame[6] == 0 && image_frame[7] == 11);
  assert(std::string(image_frame.begin() + 8, image_frame.begin() + 19) == "{\"width\":2}");
  assert((std::vector<uint8_t>(image_frame.begin() + 19, image_frame.end()) ==
          std::vector<uint8_t>{1, 2, 3}));
  sequence = UINT32_MAX;
  const auto wrapped = easy_debug_bridge::allocate_sequences(sequence, 1);
  assert(wrapped.front() == 0);

  {
    using easy_debug_bridge::GravityIdGoalFields;
    using easy_debug_bridge::GravityIdGoalValidation;
    GravityIdGoalFields goal;
    goal.confirmation = "ARMED";
    assert(easy_debug_bridge::validate_gravity_id_goal(goal) == GravityIdGoalValidation::Ok);
    assert(easy_debug_bridge::gravity_id_effective_mask(0) == 0x3Fu);
    assert(easy_debug_bridge::gravity_id_effective_mask(0x15) == 0x15u);
    goal.confirmation = "";
    assert(easy_debug_bridge::validate_gravity_id_goal(goal) == GravityIdGoalValidation::NotArmed);
    goal.confirmation = "ARMED";
    goal.mode = 9;
    assert(easy_debug_bridge::validate_gravity_id_goal(goal) == GravityIdGoalValidation::InvalidMode);
    goal.mode = 1;
    assert(easy_debug_bridge::validate_gravity_id_goal(goal) == GravityIdGoalValidation::PayloadRejected);
    goal.mode = 0;
    goal.settle_time_s = std::nan("");
    assert(easy_debug_bridge::validate_gravity_id_goal(goal) == GravityIdGoalValidation::NonFinite);
    goal.settle_time_s = 1.0;
    goal.max_effort_nm = -0.1;
    assert(easy_debug_bridge::validate_gravity_id_goal(goal) == GravityIdGoalValidation::Negative);
    assert(!easy_debug_bridge::gravity_id_goal_validation_message(GravityIdGoalValidation::NotArmed).empty());
  }


  {
    const auto frame = easy_debug_bridge::binary_rgbd_frame("{}", {9, 8, 7});
    assert(frame.size() == 13 && frame[2] == 'D' && frame[10] == 9);
    assert(easy_debug_bridge::bytes_per_pixel("rgb8") == 3);
    assert(easy_debug_bridge::bytes_per_pixel("16UC1") == 2);
    assert(easy_debug_bridge::bytes_per_pixel("32FC1") == 4);
    assert(easy_debug_bridge::stamps_within_tolerance(1, 0, 1, 40'000'000, 50'000'000));
    assert(!easy_debug_bridge::stamps_within_tolerance(1, 0, 1, 60'000'000, 50'000'000));
    const auto size = easy_debug_bridge::choose_preview_size(640, 480, 320, 240);
    assert(size.width == 320 && size.height == 240);
    double k[9] = {200, 0, 100, 0, 200, 50, 0, 0, 1};
    const auto sk = easy_debug_bridge::scale_intrinsics(k, 640, 480, 320, 240);
    assert(std::abs(sk[0] - 100.0) < 1e-9);
    assert(std::abs(sk[2] - 50.0) < 1e-9);
    // 2x2 rgb8 → 1x1 nearest
    const uint8_t src[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12};
    const auto ds = easy_debug_bridge::downsample_image_nn(
        src, sizeof(src), 2, 2, 6, "rgb8", 0, 1, 1);
    assert(ds && ds->width == 1 && ds->height == 1 && ds->data.size() == 3);
    assert(ds->data[0] == 1 && ds->data[1] == 2 && ds->data[2] == 3);
    // Truncated buffer: step ok but nbytes < h*step → reject (no OOB)
    const auto truncated = easy_debug_bridge::downsample_image_nn(
        src, 6, 2, 2, 6, "rgb8", 0, 1, 1);
    assert(!truncated);
    easy_debug_bridge::LatestFrameGroupQueue<int> queue;
    queue.push(1);
    queue.push(2);
    assert(queue.dropped_count() == 1);
    const auto taken = queue.take();
    assert(taken && *taken == 2);
  }

  return 0;
}
