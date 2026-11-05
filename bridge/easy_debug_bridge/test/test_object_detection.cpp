#include <cassert>
#include <fstream>
#include <filesystem>
#include <chrono>

#include "easy_debug_bridge/object_detection.hpp"
using namespace easy_debug_bridge;
int main(int argc, char **argv) {
  assert(argc == 2);
  auto config = load_object_config(argv[1]);
  const auto temporary = std::filesystem::temp_directory_path() /
      ("object-config-test-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + ".json");
  for (const auto &text : {"{}", "{\"roi_min\":[0,0,0],\"roi_max\":[0,1,1]}",
                          "{\"roi_min\":[0,0,0],\"roi_max\":[1,1,1],\"voxel_m\":-1}",
                          "{\"roi_min\":[0,0,0],\"roi_max\":[1,1,1],\"min_cluster_points\":0}"}) {
    { std::ofstream output(temporary); output << text; }
    bool rejected = false;
    try { load_object_config(temporary.string()); } catch (const std::exception &) { rejected = true; }
    std::filesystem::remove(temporary);
    assert(rejected);
  }

  if (!object_detection_supported()) {
    assert(detect_objects({}, config).status == "error");
    return 0;
  }
  std::vector<ObjectPoint> points;
  for (int x = -50; x <= 50; ++x)
    for (int y = -50; y <= 50; ++y) points.push_back({x * .006, y * .006, -.15});
  auto empty = detect_objects(points, config);
  assert(empty.status == "empty" && empty.items.empty());
  for (double center : {-.12, .12})
    for (int x = 0; x < 10; ++x)
      for (int y = 0; y < 10; ++y) points.push_back({center + x * .006, y * .006, -.08});
  auto objects = detect_objects(points, config);
  assert(objects.status == "ok" && objects.items.size() == 2);
  for (const auto &box : objects.items) {
    assert(box.point_count >= 20);
    assert(box.size[0] > .04 && box.size[0] < .07);
    assert(std::abs(box.center[2] + .08) < .001);
  }
  assert(detect_objects({}, config).status == "no_table");
  points.clear();
  for (int x = 0; x < 10; ++x)
    for (int y = 0; y < 10; ++y) points.push_back({x * .006, y * .006, -.15});
  assert(detect_objects(points, config).status == "no_table");
  // A vertical wall must not be accepted as a table.
  points.clear();
  for (int y = -30; y < 30; ++y)
    for (int z = -30; z < 10; ++z) points.push_back({0, y * .006, z * .006});
  assert(detect_objects(points, config).status == "no_table");
}
