#include "easy_debug_bridge/tcp_pose_model.hpp"
#include <cassert>
#include <fstream>
#include <limits>
using namespace easy_debug_bridge;
namespace {
template<class F> bool rejects(F f) { try { f(); } catch (const std::exception &) { return true; } return false; }
void near(double a, double b, double epsilon = 1e-11) { assert(std::abs(a-b) < epsilon); }
std::string replace(std::string value, const std::string &from, const std::string &to) {
  const auto at = value.find(from); assert(at != std::string::npos);
  value.replace(at, from.size(), to); return value;
}
std::string robot() {
  std::string value = "<?xml version='1.0'?><robot name='test'><link name='base'/>";
  for (int i = 1; i <= 6; ++i) {
    const auto n = std::to_string(i), parent = i == 1 ? "base" : "link" + std::to_string(i-1);
    value += "<link name='link" + n + "'/><joint name='joint" + n + "' type='revolute'>"
      "<parent link='" + parent + "'/><child link='link" + n + "'/><origin xyz='1 0 0'/><axis xyz='0 0 5'/>"
      "<limit lower='-3.14' upper='3.14'/></joint>";
  }
  value += "<link name='gripper_link'/><joint name='mount' type='fixed'><parent link='link6'/>"
    "<child link='gripper_link'/><origin xyz='0 0 2' rpy='0 0 1.5707963267948966'/></joint>"
    "<link name='tcp'/><joint name='offset' type='fixed'><parent link='gripper_link'/>"
    "<child link='tcp'/><origin xyz='1 0 0'/></joint>"
    "<link name='finger'/><joint name='gripper' type='prismatic'><parent link='gripper_link'/>"
    "<child link='finger'/><axis xyz='1 0 0'/><limit lower='0' upper='.05'/></joint></robot>";
  return value;
}
}
int main(int argc, char **argv) {
  const double pi = std::acos(-1.);
  const auto xml = robot();
  const auto model = parse_tcp_pose_model(xml, "tcp", "base");
  assert(model.root_link == "base" && model.arm_tip_link == "link6" && model.tcp_link == "tcp");
  near(model.arm_tip_to_tcp.position[0], 0.); near(model.arm_tip_to_tcp.position[1], 1.); near(model.arm_tip_to_tcp.position[2], 2.);
  const auto zero = tcp_forward_pose(model, std::vector<double>(6, 0.));
  near(zero.position[0], 6.); near(zero.position[1], 1.); near(zero.position[2], 2.);
  const auto rotated = tcp_forward_pose(model, {pi/2, 0., 0., 0., 0., 0.});
  near(rotated.position[0], 0.); near(rotated.position[1], 5.); near(rotated.position[2], 2.);
  near(tcp_pose_orientation_error(rotated, {{}, {0., 0., 1., 0.}}), 0.);
  // Constrain joint6's child, not the fixed tool link that KDL does not solve.
  const auto tip = tcp_target_to_arm_tip(model, rotated);
  near(tip.position[0], 1.); near(tip.position[1], 5.); near(tip.position[2], 0.);
  near(tcp_pose_orientation_error(tip, {{}, {0., 0., std::sqrt(.5), std::sqrt(.5)}}), 0.);
  const auto round_trip = tcp_pose_compose(tip, model.arm_tip_to_tcp);
  near(tcp_pose_position_error(round_trip, rotated), 0.);
  near(tcp_pose_orientation_error(round_trip, rotated), 0.);
  const auto bare_tip = parse_tcp_pose_model(xml, "link6");
  near(tcp_pose_position_error(bare_tip.arm_tip_to_tcp, TcpPose{}), 0.);
  const auto fixed_root = parse_tcp_pose_model(replace(xml, "<link name='base'/>",
      "<link name='world'/><link name='base'/><joint name='world_mount' type='fixed'>"
      "<parent link='world'/><child link='base'/><origin xyz='0 0 1'/></joint>"), "tcp", "world");
  near(tcp_forward_pose(fixed_root, std::vector<double>(6, 0.)).position[2], 3.);
  // Fixed-axis RPY and a non-Z actuated axis compose in URDF order.
  const auto roll_xml = replace(replace(xml, "<origin xyz='1 0 0'/>",
      "<origin xyz='1 0 0' rpy='0 0 1.5707963267948966'/>"), "<axis xyz='0 0 5'/>", "<axis xyz='2 0 0'/>");
  const auto roll = tcp_forward_pose(parse_tcp_pose_model(roll_xml, "link6"), {pi/2, 0., 0., 0., 0., 0.});
  near(roll.position[0], 1.); near(roll.position[1], 5.); near(roll.position[2], 0.);
  near(tcp_pose_orientation_error(roll, {{}, {.5, .5, .5, .5}}), 0.);
  for (const auto &tcp : {"finger", "missing", "base", "link5"})
    assert(rejects([&] { parse_tcp_pose_model(xml, tcp); }));
  for (const auto &frame : {"world", "/base", "link6"})
    assert(rejects([&] { parse_tcp_pose_model(xml, "tcp", frame); }));
  assert(rejects([&] { parse_tcp_pose_model(replace(xml, "name='joint6'", "name='joint7'"), "tcp"); }));
  assert(rejects([&] { parse_tcp_pose_model(replace(xml, "name='joint6' type='revolute'", "name='joint6' type='continuous'"), "tcp"); }));
  assert(rejects([&] { parse_tcp_pose_model(replace(xml, "<axis xyz='0 0 5'/>", "<axis xyz='0 0 0'/>"), "tcp"); }));
  assert(rejects([&] { parse_tcp_pose_model(replace(xml, "<axis xyz='0 0 5'/>", "<axis xyz='0 0 1'/><mimic joint='joint2'/>"), "tcp"); }));
  assert(rejects([&] { parse_tcp_pose_model(replace(xml, "name='mount' type='fixed'", "name='mount' type='revolute'"), "tcp"); }));
  for (const auto &invalid : {
      replace(xml, "<link name='tcp'/>", "<link name='tcp'/><link name='tcp'/>"),
      replace(xml, "name='joint6'", "name='joint5'"),
      replace(xml, "<parent link='link6'/>", "<parent link='missing'/>"),
      replace(xml, "<child link='tcp'/>", "<child link='link6'/>"),
      replace(xml, "<origin xyz='1 0 0'/>", "<origin xyz='1 0'/>") ,
      replace(xml, "<origin xyz='1 0 0'/>", "<origin xyz='1 0 0 4'/>") ,
      replace(xml, "<origin xyz='1 0 0'/>", "<origin xyz='nan 0 0'/>") ,
      replace(xml, "<origin xyz='1 0 0'/>", "<origin xyz='1 0 0' rpy='0 inf 0'/>") ,
      replace(xml, "<origin xyz='1 0 0'/>", "<origin xyz='1 0 0'/><origin/>") ,
      replace(xml, "<axis xyz='0 0 5'/>", "<axis xyz='0 0 5' xyz='0 0 1'/>") ,
      replace(xml, "</robot>", "<link name='unconnected'/></robot>"),
      replace(xml, "</robot>", "<link name='a'/><link name='b'/><joint name='ab' type='fixed'><parent link='a'/><child link='b'/></joint>"
          "<joint name='ba' type='fixed'><parent link='b'/><child link='a'/></joint></robot>")})
    assert(rejects([&] { parse_tcp_pose_model(invalid, "tcp"); }));
  assert(rejects([&] { parse_tcp_pose_model("<robot><link", "tcp"); }));
  assert(rejects([&] { parse_tcp_pose_model(xml + "<robot/>", "tcp"); }));
  assert(rejects([&] { tcp_forward_pose(model, {0., 0.}); }));
  assert(rejects([&] { tcp_forward_pose(model, {0., 0., 0., 0., 0., std::numeric_limits<double>::quiet_NaN()}); }));
  if (argc > 1) {
    std::ifstream file(argv[1]); assert(file.good());
    std::ostringstream source; source << file.rdbuf();
    const auto real = parse_tcp_pose_model(source.str(), "gripper_link", "base_link");
    assert(real.arm_tip_link == "link6");
    const auto pose = tcp_forward_pose(real, {.2, -.8, -1.1, .3, .4, -.2});
    const auto solved_tip = tcp_target_to_arm_tip(real, pose);
    const auto actual_tip = tcp_forward_pose(parse_tcp_pose_model(source.str(), "link6"), {.2, -.8, -1.1, .3, .4, -.2});
    near(tcp_pose_position_error(solved_tip, actual_tip), 0.);
    near(tcp_pose_orientation_error(solved_tip, actual_tip), 0.);
    for (const auto &finger : {"gripper_finger_left", "gripper_finger_right"})
      assert(rejects([&] { parse_tcp_pose_model(source.str(), finger); }));
  }
}
