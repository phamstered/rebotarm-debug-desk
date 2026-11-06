#pragma once
#include <boost/property_tree/ptree.hpp>
#include <functional>
#include <memory>

#include "object_detection.hpp"
#include "tcp_pose_core.hpp"

namespace easy_debug_bridge {
struct PickObservation {
  ObjectBox box;
  std::string subscription;
  uint64_t sequence = 0, generation = 0;
  // Capture metadata from the delivered RGBD seed or current tracked RGB, never a latest-TF substitution.
  std::string source_frame, target_frame = "base_link";
  int64_t rgb_stamp_ns = 0, depth_stamp_ns = 0, tf_stamp_ns = 0;
  TcpPose source_to_target;
  double age_ms = 0;
  std::string target_id, tracking_mode = "rgbd", tracking_message, tracking_json = "null";
  bool identity_valid = true, metric_ready = true;
  double locked_yaw = std::numeric_limits<double>::quiet_NaN();
};
struct PickConfig {
  bool calibrated = false, scene_verified = false;
  double rgb_max_travel = .15;
  bool rgb_plane_verified = false;
  std::string tcp_link = "gripper_link";
  TcpPose grasp_to_tcp;
  double table_z = 0, depth = .015, clearance = .08, lift = .08, jaw_gap_zero = 0, opening_margin = .01,
         compression = .002;
};
struct PickPlan {
  TcpPose grasp, pregrasp, tcp, pre_tcp;
  double opening = 0, closing = 0;
};
PickConfig load_pick_config(const std::string &path);
TcpPose bounded_pick_step(const TcpPose &actual, const TcpPose &target, double distance_m);
PickPlan make_pick_plan(const ObjectBox &box, const PickConfig &config, double locked_yaw = std::numeric_limits<double>::quiet_NaN());
class VisualPick {
 public:
  using Tree = boost::property_tree::ptree;
  using Send = std::function<void(const std::string &)>;
  using Motion = std::function<void(uint64_t, const Tree &, Send)>;
  using Observe = std::function<PickObservation(uint64_t, const std::string &, uint64_t)>;
  using Pose = std::function<TcpPose(const std::string &)>;
  using Diagnostic = std::function<void(uint64_t, const std::string &, const std::string &, const std::string &)>;
  VisualPick(std::string config, Motion motion, Observe observe, Pose pose, Diagnostic diagnostic = {});
  ~VisualPick();
  bool busy() const;
  void cancel(uint64_t owner = 0);
  void request(uint64_t owner, const Tree &request, Send send);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}  // namespace easy_debug_bridge
