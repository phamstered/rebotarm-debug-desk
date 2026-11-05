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
  struct Track {
    ObjectBox reference;
    int64_t seen;
    unsigned hits = 1;
  };
  std::vector<Track> tracks_;
  uint64_t next_ = 1;
  int64_t stamp_ = 0;
  static constexpr int64_t retention_ns = 1500000000LL;
  static constexpr int64_t tentative_ns = 350000000LL;
  static constexpr size_t max_tracks = 60;

  static double cost(const ObjectBox &a, const ObjectBox &b) {
    double distance = 0, intersection = 1, volume_a = 1, volume_b = 1, size_delta = 0;
    for (int axis = 0; axis < 3; ++axis) {
      distance += std::pow(a.center[axis] - b.center[axis], 2);
      if (std::abs(a.size[axis] - b.size[axis]) > std::max(.08, b.size[axis])) return 1e6;
      intersection *=
          std::max(0., std::min(a.center[axis] + a.size[axis] / 2, b.center[axis] + b.size[axis] / 2) -
                           std::max(a.center[axis] - a.size[axis] / 2, b.center[axis] - b.size[axis] / 2));
      volume_a *= a.size[axis];
      volume_b *= b.size[axis];
      size_delta += std::abs(a.size[axis] - b.size[axis]) / std::max(.02, b.size[axis]);
    }
    if (distance > .1 * .1) return 1e6;
    const double iou = intersection / std::max(1e-12, volume_a + volume_b - intersection);
    return std::sqrt(distance) / .1 + .5 * (1 - iou) + .05 * size_delta;
  }
  // Rectangular Hungarian assignment. Dummy columns allow every observation to
  // remain unmatched; association is global rather than detection-order greedy.
  static std::vector<size_t> associate(const std::vector<std::vector<double>> &costs) {
    const size_t n = costs.size(), m = n ? costs[0].size() : 0;
    std::vector<double> u(n + 1), v(m + 1);
    std::vector<size_t> p(m + 1), way(m + 1), result(n, m);
    for (size_t i = 1; i <= n; ++i) {
      p[0] = i;
      size_t j0 = 0;
      std::vector<double> best(m + 1, 1e9);
      std::vector<bool> used(m + 1);
      do {
        used[j0] = true;
        const size_t i0 = p[j0];
        double delta = 1e9;
        size_t j1 = 0;
        for (size_t j = 1; j <= m; ++j)
          if (!used[j]) {
            const double current = costs[i0 - 1][j - 1] - u[i0] - v[j];
            if (current < best[j]) {
              best[j] = current;
              way[j] = j0;
            }
            if (best[j] < delta) {
              delta = best[j];
              j1 = j;
            }
          }
        for (size_t j = 0; j <= m; ++j) {
          if (used[j]) {
            u[p[j]] += delta;
            v[j] -= delta;
          } else
            best[j] -= delta;
        }
        j0 = j1;
      } while (p[j0]);
      do {
        const size_t j1 = way[j0];
        p[j0] = p[j1];
        j0 = j1;
      } while (j0);
    }
    for (size_t j = 1; j <= m; ++j)
      if (p[j]) result[p[j] - 1] = j - 1;
    return result;
  }

 public:
  void clear() {
    tracks_.clear();
    stamp_ = 0;
  }
  void assign(std::vector<ObjectBox> &items, int64_t stamp) {
    if (stamp <= stamp_) clear();
    stamp_ = stamp;
    tracks_.erase(std::remove_if(tracks_.begin(), tracks_.end(),
                                 [&](const Track &t) {
                                   return stamp - t.seen > (t.reference.id ? retention_ns : tentative_ns);
                                 }),
                  tracks_.end());
    // Detection and history bounds keep association and memory costs predictable.
    if (items.size() > 20) items.resize(20);
    const size_t existing = tracks_.size();
    std::vector<std::vector<double>> costs(items.size(), std::vector<double>(existing + items.size(), 2.));
    for (size_t i = 0; i < items.size(); ++i)
      for (size_t j = 0; j < existing; ++j) costs[i][j] = cost(items[i], tracks_[j].reference);
    const auto matches = associate(costs);
    std::vector<ObjectBox> visible;
    std::vector<bool> observed(existing);
    for (size_t i = 0; i < items.size(); ++i) {
      auto box = items[i];
      box.id = 0;
      if (matches[i] < existing && costs[i][matches[i]] < 2.) {
        auto &track = tracks_[matches[i]];
        observed[matches[i]] = true;
        track.seen = stamp;
        if (++track.hits >= 3 && !track.reference.id) track.reference.id = next_++;
        box.id = track.reference.id;
        // Smooth association reference only; send the current measured box.
        for (int axis = 0; axis < 3; ++axis) {
          track.reference.center[axis] = .6 * track.reference.center[axis] + .4 * box.center[axis];
          track.reference.size[axis] = .6 * track.reference.size[axis] + .4 * box.size[axis];
        }
        if (box.id) visible.push_back(box);
      } else if (tracks_.size() < max_tracks) {
        tracks_.push_back({box, stamp, 1});
      }
    }
    for (size_t j = 0; j < existing; ++j)
      if (!observed[j] && !tracks_[j].reference.id) tracks_[j].hits = 0;
    items = std::move(visible);
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
