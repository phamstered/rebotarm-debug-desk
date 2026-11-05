#include <boost/property_tree/json_parser.hpp>
#include <boost/property_tree/ptree.hpp>

#include "easy_debug_bridge/object_detection.hpp"
#ifdef EASY_DEBUG_HAS_PCL
#include <pcl/common/common.h>
#include <pcl/filters/voxel_grid.h>
#include <pcl/segmentation/extract_clusters.h>
#include <pcl/segmentation/sac_segmentation.h>
#endif
namespace easy_debug_bridge {
ObjectConfig load_object_config(const std::string &path) {
  ObjectConfig c;
  boost::property_tree::ptree tree;
  boost::property_tree::read_json(path, tree);
  auto scalar = [&](const char *key, double &value, double lo, double hi) {
    value = tree.get<double>(key, value);
    if (!std::isfinite(value) || value < lo || value > hi)
      throw std::runtime_error(std::string("Invalid object config: ") + key);
  };
  auto vector = [&](const char *key, ObjectPoint &value) {
    const auto &array = tree.get_child(key);
    size_t i = 0;
    for (const auto &entry : array) {
      if (i == 3 || !entry.first.empty()) throw std::runtime_error("Invalid ROI array");
      value[i] = entry.second.get_value<double>();
      if (!std::isfinite(value[i]) || std::abs(value[i]) > 3) throw std::runtime_error("Invalid ROI bounds");
      ++i;
    }
    if (i != 3) throw std::runtime_error("ROI requires 3 coordinates");
  };
  vector("roi_min", c.roi_min);
  vector("roi_max", c.roi_max);
  for (int a = 0; a < 3; ++a)
    if (c.roi_min[a] >= c.roi_max[a]) throw std::runtime_error("ROI min must be below max");
  scalar("voxel_m", c.voxel_m, .003, .02);
  scalar("plane_distance_m", c.plane_distance_m, .002, .02);
  scalar("plane_angle_deg", c.plane_angle_deg, 1, 20);
  scalar("table_min_z", c.table_min_z, -2, 2);
  scalar("table_max_z", c.table_max_z, -2, 2);
  scalar("min_height_m", c.min_height_m, .005, .1);
  scalar("max_height_m", c.max_height_m, .02, .5);
  scalar("cluster_tolerance_m", c.cluster_tolerance_m, .005, .05);
  scalar("max_extent_m", c.max_extent_m, .03, .5);
  c.min_cluster_points = tree.get<int>("min_cluster_points", c.min_cluster_points);
  if (c.min_cluster_points < 5 || c.min_cluster_points > 1000 || c.table_min_z >= c.table_max_z ||
      c.min_height_m >= c.max_height_m)
    throw std::runtime_error("Invalid object config ranges");
  return c;
}
bool object_detection_supported() {
#ifdef EASY_DEBUG_HAS_PCL
  return true;
#else
  return false;
#endif
}
ObjectResult detect_objects(const std::vector<ObjectPoint> &points, const ObjectConfig &c) {
#ifndef EASY_DEBUG_HAS_PCL
  (void)points;
  (void)c;
  return {"error", "Bridge built without PCL", {}};
#else
  using Cloud = pcl::PointCloud<pcl::PointXYZ>;
  auto input = Cloud::Ptr(new Cloud);
  for (const auto &p : points) input->push_back(pcl::PointXYZ(p[0], p[1], p[2]));
  auto cloud = Cloud::Ptr(new Cloud);
  pcl::VoxelGrid<pcl::PointXYZ> voxel;
  voxel.setInputCloud(input);
  voxel.setLeafSize(c.voxel_m, c.voxel_m, c.voxel_m);
  voxel.filter(*cloud);
  if (cloud->size() < 100) return {"no_table", "ROI 内有效点不足", {}};
  // Restrict table candidates by base-frame height; dominant surfaces inside this band still require scene tuning.
  auto candidates = Cloud::Ptr(new Cloud);
  for (const auto &p : *cloud)
    if (p.z >= c.table_min_z && p.z <= c.table_max_z) candidates->push_back(p);
  if (candidates->size() < 100) return {"no_table", "桌面高度范围内点不足", {}};
  pcl::SACSegmentation<pcl::PointXYZ> plane;
  plane.setOptimizeCoefficients(true);
  plane.setModelType(pcl::SACMODEL_PERPENDICULAR_PLANE);
  plane.setMethodType(pcl::SAC_RANSAC);
  plane.setAxis(Eigen::Vector3f::UnitZ());
  plane.setEpsAngle(c.plane_angle_deg * 3.141592653589793 / 180.);
  plane.setDistanceThreshold(c.plane_distance_m);
  plane.setMaxIterations(150);
  plane.setInputCloud(candidates);
  pcl::PointIndices inliers;
  pcl::ModelCoefficients coefficients;
  plane.segment(inliers, coefficients);
  if (inliers.indices.size() < 100 || inliers.indices.size() < candidates->size() * .2 ||
      coefficients.values.size() != 4)
    return {"no_table", "未找到可靠的水平桌面", {}};
  Eigen::Vector4f low, high;
  pcl::getMinMax3D(*candidates, inliers.indices, low, high);
  if (high[0] - low[0] < .15 || high[1] - low[1] < .15) return {"no_table", "桌面可见范围过小", {}};
  auto p = coefficients.values;
  if (p[2] < 0)
    for (auto &v : p) v = -v;
  const double normal = std::sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
  if (normal < .99 || normal > 1.01 || p[2] / normal < std::cos(c.plane_angle_deg * 3.141592653589793 / 180.))
    return {"no_table", "桌面法向无效", {}};
  auto above = Cloud::Ptr(new Cloud);
  for (const auto &point : *cloud) {
    double height = p[0] * point.x + p[1] * point.y + p[2] * point.z + p[3];
    if (height >= c.min_height_m && height <= c.max_height_m) above->push_back(point);
  }
  ObjectResult result{"empty", "未发现分离的桌面物体", {}};
  if (above->empty()) return result;
  auto tree = pcl::search::KdTree<pcl::PointXYZ>::Ptr(new pcl::search::KdTree<pcl::PointXYZ>);
  tree->setInputCloud(above);
  pcl::EuclideanClusterExtraction<pcl::PointXYZ> cluster;
  cluster.setClusterTolerance(c.cluster_tolerance_m);
  cluster.setMinClusterSize(c.min_cluster_points);
  cluster.setMaxClusterSize(30000);
  cluster.setSearchMethod(tree);
  cluster.setInputCloud(above);
  std::vector<pcl::PointIndices> groups;
  cluster.extract(groups);
  for (const auto &group : groups) {
    pcl::getMinMax3D(*above, group.indices, low, high);
    ObjectBox box;
    box.center = {(low[0] + high[0]) / 2., (low[1] + high[1]) / 2., (low[2] + high[2]) / 2.};
    box.size = {std::max(c.voxel_m, double(high[0] - low[0])), std::max(c.voxel_m, double(high[1] - low[1])),
                std::max(c.voxel_m, double(high[2] - low[2]))};
    if (*std::max_element(box.size.begin(), box.size.end()) > c.max_extent_m) continue;
    box.point_count = group.indices.size();
    result.items.push_back(box);
    if (result.items.size() == 20) break;
  }
  if (!result.items.empty()) {
    result.status = "ok";
    result.message = "可见点云包围盒";
  }
  return result;
#endif
}
}  // namespace easy_debug_bridge
