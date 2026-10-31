#include "easy_debug_bridge/position_motion_model.hpp"
#include <cassert>
#include <limits>
using namespace easy_debug_bridge;
int main() {
  std::string urdf="<robot name='real'>", srdf="<robot name='real'><group name='arm'>";
  for (int i=1;i<=6;++i) {
    const auto name="joint"+std::to_string(i);
    urdf+="<joint name='"+name+"' type='revolute'><limit lower='-1' upper='1'/></joint>";
    srdf+="<joint name='"+name+"'/>";
  }
  urdf+="</robot>"; srdf+="</group><group_state name='home' group='arm'>";
  for(int i=6;i>=1;--i) srdf+="<joint name='joint"+std::to_string(i)+"' value='"+std::to_string(i*.1)+"'/>";
  srdf+="</group_state></robot>";
  const auto model=position_motion_model(urdf,srdf);
  for(size_t i=0;i<6;++i) assert(std::abs(model.home[i]-(i+1)*.1)<1e-8);
  const auto rejects=[&](std::string u,std::string s) { try { position_motion_model(u,s); } catch (...) { return true; } return false; };
  assert(rejects(urdf,"<robot/>"));
  auto invalid=srdf; invalid.replace(invalid.find("value='0.600000'"),16,"value='9.000000'");
  assert(rejects(urdf,invalid));
  assert(rejects("<robot/>",srdf));
  const std::vector<double> measured{.1,.2,.3,.4,.5,.6};
  const auto rotated = joint_rotation_target(measured, "joint3", -.25, model);
  assert((rotated == std::vector<double>{.1,.2,-.25,.4,.5,.6}));
  for (const auto &name : {"", "joint0", "joint7", "gripper"}) {
    bool rejected = false;
    try { joint_rotation_target(measured, name, 0, model); } catch (...) { rejected = true; }
    assert(rejected);
  }
  for (double value : {2., std::numeric_limits<double>::quiet_NaN(), std::numeric_limits<double>::infinity()}) {
    bool rejected = false;
    try { joint_rotation_target(measured, "joint1", value, model); } catch (...) { rejected = true; }
    assert(rejected);
  }
  bool incomplete = false;
  try { joint_rotation_target({0}, "joint1", 0, model); } catch (...) { incomplete = true; }
  assert(incomplete);
}
