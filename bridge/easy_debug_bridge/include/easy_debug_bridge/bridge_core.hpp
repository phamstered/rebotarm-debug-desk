#pragma once

#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

namespace easy_debug_bridge {

inline std::string base64_encode(const std::vector<uint8_t> &data) {
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

inline std::vector<uint8_t> binary_image_frame(
    const std::string &metadata_json, const std::vector<uint8_t> &pixels) {
  if (metadata_json.size() > UINT32_MAX) return {};
  const uint32_t metadata_size = static_cast<uint32_t>(metadata_json.size());
  std::vector<uint8_t> frame;
  frame.reserve(8 + metadata_json.size() + pixels.size());
  frame.insert(frame.end(), {'R', 'C', 'I', '1'});
  frame.push_back(static_cast<uint8_t>((metadata_size >> 24) & 0xff));
  frame.push_back(static_cast<uint8_t>((metadata_size >> 16) & 0xff));
  frame.push_back(static_cast<uint8_t>((metadata_size >> 8) & 0xff));
  frame.push_back(static_cast<uint8_t>(metadata_size & 0xff));
  frame.insert(frame.end(), metadata_json.begin(), metadata_json.end());
  frame.insert(frame.end(), pixels.begin(), pixels.end());
  return frame;
}

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

}  // namespace easy_debug_bridge
