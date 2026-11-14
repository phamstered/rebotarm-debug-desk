#include "easy_debug_bridge/trajectory_task_protocol.hpp"
#include <boost/property_tree/json_parser.hpp>
#include <cassert>
#include <iostream>
#include <sstream>
using namespace easy_debug_bridge;
using Tree=boost::property_tree::ptree;
Tree json(const std::string &text) {
  Tree tree;std::istringstream stream(text);boost::property_tree::read_json(stream,tree);return tree;
}
template<class F> void rejects(F operation) {
  bool failed=false;try {operation();} catch (const std::exception &) {failed=true;}assert(failed);
}
int main() {
  const std::string valid=R"({"op":"trajectory_command","request_id":"r","command_id":"t-1","topic":"/arm_trajectory_controller/joint_trajectory","joint_names":["joint1"],"trajectory_points":[{"positions":[0],"velocities":[0],"time_from_start":1}]})";
  const auto parsed=parse_task_trajectory(json(valid));assert(parsed.points.size()==1);assert(parsed.joint_names.front()=="joint1");
  for (const auto &extra:{R"(,"unknown":0)",R"(,"topic":"/other/joint_trajectory")",R"(,"command_id":"duplicate")"})
    rejects([&]{parse_task_trajectory(json(valid.substr(0,valid.size()-1)+extra+"}"));});
  for (const auto &point:{R"({"positions":[0],"time_from_start":1,"unknown":0})",
       R"({"positions":[0],"positions":[1],"time_from_start":1})",
       R"({"positions":{"bad":0},"time_from_start":1})",
       R"({"positions":[[0]],"time_from_start":1})",
       R"({"positions":[0],"time_from_start":{"seconds":1}})",
       R"({"positions":[0],"time_from_start":0})",
       R"({"positions":[0],"velocities":[0,0],"time_from_start":1})"}) {
    auto tree=json(valid);tree.put_child("trajectory_points",json("["+std::string(point)+"]"));
    rejects([&]{parse_task_trajectory(tree);});
  }
  auto long_path=json(valid);Tree points;
  for (int i=0;i<65;++i) {auto point=json(R"({"positions":[0],"time_from_start":1})");point.put("time_from_start",i+1);points.push_back({"",point});}
  long_path.put_child("trajectory_points",points);rejects([&]{parse_task_trajectory(long_path);});
  assert(trajectory_control_id(json(R"({"op":"trajectory_cancel","request_id":"r","command_id":"t-1"})"))=="t-1");
  for (const auto &request:{R"({"op":"trajectory_cancel","command_id":"t-1","extra":0})",
       R"({"op":"trajectory_cancel","command_id":"t-1","command_id":"t-2"})",
       R"({"op":"trajectory_cancel","command_id":{"value":"t-1"}})",
       R"({"op":"trajectory_cancel","command_id":"bad id"})"})
    rejects([&]{trajectory_control_id(json(request));});
  const auto event=json(trajectory_task_event("t-1","failed",true,"not_published","quote\"\nline"));
  assert(event.get<bool>("terminal"));assert(event.get<std::string>("message")=="quote\"\nline");
  std::cout<<"Direct trajectory protocol boundary tests passed\n";
}
