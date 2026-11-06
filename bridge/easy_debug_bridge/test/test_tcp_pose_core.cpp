#include "easy_debug_bridge/tcp_pose_core.hpp"
#include <cassert>
#include <limits>
using namespace easy_debug_bridge;
namespace {
template<class F> bool rejects(F f) { try { f(); } catch (const std::exception &) { return true; } return false; }
void near(double a, double b, double epsilon = 1e-12) { assert(std::abs(a-b) < epsilon); }
}
int main() {
  near(tcp_planning_position_radius(.02),.003);
  near(tcp_planning_position_radius(.003),.00075);
  near(tcp_planning_position_radius(0),.003);
  assert(tcp_planning_position_radius(.003)<.003);
  assert(rejects([]{tcp_planning_position_radius(std::numeric_limits<double>::quiet_NaN());}));
  assert(rejects([]{tcp_planning_position_radius(-.1);}));
  const double pi = std::acos(-1.), s = std::sqrt(.5);
  const TcpPose z90{{1., 2., 3.}, {0., 0., s, s}};
  const TcpPose x90{{1., 0., 0.}, {s, 0., 0., s}};
  const auto composed = tcp_pose_compose(z90, x90);
  near(composed.position[0], 1.); near(composed.position[1], 3.); near(composed.position[2], 3.);
  for (const auto q : composed.orientation) near(q, .5);
  const auto identity = tcp_pose_compose(composed, tcp_pose_inverse(composed));
  near(tcp_pose_position_error(identity, TcpPose{}), 0.);
  near(tcp_pose_orientation_error(identity, TcpPose{}), 0.);
  const auto opposite_sign = TcpPose{composed.position, {-.5, -.5, -.5, -.5}};
  near(tcp_pose_orientation_error(composed, opposite_sign), 0.);
  near(tcp_pose_orientation_error(TcpPose{}, {{0., 0., 0.}, {1., 0., 0., 0.}}), pi);
  const double epsilon = 1e-7;
  const TcpPose near_pi{{}, {0., 0., std::sin((pi-epsilon)/2), std::cos((pi-epsilon)/2)}};
  const TcpPose across_pi{{}, {0., 0., std::sin((-pi+epsilon)/2), std::cos((-pi+epsilon)/2)}};
  near(tcp_pose_orientation_error(near_pi, across_pi), 2*epsilon, 1e-14);
  near(tcp_pose_orientation_error(TcpPose{}, {{0., 0., 0.}, {5e-10, 0., 0., 1.}}), 1e-9, 1e-15);
  near(tcp_pose_position_error({{1., 2., 3.}}, {{4., 6., 3.}}), 5.);
  const auto normalized = validate_tcp_pose({{0., 0., 0.}, {0., 0., 0., 1.0005}});
  near(normalized.orientation[3], 1.);
  const auto negative = validate_tcp_pose({{0., 0., 0.}, {0., 0., 0., -1.0005}});
  near(negative.orientation[3], -1.);
  assert(rejects([] { validate_tcp_pose({{}, {0., 0., 0., 0.}}); }));
  assert(rejects([] { validate_tcp_pose({{}, {0., 0., 0., 1.002}}); }));
  for (const double bad : {std::numeric_limits<double>::quiet_NaN(), std::numeric_limits<double>::infinity()}) {
    assert(rejects([&] { validate_tcp_pose({{bad, 0., 0.}}); }));
    assert(rejects([&] { validate_tcp_pose({{}, {0., bad, 0., 1.}}); }));
  }
  assert(rejects([] { validate_tcp_pose({{}, {1e308, 1e308, 1e308, 1e308}}); }));
  assert(rejects([] { tcp_pose_compose({{1e308, 0., 0.}}, {{1e308, 0., 0.}}); }));
}
