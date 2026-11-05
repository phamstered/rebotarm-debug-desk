#pragma once
#include <stdexcept>

#include "easy_debug_bridge/position_motion_core.hpp"
#include "easy_debug_bridge/rgbd_core.hpp"

namespace easy_debug_bridge {
using ObjectPoint = std::array<double, 3>;
struct ObjectConfig {
  ObjectPoint roi_min{-.8, -.8, -.5}, roi_max{.8, .8, 1.};
  double voxel_m = .005, plane_distance_m = .005, plane_angle_deg = 15., table_min_z = -.3, table_max_z = .1,
         min_height_m = .01, max_height_m = .3, cluster_tolerance_m = .015, max_extent_m = .35;
  int min_cluster_points = 20;
};
ObjectConfig load_object_config(const std::string &path);
bool object_detection_supported();
struct ObjectBox {
  uint64_t id = 0;
  ObjectPoint center{}, size{};
  size_t point_count = 0;
};
struct ObjectResult {
  std::string status = "no_table", message;
  std::vector<ObjectBox> items;
};
// Same preview pixels, optical intrinsics and timestamped TF as the displayed cloud.
inline std::vector<ObjectPoint> object_points(const DownsampledImage &depth, const std::array<double, 9> &k,
                                              const ObjectPoint &t, const std::array<double, 4> &q,
                                              const ObjectConfig &config) {
  if (!(k[0] > 0 && k[4] > 0) || !std::isfinite(k[0]) || !std::isfinite(k[4]) || !std::isfinite(k[2]) ||
      !std::isfinite(k[5]))
    throw std::runtime_error("Invalid camera intrinsics");
  double norm = 0;
  for (auto n : q) norm += n * n;
  if (!std::isfinite(norm) || std::abs(norm - 1) > 0.01) throw std::runtime_error("Invalid camera rotation");
  for (auto n : t)
    if (!std::isfinite(n)) throw std::runtime_error("Invalid camera translation");
  std::string encoding = depth.encoding;
  for (auto &c : encoding) c = static_cast<char>(std::tolower(c));
  const bool floating = encoding == "32fc1";
  if (!floating && encoding != "16uc1" && encoding != "mono16")
    throw std::runtime_error("Unsupported object depth encoding");
  const size_t bpp = floating ? 4 : 2;
  if (depth.step < size_t(depth.width) * bpp || depth.data.size() < size_t(depth.step) * depth.height)
    throw std::runtime_error("Truncated object depth image");
  std::vector<ObjectPoint> points;
  const uint32_t stride =
      std::max(1u, static_cast<uint32_t>(std::ceil(std::sqrt(double(depth.width) * depth.height / 30000.))));
  for (uint32_t v = 0; v < depth.height; v += stride)
    for (uint32_t u = 0; u < depth.width; u += stride) {
      const auto *bytes = depth.data.data() + size_t(v) * depth.step + u * bpp;
      uint32_t bits = 0;
      for (size_t i = 0; i < bpp; ++i)
        bits |= uint32_t(bytes[i]) << (8 * (depth.is_bigendian ? bpp - 1 - i : i));
      double z;
      if (floating) {
        float value;
        std::memcpy(&value, &bits, 4);
        z = value;
      } else
        z = bits * .001;
      if (!std::isfinite(z) || z < .05 || z > 3.) continue;
      ObjectPoint p{(u + .5 - k[2]) * z / k[0], (v + .5 - k[5]) * z / k[4], z};
      ObjectPoint cross{2 * (q[1] * p[2] - q[2] * p[1]), 2 * (q[2] * p[0] - q[0] * p[2]),
                        2 * (q[0] * p[1] - q[1] * p[0])};
      ObjectPoint world{p[0] + q[3] * cross[0] + q[1] * cross[2] - q[2] * cross[1] + t[0],
                        p[1] + q[3] * cross[1] + q[2] * cross[0] - q[0] * cross[2] + t[1],
                        p[2] + q[3] * cross[2] + q[0] * cross[1] - q[1] * cross[0] + t[2]};
      bool inside = true;
      for (int a = 0; a < 3; ++a) inside &= world[a] >= config.roi_min[a] && world[a] <= config.roi_max[a];
      if (inside) points.push_back(world);
    }
  return points;
}
class ObjectTracker {
  std::vector<ObjectBox> previous_;
  uint64_t next_ = 1;
  int64_t stamp_ = 0;

 public:
  void clear() {
    previous_.clear();
    stamp_ = 0;
  }
  void assign(std::vector<ObjectBox> &items, int64_t stamp) {
    if (stamp <= stamp_ || stamp - stamp_ > 500000000LL) previous_.clear();
    std::vector<bool> used(previous_.size());
    for (auto &box : items) {
      double best = .06 * .06;
      size_t match = previous_.size();
      for (size_t i = 0; i < previous_.size(); ++i) {
        if (used[i]) continue;
        double distance = 0;
        bool size_ok = true;
        for (int a = 0; a < 3; ++a) {
          distance += std::pow(box.center[a] - previous_[i].center[a], 2);
          size_ok &= std::abs(box.size[a] - previous_[i].size[a]) < .05;
        }
        if (size_ok && distance < best) {
          best = distance;
          match = i;
        }
      }
      if (match < previous_.size()) {
        box.id = previous_[match].id;
        used[match] = true;
      } else
        box.id = next_++;
    }
    previous_ = items;
    stamp_ = stamp;
  }
};
ObjectResult detect_objects(const std::vector<ObjectPoint> &points, const ObjectConfig &config);
inline std::string object_result_json(const ObjectResult &result, uint64_t frame_seq) {
  std::ostringstream out;
  out << "{\"status\":" << position_json_quote(result.status)
      << ",\"message\":" << position_json_quote(result.message) << ",\"frame_seq\":" << frame_seq
      << ",\"items\":[";
  for (size_t i = 0; i < result.items.size(); ++i) {
    const auto &b = result.items[i];
    if (i) out << ",";
    out << "{\"id\":" << b.id << ",\"center\":[" << b.center[0] << "," << b.center[1] << "," << b.center[2]
        << "],\"size\":[" << b.size[0] << "," << b.size[1] << "," << b.size[2]
        << "],\"point_count\":" << b.point_count << "}";
  }
  return out.str() + "]}";
}
}  // namespace easy_debug_bridge
