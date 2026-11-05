#include <cassert>
#include <iostream>

#include "easy_debug_bridge/object_detection.hpp"
using namespace easy_debug_bridge;
int main() {
  ObjectConfig config;
  config.roi_min = {-2, -2, -2};
  config.roi_max = {2, 2, 2};
  DownsampledImage image{2, 1, 4, "16UC1", 0, {0xe8, 0x03, 0, 0}};
  std::array<double, 9> k{100, 0, .5, 0, 100, .5, 0, 0, 1};
  auto points = object_points(image, k, {.1, .2, 1}, {1, 0, 0, 0}, config);
  assert(points.size() == 1 && std::abs(points[0][0] - .1) < 1e-6 && std::abs(points[0][2]) < 1e-6);
  image.is_bigendian = 1;
  image.data = {3, 232, 0, 0};
  assert(object_points(image, k, {0, 0, 0}, {0, 0, 0, 1}, config)[0][2] == 1);
  image.encoding = "32FC1";
  image.width = 1;
  image.data = {0x3f, 0x80, 0, 0};
  assert(object_points(image, k, {0, 0, 0}, {0, 0, 0, 1}, config)[0][2] == 1);
  image.data = {0x7f, 0xc0, 0, 0};
  assert(object_points(image, k, {0, 0, 0}, {0, 0, 0, 1}, config).empty());
  bool rejected = false;
  try {
    k[0] = 0;
    object_points(image, k, {0, 0, 0}, {0, 0, 0, 1}, config);
  } catch (...) {
    rejected = true;
  }
  assert(rejected);
  ObjectTracker tracker;
  std::vector<ObjectBox> boxes{{0, {0, 0, 0}, {.05, .05, .05}, 50}, {0, {.2, 0, 0}, {.05, .05, .05}, 50}};
  tracker.assign(boxes, 1000000000);
  auto first = boxes[0].id, second = boxes[1].id;
  assert(first != second);
  std::reverse(boxes.begin(), boxes.end());
  boxes[1].center[0] = .01;
  tracker.assign(boxes, 1100000000);
  assert(boxes[0].id == second && boxes[1].id == first);
  tracker.assign(boxes, 1800000000);
  assert(boxes[1].id != first);
  first = boxes[1].id;
  tracker.clear();
  tracker.assign(boxes, 1900000000);
  assert(boxes[1].id != first);
  std::cout << "Object projection/tracking tests passed\n";
}
