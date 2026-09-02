#include "easy_debug_bridge/bridge_core.hpp"

#include <cassert>
#include <cmath>
#include <cstdint>

using easy_debug_bridge::CommandFields;
using easy_debug_bridge::CommandValidation;
using easy_debug_bridge::trajectory_point_json;

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

  assert(trajectory_point_json(
      {0.1, -0.2}, {1.5}, {2.5}, {}, 3, 400000000) ==
      "{\"positions\":[0.1,-0.2],\"velocities\":[1.5],\"accelerations\":[2.5],"
      "\"effort\":[],\"time_from_start\":{\"sec\":3,\"nanosec\":400000000}}");

  sequence = UINT32_MAX;
  const auto wrapped = easy_debug_bridge::allocate_sequences(sequence, 1);
  assert(wrapped.front() == 0);
  return 0;
}
