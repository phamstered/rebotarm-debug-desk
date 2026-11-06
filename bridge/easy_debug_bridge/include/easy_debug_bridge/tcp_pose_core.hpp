#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>

namespace easy_debug_bridge {
// All positions are metres; quaternions are ROS x,y,z,w, in the URDF root frame.
struct TcpPose {
  std::array<double, 3> position{0., 0., 0.};
  std::array<double, 4> orientation{0., 0., 0., 1.};
};

// Keep the measured start outside the planning goal region for millimetre servo steps.
// Rotation-only requests retain the normal position region.
inline double tcp_planning_position_radius(double distance_m) {
  if(!std::isfinite(distance_m)||distance_m<0)throw std::runtime_error("TCP 目标距离无效");
  if(distance_m<1e-6)return .003;
  return std::min(.003,std::max(.0001,distance_m*.25));
}
inline TcpPose validate_tcp_pose(TcpPose pose) {
  for (const auto value : pose.position)
    if (!std::isfinite(value)) throw std::runtime_error("TCP 位置必须是三个有限数值");
  for (const auto value : pose.orientation)
    if (!std::isfinite(value)) throw std::runtime_error("TCP 四元数必须是四个有限数值（x,y,z,w）");
  const auto &q = pose.orientation;
  const double norm = std::hypot(std::hypot(q[0], q[1]), std::hypot(q[2], q[3]));
  if (!std::isfinite(norm) || norm <= 0. || std::abs(norm - 1.) > .001 + 1e-12)
    throw std::runtime_error("TCP 四元数必须归一化（范数误差不超过 0.001）");
  for (auto &value : pose.orientation) value /= norm;
  return pose;
}

inline std::array<double, 4> tcp_quaternion_product(const std::array<double, 4> &a,
    const std::array<double, 4> &b) {
  return {a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
          a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
          a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
          a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2]};
}

inline std::array<double, 3> tcp_rotate_vector(const std::array<double, 4> &q,
    const std::array<double, 3> &v) {
  const auto r = tcp_quaternion_product(
      tcp_quaternion_product(q, {v[0], v[1], v[2], 0.}), {-q[0], -q[1], -q[2], q[3]});
  return {r[0], r[1], r[2]};
}

// Transform composition: root->a times a->b gives root->b.
inline TcpPose tcp_pose_compose(const TcpPose &left, const TcpPose &right) {
  const auto a = validate_tcp_pose(left), b = validate_tcp_pose(right);
  TcpPose result;
  const auto offset = tcp_rotate_vector(a.orientation, b.position);
  for (size_t i = 0; i < 3; ++i) result.position[i] = a.position[i] + offset[i];
  result.orientation = tcp_quaternion_product(a.orientation, b.orientation);
  return validate_tcp_pose(result);
}

inline TcpPose tcp_pose_inverse(const TcpPose &value) {
  const auto pose = validate_tcp_pose(value);
  TcpPose result;
  const auto &q = pose.orientation;
  result.orientation = {-q[0], -q[1], -q[2], q[3]};
  result.position = tcp_rotate_vector(result.orientation,
      {-pose.position[0], -pose.position[1], -pose.position[2]});
  return validate_tcp_pose(result);
}

inline double tcp_pose_position_error(const TcpPose &a, const TcpPose &b) {
  const auto x = validate_tcp_pose(a), y = validate_tcp_pose(b);
  return std::hypot(std::hypot(x.position[0] - y.position[0], x.position[1] - y.position[1]),
      x.position[2] - y.position[2]);
}

inline double tcp_pose_orientation_error(const TcpPose &a, const TcpPose &b) {
  const auto x = validate_tcp_pose(a), y = validate_tcp_pose(b);
  // q and -q encode the same rotation. atan2 also remains accurate near zero.
  const auto &q = x.orientation;
  const auto delta = tcp_quaternion_product({-q[0], -q[1], -q[2], q[3]}, y.orientation);
  return 2. * std::atan2(std::hypot(std::hypot(delta[0], delta[1]), delta[2]), std::abs(delta[3]));
}
}
