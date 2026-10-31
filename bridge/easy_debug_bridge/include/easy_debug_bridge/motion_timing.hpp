#pragma once
#include "easy_debug_bridge/position_motion_core.hpp"
#include <cstdint>

namespace easy_debug_bridge {
inline void validate_motion_duration(double seconds) {
  if (!std::isfinite(seconds) || seconds < 1e-9 || seconds > 2147483647.)
    throw std::runtime_error("运动时长须为正数且能用 ROS 时间表示");
}
struct TimedMotionPoint {
  std::vector<double> positions, velocities, accelerations, effort;
  int64_t time_ns{};
};
// Convex-hull bounds on cubic/quintic interpolation, subdivided when needed.
inline void bounded_spline(const std::vector<double> &b, double h, double vmax, double amax, int depth=0) {
  std::vector<double> v, a;
  for (size_t i=1;i<b.size();++i) v.push_back((b.size()-1)*(b[i]-b[i-1])/h);
  for (size_t i=1;i<v.size();++i) a.push_back((v.size()-1)*(v[i]-v[i-1])/h);
  auto within=[](double x,double limit){return std::isfinite(x) && std::abs(x)<=limit+1e-7;};
  if (!within(v.front(),vmax)||!within(v.back(),vmax)||!within(a.front(),amax)||!within(a.back(),amax))
    throw std::runtime_error("指定时长导致轨迹速度或加速度超限");
  if (std::all_of(v.begin(),v.end(),[&](double x){return within(x,vmax);}) &&
      std::all_of(a.begin(),a.end(),[&](double x){return within(x,amax);})) return;
  if (depth>=12) throw std::runtime_error("无法确认样条速度/加速度满足上限，请增加时长");
  auto row=b;std::vector<double> left{b.front()},right{b.back()};
  while(row.size()>1){for(size_t i=0;i+1<row.size();++i) row[i]=(row[i]+row[i+1])/2;row.pop_back();left.push_back(row.front());right.push_back(row.back());}
  std::reverse(right.begin(),right.end());
  bounded_spline(left,h/2,vmax,amax,depth+1);bounded_spline(right,h/2,vmax,amax,depth+1);
}
// Preserve the planned path; compression must satisfy continuous spline bounds.
inline std::vector<TimedMotionPoint> stretch_motion(std::vector<TimedMotionPoint> points,
    double seconds, const PositionMotionModel &model,
    const std::vector<double> &velocity_limits = std::vector<double>(6,1.),
    const std::vector<double> &acceleration_limits = std::vector<double>(6,1.)) {
  validate_motion_duration(seconds);
  if (points.size() < 2 || points.size() > 10000) throw std::runtime_error("规划轨迹点数无效");
  int64_t previous = -1;
  for (const auto &point : points) {
    validate_position_target(point.positions, model);
    for (const auto *values : {&point.velocities, &point.accelerations, &point.effort})
      if ((!values->empty() && values->size() != 6) ||
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
  if (velocity_limits.size()!=6 || acceleration_limits.size()!=6) throw std::runtime_error("运动限幅不完整");
  for(size_t k=0;k<6;++k) {
    if(!std::isfinite(velocity_limits[k])||!std::isfinite(acceleration_limits[k])||velocity_limits[k]<=0||acceleration_limits[k]<=0)
      throw std::runtime_error("运动限幅无效");
    for(size_t i=1;i<points.size();++i) {
      const auto &x=points[i-1],&y=points[i];double h=(y.time_ns-x.time_ns)/1e9;
      if(x.velocities.empty()||y.velocities.empty()) {
        if(scale<1 || std::abs((y.positions[k]-x.positions[k])/h)>velocity_limits[k])
          throw std::runtime_error("缺少速度数据或轨迹超限，无法验证指定时长");
        continue;
      }
      double p=x.positions[k],q=y.positions[k],v=x.velocities[k],w=y.velocities[k];
      if(!x.accelerations.empty()&&!y.accelerations.empty())
        bounded_spline({p,p+v*h/5,p+2*v*h/5+x.accelerations[k]*h*h/20,
            q-2*w*h/5+y.accelerations[k]*h*h/20,q-w*h/5,q},h,velocity_limits[k],acceleration_limits[k]);
      else bounded_spline({p,p+v*h/3,q-w*h/3,q},h,velocity_limits[k],acceleration_limits[k]);
    }
  }

  return points;
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
