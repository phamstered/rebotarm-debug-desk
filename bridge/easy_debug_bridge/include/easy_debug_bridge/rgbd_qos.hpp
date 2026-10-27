#pragma once

#include <rclcpp/qos.hpp>

namespace easy_debug_bridge {

// RGBD streams need the publisher's reliability, but must not request retained
// samples: RealSense image publishers may be transient-local while CameraInfo
// is volatile, and a transient-local CameraInfo subscriber will never match.
inline rclcpp::QoS rgbd_stream_qos(rclcpp::QoS qos) {
  qos.durability_volatile();
  return qos;
}

}  // namespace easy_debug_bridge
