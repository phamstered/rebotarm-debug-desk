#include "easy_debug_bridge/generic_message.hpp"

#include <cmath>
#include <codecvt>
#include <cstdint>
#include <iomanip>
#include <limits>
#include <locale>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>

#include <rclcpp/typesupport_helpers.hpp>
#include <rmw/rmw.h>
#include <rosidl_runtime_cpp/message_initialization.hpp>
#include <rosidl_typesupport_introspection_cpp/field_types.hpp>
#include <rosidl_typesupport_introspection_cpp/identifier.hpp>

namespace easy_debug_bridge {
namespace {

using rosidl_typesupport_introspection_cpp::MessageMember;
using rosidl_typesupport_introspection_cpp::MessageMembers;

std::string quote(const std::string &value) {
  std::ostringstream out;
  out << '"';
  for (unsigned char character : value) {
    switch (character) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\b': out << "\\b"; break;
      case '\f': out << "\\f"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (character < 0x20) {
          out << "\\u" << std::hex << std::setw(4) << std::setfill('0')
              << static_cast<unsigned>(character) << std::dec;
        } else {
          out << character;
        }
    }
  }
  out << '"';
  return out.str();
}

template<typename Value>
std::string floating_json(Value value) {
  if (!std::isfinite(value)) return "null";
  std::ostringstream out;
  out << std::setprecision(std::numeric_limits<Value>::max_digits10) << value;
  return out.str();
}

const MessageMembers *nested_members(const MessageMember &member) {
  if (!member.members_ || !member.members_->data) {
    throw std::runtime_error(std::string("嵌套消息缺少 introspection：") + member.name_);
  }
  return static_cast<const MessageMembers *>(member.members_->data);
}

std::string message_json(const MessageMembers &members, const void *message);

std::string scalar_json(uint8_t type, const MessageMember &member, const void *value) {
  using namespace rosidl_typesupport_introspection_cpp;
  switch (type) {
    case ROS_TYPE_FLOAT32: return floating_json(*static_cast<const float *>(value));
    case ROS_TYPE_FLOAT64: return floating_json(*static_cast<const double *>(value));
    case ROS_TYPE_LONG_DOUBLE: return floating_json(*static_cast<const long double *>(value));
    case ROS_TYPE_CHAR:
    case ROS_TYPE_OCTET:
    case ROS_TYPE_UINT8: return std::to_string(*static_cast<const uint8_t *>(value));
    case ROS_TYPE_INT8: return std::to_string(*static_cast<const int8_t *>(value));
    case ROS_TYPE_WCHAR:
    case ROS_TYPE_UINT16: return std::to_string(*static_cast<const uint16_t *>(value));
    case ROS_TYPE_INT16: return std::to_string(*static_cast<const int16_t *>(value));
    case ROS_TYPE_UINT32: return std::to_string(*static_cast<const uint32_t *>(value));
    case ROS_TYPE_INT32: return std::to_string(*static_cast<const int32_t *>(value));
    // JSON/JavaScript cannot represent every 64-bit integer exactly. Strings preserve ROS data.
    case ROS_TYPE_UINT64: return quote(std::to_string(*static_cast<const uint64_t *>(value)));
    case ROS_TYPE_INT64: return quote(std::to_string(*static_cast<const int64_t *>(value)));
    case ROS_TYPE_BOOLEAN: return *static_cast<const bool *>(value) ? "true" : "false";
    case ROS_TYPE_STRING: return quote(*static_cast<const std::string *>(value));
    case ROS_TYPE_WSTRING: {
      const auto &wide = *static_cast<const std::u16string *>(value);
      std::wstring_convert<std::codecvt_utf8_utf16<char16_t>, char16_t> converter;
      return quote(converter.to_bytes(wide));
    }
    case ROS_TYPE_MESSAGE: return message_json(*nested_members(member), value);
    default: throw std::runtime_error(
      "不支持的 introspection 字段类型：" + std::to_string(type));
  }
}

std::string fetched_array_element(const MessageMember &member, const void *field, size_t index) {
  using namespace rosidl_typesupport_introspection_cpp;
  if (member.get_const_function) {
    return scalar_json(member.type_id_, member, member.get_const_function(field, index));
  }
  if (!member.fetch_function) {
    throw std::runtime_error(std::string("数组字段无法读取：") + member.name_);
  }
  switch (member.type_id_) {
    case ROS_TYPE_BOOLEAN: {
      bool value{}; member.fetch_function(field, index, &value); return value ? "true" : "false";
    }
    case ROS_TYPE_FLOAT32: {
      float value{}; member.fetch_function(field, index, &value); return floating_json(value);
    }
    case ROS_TYPE_FLOAT64: {
      double value{}; member.fetch_function(field, index, &value); return floating_json(value);
    }
    case ROS_TYPE_LONG_DOUBLE: {
      long double value{}; member.fetch_function(field, index, &value); return floating_json(value);
    }
    case ROS_TYPE_CHAR:
    case ROS_TYPE_OCTET:
    case ROS_TYPE_UINT8: {
      uint8_t value{}; member.fetch_function(field, index, &value); return std::to_string(value);
    }
    case ROS_TYPE_INT8: {
      int8_t value{}; member.fetch_function(field, index, &value); return std::to_string(value);
    }
    case ROS_TYPE_WCHAR:
    case ROS_TYPE_UINT16: {
      uint16_t value{}; member.fetch_function(field, index, &value); return std::to_string(value);
    }
    case ROS_TYPE_INT16: {
      int16_t value{}; member.fetch_function(field, index, &value); return std::to_string(value);
    }
    case ROS_TYPE_UINT32: {
      uint32_t value{}; member.fetch_function(field, index, &value); return std::to_string(value);
    }
    case ROS_TYPE_INT32: {
      int32_t value{}; member.fetch_function(field, index, &value); return std::to_string(value);
    }
    case ROS_TYPE_UINT64: {
      uint64_t value{}; member.fetch_function(field, index, &value); return quote(std::to_string(value));
    }
    case ROS_TYPE_INT64: {
      int64_t value{}; member.fetch_function(field, index, &value); return quote(std::to_string(value));
    }
    default: throw std::runtime_error(std::string("数组字段缺少可寻址元素：") + member.name_);
  }
}

std::string member_json(const MessageMember &member, const void *message) {
  const auto *field = static_cast<const uint8_t *>(message) + member.offset_;
  if (!member.is_array_) return scalar_json(member.type_id_, member, field);
  const size_t size = member.size_function ? member.size_function(field) : member.array_size_;
  std::ostringstream out;
  out << '[';
  for (size_t index = 0; index < size; ++index) {
    if (index) out << ',';
    out << fetched_array_element(member, field, index);
  }
  out << ']';
  return out.str();
}

std::string message_json(const MessageMembers &members, const void *message) {
  std::ostringstream out;
  out << '{';
  for (uint32_t index = 0; index < members.member_count_; ++index) {
    if (index) out << ',';
    const auto &member = members.members_[index];
    out << quote(member.name_) << ':' << member_json(member, message);
  }
  out << '}';
  return out.str();
}

}  // namespace

GenericMessageDecoder::GenericMessageDecoder(const std::string &type) {
  serialization_library_ = rclcpp::get_typesupport_library(type, "rosidl_typesupport_cpp");
  serialization_support_ = rclcpp::get_typesupport_handle(
      type, "rosidl_typesupport_cpp", *serialization_library_);
  introspection_library_ = rclcpp::get_typesupport_library(
      type, rosidl_typesupport_introspection_cpp::typesupport_identifier);
  const auto *introspection_support = rclcpp::get_typesupport_handle(
      type, rosidl_typesupport_introspection_cpp::typesupport_identifier,
      *introspection_library_);
  if (!introspection_support || !introspection_support->data) {
    throw std::runtime_error("消息类型缺少 C++ introspection typesupport：" + type);
  }
  members_ = static_cast<const MessageMembers *>(introspection_support->data);
}

std::string GenericMessageDecoder::decode(const rclcpp::SerializedMessage &serialized) const {
  void *message = ::operator new(members_->size_of_);
  members_->init_function(message, rosidl_runtime_cpp::MessageInitialization::ALL);
  try {
    if (rmw_deserialize(
        &serialized.get_rcl_serialized_message(), serialization_support_, message) != RMW_RET_OK) {
      throw std::runtime_error("rmw_deserialize 失败");
    }
    std::string result = message_json(*members_, message);
    members_->fini_function(message);
    ::operator delete(message);
    return result;
  } catch (...) {
    members_->fini_function(message);
    ::operator delete(message);
    throw;
  }
}

}  // namespace easy_debug_bridge
