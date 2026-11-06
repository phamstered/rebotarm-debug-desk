#pragma once
#include "easy_debug_bridge/motion_timing.hpp"

namespace easy_debug_bridge {
inline std::string motion_point_summary(const TimedMotionPoint &point, size_t index) {
  const auto values = [](const std::vector<double> &v) {
    std::string out = "[";
    for (size_t i = 0; i < std::min(v.size(), size_t{8}); ++i) { if (i) out += ','; out += motion_number(v[i]); }
    return out + "] count=" + std::to_string(v.size());
  };
  return "index=" + std::to_string(index) + " time_s=" + motion_number(point.time_ns/1e9) +
      " positions=" + values(point.positions) + " velocities=" + values(point.velocities) + " accelerations=" + values(point.accelerations);
}
// One bounded line per joint; peaks are at knots, not continuous-spline maxima.
inline std::vector<std::string> motion_plan_summaries(const std::vector<TimedMotionPoint> &points,
    const PositionMotionModel &model, const std::vector<double> &vlimits, const std::vector<double> &alimits) {
  std::vector<std::string> result;
  for (size_t k = 0; k < std::min(size_t{7}, model.joint_names.size()); ++k) {
    std::ostringstream out; out << std::setprecision(17) << "joint=" << model.joint_names[k]
        << " unit=" << (model.joint_names[k] == gripper_motion_joint() ? "m" : "rad");
    if (k < vlimits.size()) out << " velocity_limit=" << vlimits[k];
    if (k < alimits.size()) out << " acceleration_limit=" << alimits[k];
    if (k < model.lower.size() && k < model.upper.size()) out << " position_limits=[" << model.lower[k] << ',' << model.upper[k] << ']';
    for (int field = 0; field < 3; ++field) {
      size_t missing = 0, invalid = 0, peak_index = 0; double peak = 0;
      for (size_t i = 0; i < points.size(); ++i) {
        const auto &values = field == 0 ? points[i].positions : field == 1 ? points[i].velocities : points[i].accelerations;
        if (k >= values.size()) { ++missing; continue; }
        if (!std::isfinite(values[k])) { ++invalid; continue; }
        if (std::abs(values[k]) > std::abs(peak)) { peak = values[k]; peak_index = i; }
      }
      out << ' ' << (field == 0 ? "p" : field == 1 ? "v" : "a") << "_knot_peak=" << peak
          << "@" << peak_index << " missing=" << missing << " nonfinite=" << invalid;
    }
    if (!points.empty() && k < points.front().positions.size() && k < points.back().positions.size())
      out << " endpoints=[" << points.front().positions[k] << ',' << points.back().positions[k] << ']';
    result.push_back(out.str());
  }
  return result;
}
}
