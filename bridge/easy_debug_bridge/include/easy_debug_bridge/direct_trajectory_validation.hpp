#pragma once
#include "easy_debug_bridge/trajectory_task_core.hpp"
#include "easy_debug_bridge/motion_timing.hpp"

namespace easy_debug_bridge {
// Validate requested interpolation against sampled measured/reference seeds
// (JTC open-loop can choose either). This is not a controller-side limiter:
// receive/update latency changes the real seed-to-first interval. No implicit
// timing or path modifications are made here.
inline void validate_direct_trajectory(const TrajectoryCommand &command,
    const PositionMotionModel &model, const std::vector<double> &seed,
    const std::vector<double> &seed_velocity, const std::vector<double> &vmax,
    const std::vector<double> &amax) {
  if (validate_trajectory_command(command)!=TrajectoryValidation::Ok)
    throw std::runtime_error("直接轨迹输入无效");
  if (command.joint_names != model.joint_names || vmax.size()!=seed.size() || amax.size()!=seed.size())
    throw std::runtime_error("直接轨迹关节顺序或限幅不匹配");
  validate_position_target(seed,model);
  if (seed_velocity.size()!=seed.size()) throw std::runtime_error("缺少控制器起始速度");
  for (size_t i=0;i<seed.size();++i)
    if (!std::isfinite(seed_velocity[i]) || !std::isfinite(vmax[i]) || !std::isfinite(amax[i]) || vmax[i]<=0 || amax[i]<=0)
      throw std::runtime_error("直接轨迹起始速度或限幅无效");
  std::vector<double> previous=seed, velocity=seed_velocity;
  int64_t previous_ns=0;
  for (const auto &point:command.points) {
    validate_position_target(point.positions,model);
    validate_motion_duration(point.time_from_start);
    const auto ns=static_cast<int64_t>(std::llround(point.time_from_start*1e9));
    if (ns<=previous_ns) throw std::runtime_error("直接轨迹纳秒时间必须严格递增");
    const double dt=(ns-previous_ns)/1e9;
    for (size_t i=0;i<seed.size();++i) {
      if (point.velocities.empty() || velocity.empty()) {
        // Preserve the existing arm position-only interpolation path. Its
        // velocity discontinuities cannot establish acceleration bounds.
        if (model.joint_names[i]==gripper_motion_joint()) throw std::runtime_error("夹爪直接轨迹需提供速度以核验样条");
        if (std::abs((point.positions[i]-previous[i])/dt)>vmax[i]) throw std::runtime_error("直接轨迹线性速度超限");
      } else {
        const std::vector<double> controls{previous[i],previous[i]+velocity[i]*dt/3,
          point.positions[i]-point.velocities.at(i)*dt/3,point.positions[i]};
        bounded_spline(controls,dt,vmax[i],amax[i]);
        bounded_position_spline(controls,model.lower[i],model.upper[i]);
      }
    }
    previous=point.positions;velocity=point.velocities;previous_ns=ns;
  }
}
}
