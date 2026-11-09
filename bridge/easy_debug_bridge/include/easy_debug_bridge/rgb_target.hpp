#pragma once
#include "object_detection.hpp"
#include "tcp_pose_core.hpp"
#include <memory>
#include <string>
#include <vector>
namespace easy_debug_bridge {
struct RgbTargetConfig {
  bool enabled = true, plane_verified = false;
  unsigned confirmation_frames = 3;
  double handoff_distance_m = .25, max_rgb_seconds = 90, max_rgb_travel_m = .15;
};
RgbTargetConfig load_rgb_target_config(const std::string &path);
struct RgbTargetFrame {
  std::shared_ptr<const DownsampledImage> rgb, depth;
  std::array<double, 9> k{};
  std::vector<double> distortion;
  std::string distortion_model, source_frame, target_frame = "base_link",
                                              subscription;
  TcpPose camera_to_base;
  int64_t stamp_ns = 0, depth_stamp_ns = 0;
  uint64_t generation = 0;
  double source_age_ms = 0;
};
struct RgbTargetState {
  std::string target_id, mode = "none", message, geometry_source = "none";
  std::string diagnostic, handoff_reason;
  uint64_t object_id = 0, sequence = 0, generation = 0;
  bool identity_valid = false, metric_ready = false, plane_verified = false;
  double confidence = 0, depth_valid_fraction = 0, age_ms = 0, camera_z_m = 0;
  std::array<double, 4> roi{};
  ObjectBox box;
  double locked_yaw = 0;
  int64_t stamp_ns = 0;
  RgbTargetFrame frame;
};
bool rgb_target_supported();
std::string rgb_target_json(const RgbTargetState &state);
class RgbTargetTracker {
public:
  RgbTargetTracker();
  ~RgbTargetTracker();
  RgbTargetState select(const RgbTargetFrame &frame, const ObjectBox &box,
                        const RgbTargetConfig &config);
  // Recovery requires a caller-verified stationary, idle robot. Normal tracking does not.
  void update(const RgbTargetFrame &frame, bool recovery_allowed = false, const std::string &expected_target_id = "");
  void invalidate(const std::string &reason, const std::string &expected_target_id = "");
  void release();
  bool matches_config(const RgbTargetConfig &config);
  RgbTargetState snapshot();

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
} // namespace easy_debug_bridge
