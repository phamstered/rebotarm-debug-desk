#pragma once
#include "easy_debug_bridge/position_motion_core.hpp"
#include "easy_debug_bridge/gripper_motion_core.hpp"
#include <cstdint>
#include <functional>

namespace easy_debug_bridge {
inline void validate_motion_duration(double seconds) {
  if (!std::isfinite(seconds) || seconds < 1e-9 || seconds > 2147483647.)
    throw std::runtime_error("运动时长须为正数且能用 ROS 时间表示");
}
struct TimedMotionPoint {
  std::vector<double> positions, velocities, accelerations, effort;
  int64_t time_ns{};
};
// A successful one-point gripper plan can describe an already-reached goal.
// This authorizes observation only: never synthesize or dispatch a trajectory.
inline bool gripper_no_motion_reached(const PositionMotionModel &model,
    const std::vector<double> &target, const std::vector<double> &actual) {
  if (model.joint_names != std::vector<std::string>{gripper_motion_joint()} ||
      target.size() != 1 || actual.size() != 1) return false;
  try { validate_position_target(target, model); validate_position_target(actual, model); }
  catch (...) { return false; }
  return std::abs(actual[0] - target[0]) <= motion_goal_tolerance(gripper_motion_joint());
}
inline bool valid_gripper_no_motion_plan(const TimedMotionPoint &point,
    const PositionMotionModel &model, const std::vector<double> &target,
    const std::vector<double> &actual) {
  if (point.time_ns != 0 || !gripper_no_motion_reached(model, target, actual) ||
      !gripper_no_motion_reached(model, target, point.positions) ||
      !gripper_no_motion_reached(model, actual, point.positions)) return false;
  for (const auto *values : {&point.velocities, &point.accelerations, &point.effort}) {
    if (!values->empty() && (values->size() != 1 || !std::isfinite(values->front()) ||
                            std::abs(values->front()) > 1e-9)) return false;
  }
  return true;
}
inline std::string motion_number(double value) {
  std::ostringstream out; out << std::setprecision(17) << value; return out.str();
}
// Only continuous dynamic-limit failures are eligible for automatic slowing.
class MotionDynamicLimitError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};
// A prismatic finger must remain within calibrated travel between knots too.
inline void bounded_position_spline(const std::vector<double> &b, double lower, double upper, int depth = 0) {
  const auto within = [&](double x) { return std::isfinite(x) && x >= lower - 1e-9 && x <= upper + 1e-9; };
  if (!within(b.front()) || !within(b.back())) throw std::runtime_error("夹爪样条轨迹超过标定行程");
  if (std::all_of(b.begin(), b.end(), within)) return;
  if (depth >= 12) throw std::runtime_error("无法确认夹爪样条位于标定行程内");
  auto row = b; std::vector<double> left{b.front()}, right{b.back()};
  while (row.size() > 1) {
    for (size_t i = 0; i + 1 < row.size(); ++i) row[i] = (row[i] + row[i+1]) / 2;
    row.pop_back(); left.push_back(row.front()); right.push_back(row.back());
  }
  std::reverse(right.begin(), right.end());
  bounded_position_spline(left, lower, upper, depth + 1);
  bounded_position_spline(right, lower, upper, depth + 1);
}
// Convex-hull bounds on cubic/quintic interpolation, subdivided when needed.
inline void bounded_spline(const std::vector<double> &b, double h, double vmax, double amax, int depth=0) {
  std::vector<double> v, a;
  for (size_t i=1;i<b.size();++i) v.push_back((b.size()-1)*(b[i]-b[i-1])/h);
  for (size_t i=1;i<v.size();++i) a.push_back((v.size()-1)*(v[i]-v[i-1])/h);
  auto within=[](double x,double limit){return std::isfinite(x) && std::abs(x)<=limit+1e-7;};
  if (!within(v.front(),vmax)||!within(v.back(),vmax)||!within(a.front(),amax)||!within(a.back(),amax))
    throw MotionDynamicLimitError("轨迹样条速度或加速度超限: velocity_endpoints=[" + motion_number(v.front()) + "," + motion_number(v.back()) +
        "] velocity_limit=" + motion_number(vmax) + " acceleration_endpoints=[" + motion_number(a.front()) + "," + motion_number(a.back()) +
        "] acceleration_limit=" + motion_number(amax) + " subdivision_depth=" + std::to_string(depth) + " subsegment_dt_s=" + motion_number(h));
  if (std::all_of(v.begin(),v.end(),[&](double x){return within(x,vmax);}) &&
      std::all_of(a.begin(),a.end(),[&](double x){return within(x,amax);})) return;
  if (depth>=12) throw MotionDynamicLimitError("无法确认样条速度/加速度满足上限: velocity_control_bound=" +
      motion_number(std::abs(*std::max_element(v.begin(), v.end(), [](double x, double y) { return std::abs(x) < std::abs(y); }))) +
      " velocity_limit=" + motion_number(vmax) + " acceleration_control_bound=" +
      motion_number(std::abs(*std::max_element(a.begin(), a.end(), [](double x, double y) { return std::abs(x) < std::abs(y); }))) +
      " acceleration_limit=" + motion_number(amax) + " subdivision_depth=" + std::to_string(depth));
  auto row=b;std::vector<double> left{b.front()},right{b.back()};
  while(row.size()>1){for(size_t i=0;i+1<row.size();++i) row[i]=(row[i]+row[i+1])/2;row.pop_back();left.push_back(row.front());right.push_back(row.back());}
  std::reverse(right.begin(),right.end());
  bounded_spline(left,h/2,vmax,amax,depth+1);bounded_spline(right,h/2,vmax,amax,depth+1);
}
// Preserve the planned path; compression must satisfy continuous spline bounds.
inline std::vector<TimedMotionPoint> stretch_motion(std::vector<TimedMotionPoint> points,
    double seconds, const PositionMotionModel &model,
    const std::vector<double> &velocity_limits = std::vector<double>(6,2.),
    const std::vector<double> &acceleration_limits = std::vector<double>(6,2.)) {
  validate_motion_duration(seconds);
  if (points.size() < 2 || points.size() > 10000) throw std::runtime_error("规划轨迹点数无效");
  int64_t previous = -1;
  for (const auto &point : points) {
    validate_position_target(point.positions, model);
    for (const auto *values : {&point.velocities, &point.accelerations, &point.effort})
      if ((!values->empty() && values->size() != model.joint_names.size()) ||
          !std::all_of(values->begin(), values->end(), [](double v) { return std::isfinite(v); }))
        throw std::runtime_error("规划轨迹速度/加速度/力矩数组无效");
    if (point.time_ns < 0 || point.time_ns <= previous) throw std::runtime_error("规划轨迹时间必须递增");
    previous = point.time_ns;
  }
  const auto target_ns = static_cast<int64_t>(std::llround(seconds * 1e9));
  if (previous <= 0) throw std::runtime_error("规划轨迹时长无效");
  const double scale = static_cast<double>(target_ns) / previous;
  previous = -1;
  for (auto &point : points) {
    point.time_ns = static_cast<int64_t>(std::llround(point.time_ns * scale));
    if (point.time_ns <= previous) throw std::runtime_error("调整后的轨迹时间无效");
    previous = point.time_ns;
    for (auto &v : point.velocities) v /= scale;
    for (auto &a : point.accelerations) a /= scale * scale;
  }
  points.back().time_ns = target_ns;
  if (velocity_limits.size()!=model.joint_names.size() || acceleration_limits.size()!=model.joint_names.size()) throw std::runtime_error("运动限幅不完整");
  for(size_t k=0;k<model.joint_names.size();++k) {
    if(!std::isfinite(velocity_limits[k])||!std::isfinite(acceleration_limits[k])||velocity_limits[k]<=0||acceleration_limits[k]<=0)
      throw std::runtime_error("运动限幅无效");
    for(size_t i=1;i<points.size();++i) {
      const auto &x=points[i-1],&y=points[i];double h=(y.time_ns-x.time_ns)/1e9;
      try {
      if(x.velocities.empty()||y.velocities.empty()) {
        if (model.joint_names[k] == gripper_motion_joint())
          throw std::runtime_error("夹爪轨迹缺少速度，无法验证整段运动限幅");
        if(scale<1 || std::abs((y.positions[k]-x.positions[k])/h)>velocity_limits[k])
          throw std::runtime_error("缺少速度数据或轨迹超限，无法验证指定时长");
        continue;
      }
      double p=x.positions[k],q=y.positions[k],v=x.velocities[k],w=y.velocities[k];
      const auto controls = !x.accelerations.empty()&&!y.accelerations.empty()
        ? std::vector<double>{p,p+v*h/5,p+2*v*h/5+x.accelerations[k]*h*h/20,
            q-2*w*h/5+y.accelerations[k]*h*h/20,q-w*h/5,q}
        : std::vector<double>{p,p+v*h/3,q-w*h/3,q};
      bounded_spline(controls,h,velocity_limits[k],acceleration_limits[k]);
      if (model.joint_names[k] == gripper_motion_joint())
        bounded_position_spline(controls, model.lower[k], model.upper[k]);
      } catch (const std::exception &e) {
        const auto value = [&](const std::vector<double> &values) { return values.empty() ? std::string("missing") : motion_number(values[k]); };
        const auto unit = model.joint_names[k] == gripper_motion_joint() ? "m" : "rad";
        const auto detail = std::string(e.what()) + " joint=" + model.joint_names[k] + " unit=" + unit +
            " segment=" + std::to_string(i-1) + "->" + std::to_string(i) +
            " t_s=[" + motion_number(x.time_ns/1e9) + "," + motion_number(y.time_ns/1e9) + "] dt_s=" + motion_number(h) +
            " duration_s=" + motion_number(seconds) + " time_scale=" + motion_number(scale) +
            " p=[" + value(x.positions) + "," + value(y.positions) + "] v=[" + value(x.velocities) + "," + value(y.velocities) +
            "] a=[" + value(x.accelerations) + "," + value(y.accelerations) + "]" +
            " velocity_limit=" + motion_number(velocity_limits[k]) + " acceleration_limit=" + motion_number(acceleration_limits[k]) +
            " position_limits=[" + motion_number(model.lower[k]) + "," + motion_number(model.upper[k]) + "]";
        if (dynamic_cast<const MotionDynamicLimitError *>(&e)) throw MotionDynamicLimitError(detail);
        throw std::runtime_error(detail);
      }
    }
  }

  return points;
}
struct AutomaticMotionTiming {
  std::vector<TimedMotionPoint> points;
  double duration_s;
  size_t adjustments;
};
// At most 8 extensions (1.25^8 < 6x). Always start from the original path so
// derivatives and nanosecond rounding never compound across retries.
inline AutomaticMotionTiming automatic_motion_timing(const std::vector<TimedMotionPoint> &original,
    const PositionMotionModel &model, const std::vector<double> &velocity_limits,
    const std::vector<double> &acceleration_limits,
    const std::function<void(double, double, const std::string &)> &on_retry = {}) {
  double seconds = original.empty() ? 0 : original.back().time_ns / 1e9;
  for (size_t attempt = 0; ; ++attempt) {
    try { return {stretch_motion(original, seconds, model, velocity_limits, acceleration_limits), seconds, attempt}; }
    catch (const MotionDynamicLimitError &e) {
      if (attempt == 8)
        throw std::runtime_error("自动延长运动时长已达 8 次上限，未执行: duration_s=" + motion_number(seconds) + " reason=" + e.what());
      const double next = seconds * 1.25;
      validate_motion_duration(next);
      if (on_retry) on_retry(seconds, next, e.what());
      seconds = next;
    }
  }
}
inline std::vector<double> combined_joint_target(const std::vector<double> &actual,
    const std::vector<std::pair<std::string, double>> &edits, const PositionMotionModel &model) {
  validate_position_target(actual, model);
  if (edits.empty() || edits.size() > 6) throw std::runtime_error("请指定 1–6 个关节目标");
  auto target = actual;
  std::vector<std::string> names;
  for (const auto &edit : edits) {
    if (std::find(names.begin(), names.end(), edit.first) != names.end()) throw std::runtime_error("关节目标名称重复");
    names.push_back(edit.first);
    target[arm_joint_index(edit.first)] = edit.second;
  }
  validate_position_target(target, model);
  return target;
}
}  // namespace easy_debug_bridge
