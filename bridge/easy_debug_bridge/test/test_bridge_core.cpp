#include "easy_debug_bridge/bridge_core.hpp"

#include <cassert>
#include <cmath>
#include <cstdint>

using easy_debug_bridge::CommandFields;
using easy_debug_bridge::CommandValidation;

int main() {
  CommandFields command{1, 0.6, 0.2, 80.0, 12.0, 0.5, "ARMED"};
  assert(easy_debug_bridge::validate_command(command) == CommandValidation::Ok);

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
  assert(easy_debug_bridge::is_robot_description_topic("/robot_description"));
  assert(easy_debug_bridge::is_robot_description_topic("/arm/robot_description"));
  assert(!easy_debug_bridge::is_robot_description_topic("/robot_description_semantic"));
  assert(!easy_debug_bridge::is_robot_description_topic("/debug/robot_description_copy"));

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
  return 0;
}
