#pragma once

#include <rosidl_typesupport_introspection_cpp/field_types.hpp>
#include <rosidl_typesupport_introspection_cpp/message_introspection.hpp>

#include <cmath>
#include <cstdint>
#include <iomanip>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <type_traits>

namespace easy_debug_bridge {

namespace detail {
namespace intro = rosidl_typesupport_introspection_cpp;

inline void quote_json(std::ostream &out, const std::string &value) {
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
          out << "\\u" << std::hex << std::setw(4) << std::setfill('0')
              << static_cast<unsigned>(c) << std::dec;
        } else {
          out << static_cast<char>(c);
        }
    }
  }
  out << '"';
}

inline std::string utf8(const std::u16string &value) {
  std::string result;
  for (size_t i = 0; i < value.size(); ++i) {
    uint32_t code = value[i];
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < value.size() &&
        value[i + 1] >= 0xDC00 && value[i + 1] <= 0xDFFF) {
      code = 0x10000 + ((code - 0xD800) << 10) + (value[++i] - 0xDC00);
    } else if (code >= 0xD800 && code <= 0xDFFF) {
      code = 0xFFFD;
    }
    if (code < 0x80) result.push_back(static_cast<char>(code));
    else if (code < 0x800) {
      result.push_back(static_cast<char>(0xC0 | (code >> 6)));
      result.push_back(static_cast<char>(0x80 | (code & 0x3F)));
    } else if (code < 0x10000) {
      result.push_back(static_cast<char>(0xE0 | (code >> 12)));
      result.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
      result.push_back(static_cast<char>(0x80 | (code & 0x3F)));
    } else {
      result.push_back(static_cast<char>(0xF0 | (code >> 18)));
      result.push_back(static_cast<char>(0x80 | ((code >> 12) & 0x3F)));
      result.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
      result.push_back(static_cast<char>(0x80 | (code & 0x3F)));
    }
  }
  return result;
}

template <typename Number>
inline void write_number(std::ostream &out, Number value) {
  if constexpr (std::is_floating_point_v<Number>) {
    if (!std::isfinite(value)) { out << "null"; return; }
    out << std::setprecision(std::numeric_limits<Number>::max_digits10) << value;
  } else if constexpr (sizeof(Number) == 8) {
    // JSON.parse cannot preserve integers outside its exact IEEE-754 range.
    constexpr uint64_t max_safe = 9007199254740991ULL;
    if constexpr (std::is_signed_v<Number>) {
      if (value > static_cast<int64_t>(max_safe) || value < -static_cast<int64_t>(max_safe)) {
        quote_json(out, std::to_string(value)); return;
      }
    } else if (value > max_safe) {
      quote_json(out, std::to_string(value)); return;
    }
    out << value;
  } else {
    out << +value;
  }
}

inline void write_message(std::ostream &out, const void *message, const intro::MessageMembers &members);

inline void write_value(std::ostream &out, const void *value, const intro::MessageMember &field) {
  switch (field.type_id_) {
    case intro::ROS_TYPE_BOOLEAN: out << (*static_cast<const bool *>(value) ? "true" : "false"); break;
    case intro::ROS_TYPE_CHAR:
    case intro::ROS_TYPE_OCTET:
    case intro::ROS_TYPE_UINT8: write_number(out, *static_cast<const uint8_t *>(value)); break;
    case intro::ROS_TYPE_INT8: write_number(out, *static_cast<const int8_t *>(value)); break;
    case intro::ROS_TYPE_UINT16: write_number(out, *static_cast<const uint16_t *>(value)); break;
    case intro::ROS_TYPE_INT16: write_number(out, *static_cast<const int16_t *>(value)); break;
    case intro::ROS_TYPE_UINT32: write_number(out, *static_cast<const uint32_t *>(value)); break;
    case intro::ROS_TYPE_INT32: write_number(out, *static_cast<const int32_t *>(value)); break;
    case intro::ROS_TYPE_UINT64: write_number(out, *static_cast<const uint64_t *>(value)); break;
    case intro::ROS_TYPE_INT64: write_number(out, *static_cast<const int64_t *>(value)); break;
    case intro::ROS_TYPE_FLOAT: write_number(out, *static_cast<const float *>(value)); break;
    case intro::ROS_TYPE_DOUBLE: write_number(out, *static_cast<const double *>(value)); break;
    case intro::ROS_TYPE_LONG_DOUBLE: write_number(out, *static_cast<const long double *>(value)); break;
    case intro::ROS_TYPE_WCHAR: {
      quote_json(out, utf8(std::u16string(1, *static_cast<const char16_t *>(value)))); break;
    }
    case intro::ROS_TYPE_STRING: quote_json(out, *static_cast<const std::string *>(value)); break;
    case intro::ROS_TYPE_WSTRING: quote_json(out, utf8(*static_cast<const std::u16string *>(value))); break;
    case intro::ROS_TYPE_MESSAGE: {
      if (!field.members_ || !field.members_->data) throw std::runtime_error("缺少嵌套消息类型支持");
      write_message(out, value, *static_cast<const intro::MessageMembers *>(field.members_->data));
      break;
    }
    default: throw std::runtime_error("未知 ROS 字段类型：" + std::to_string(field.type_id_));
  }
}

inline void write_message(std::ostream &out, const void *message, const intro::MessageMembers &members) {
  out << '{';
  for (uint32_t i = 0; i < members.member_count_; ++i) {
    if (i) out << ',';
    const auto &field = members.members_[i];
    quote_json(out, field.name_);
    out << ':';
    const auto *value = static_cast<const uint8_t *>(message) + field.offset_;
    if (!field.is_array_) { write_value(out, value, field); continue; }
    if (!field.size_function || (!field.get_const_function &&
        !(field.type_id_ == intro::ROS_TYPE_BOOLEAN && field.fetch_function))) {
      throw std::runtime_error("缺少数组字段访问函数");
    }
    out << '[';
    const size_t count = field.size_function(value);
    for (size_t j = 0; j < count; ++j) {
      if (j) out << ',';
      // std::vector<bool> has no stable element address; use the generated fetch function.
      if (field.type_id_ == intro::ROS_TYPE_BOOLEAN && field.fetch_function) {
        bool item = false;
        field.fetch_function(value, j, &item);
        write_value(out, &item, field);
      } else {
        write_value(out, field.get_const_function(value, j), field);
      }
    }
    out << ']';
  }
  out << '}';
}
}  // namespace detail

inline std::string message_to_json(
    const void *message, const rosidl_typesupport_introspection_cpp::MessageMembers &members) {
  std::ostringstream out;
  detail::write_message(out, message, members);
  return out.str();
}
}  // namespace easy_debug_bridge
