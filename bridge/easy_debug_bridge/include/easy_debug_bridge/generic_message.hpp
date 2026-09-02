#pragma once

#include <memory>
#include <string>

#include <rclcpp/serialized_message.hpp>
#include <rcpputils/shared_library.hpp>
#include <rosidl_runtime_c/message_type_support_struct.h>
#include <rosidl_typesupport_introspection_cpp/message_introspection.hpp>

namespace easy_debug_bridge {

class GenericMessageDecoder {
 public:
  explicit GenericMessageDecoder(const std::string &type);
  std::string decode(const rclcpp::SerializedMessage &serialized) const;

 private:
  std::shared_ptr<rcpputils::SharedLibrary> serialization_library_;
  std::shared_ptr<rcpputils::SharedLibrary> introspection_library_;
  const rosidl_message_type_support_t *serialization_support_;
  const rosidl_typesupport_introspection_cpp::MessageMembers *members_;
};

}  // namespace easy_debug_bridge
