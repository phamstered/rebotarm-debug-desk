#pragma once

#include <cmath>
#include <cstdint>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>

namespace easy_debug_bridge {

struct CommandFields {
  int mode;
  double position;
  double velocity;
  double kp;
  double kd;
  double effort;
  std::string confirmation;
};

enum class CommandValidation { Ok, InvalidMode, NotArmed, NonFinite, EffortLimit };

inline CommandValidation validate_command(const CommandFields &command) {
  if (command.mode < 0 || command.mode > 3) return CommandValidation::InvalidMode;
  if (command.mode != 3 && command.confirmation != "ARMED") return CommandValidation::NotArmed;
  if (!std::isfinite(command.position) || !std::isfinite(command.velocity) ||
      !std::isfinite(command.kp) || !std::isfinite(command.kd) ||
      !std::isfinite(command.effort)) return CommandValidation::NonFinite;
  if (std::abs(command.effort) > 1.0) return CommandValidation::EffortLimit;
  return CommandValidation::Ok;
}

inline std::vector<uint32_t> allocate_sequences(uint32_t &current, unsigned count) {
  std::vector<uint32_t> values;
  values.reserve(count);
  for (unsigned index = 0; index < count; ++index) values.push_back(++current);
  return values;
}

inline std::string fully_qualified_node_name(const std::string &node_namespace,
                                             const std::string &node_name) {
  std::string result = node_namespace.empty() ? "/" : node_namespace;
  if (result.front() != '/') result.insert(result.begin(), '/');
  if (result.back() != '/') result.push_back('/');
  result += node_name;
  while (result.size() > 1 && result.back() == '/') result.pop_back();
  return result;
}

inline std::string trajectory_point_json(
    const std::vector<double> &positions,
    const std::vector<double> &velocities,
    const std::vector<double> &accelerations,
    const std::vector<double> &effort,
    int32_t seconds,
    uint32_t nanoseconds) {
  const auto array_json = [](const std::vector<double> &values) {
    std::ostringstream out;
    out << '[';
    for (size_t index = 0; index < values.size(); ++index) {
      if (index) out << ',';
      out << std::setprecision(15) << values[index];
    }
    out << ']';
    return out.str();
  };
  return "{\"positions\":" + array_json(positions) +
         ",\"velocities\":" + array_json(velocities) +
         ",\"accelerations\":" + array_json(accelerations) +
         ",\"effort\":" + array_json(effort) +
         ",\"time_from_start\":{\"sec\":" + std::to_string(seconds) +
         ",\"nanosec\":" + std::to_string(nanoseconds) + "}}";
}

}  // namespace easy_debug_bridge
