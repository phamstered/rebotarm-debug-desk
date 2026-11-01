#pragma once

#include <rclcpp/qos.hpp>

namespace easy_debug_bridge {

// Preview readers accept both reliable and best-effort publishers. A small,
// volatile best-effort history favours recent frames instead of retransmitting
// obsolete megapixel images while an exact-time TF is being awaited.
inline rclcpp::QoS rgbd_stream_qos(rclcpp::QoS qos) {
  qos.keep_last(3).best_effort().durability_volatile();
  return qos;
}

}  // namespace easy_debug_bridge
