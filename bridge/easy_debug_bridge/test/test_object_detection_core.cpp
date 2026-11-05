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
  const std::vector<ObjectBox> scene{{0, {0, 0, 0}, {.05, .05, .05}, 50},
                                     {0, {.2, 0, 0}, {.05, .05, .05}, 50}};
  ObjectTracker tracker;
  int64_t stamp = 1000000000;
  auto frame = [&](std::vector<ObjectBox> input, int64_t advance = 100000000) {
    stamp += advance;
    tracker.assign(input, stamp);
    return input;
  };
  assert(frame(scene).empty());
  assert(frame(scene).empty());
  auto boxes = frame(scene);
  assert(boxes.size() == 2);
  const auto first = boxes[0].id, second = boxes[1].id;
  auto reversed = scene;
  std::reverse(reversed.begin(), reversed.end());
  reversed[1].center[0] = .015;
  boxes = frame(reversed);
  assert(boxes[0].id == second && boxes[1].id == first);
  assert(std::abs(boxes[1].center[0] - .015) < 1e-12);  // Output remains measured, not smoothed.
  assert(frame({}).empty());
  assert(frame({}).empty());
  boxes = frame(scene, 600000000);
  assert(boxes[0].id == first && boxes[1].id == second);
  assert(frame(scene, 1600000000).empty());
  assert(frame(scene).empty());
  boxes = frame(scene);
  assert(boxes[0].id != first);
  tracker.clear();
  assert(frame(scene).empty());
  // One-frame flicker never allocates a public ID; confirmation requires consecutive hits.
  ObjectTracker noise;
  std::vector<ObjectBox> one{scene[0]}, none;
  for (int i = 0; i < 10; ++i) {
    auto input = one;
    noise.assign(input, stamp += 100000000);
    assert(input.empty());
    noise.assign(none, stamp += 100000000);
  }
  for (int i = 0; i < 3; ++i) {
    boxes = one;
    noise.assign(boxes, stamp += 100000000);
  }
  assert(boxes.size() == 1 && boxes[0].id == 1);
  // A backwards timestamp starts a fresh track and cannot resurrect the old ID.
  auto old = boxes[0].id;
  boxes = one;
  noise.assign(boxes, 1);
  assert(boxes.empty());
  boxes = one;
  noise.assign(boxes, 2);
  boxes = one;
  noise.assign(boxes, 3);
  assert(boxes[0].id != old);
  // Global association preserves both IDs where greedy nearest-first would steal a match.
  ObjectTracker global;
  auto pair = scene;
  pair[1].center[0] = .09;
  for (int i = 0; i < 3; ++i) {
    boxes = pair;
    global.assign(boxes, 1000000000 + i * 100000000);
  }
  auto id0 = boxes[0].id, id1 = boxes[1].id;
  auto ambiguous = pair;
  ambiguous[0].center[0] = .04;
  ambiguous[1].center[0] = -.07;
  boxes = ambiguous;
  global.assign(boxes, 1400000000);
  assert(boxes.size() == 2 && boxes[0].id == id1 && boxes[1].id == id0);
  // Churn is bounded and eventually expires; new stationary observations can recover.
  for (int i = 0; i < 100; ++i) {
    boxes = scene;
    boxes[0].center[0] = i % 2 ? 1. : -1.;
    global.assign(boxes, 2000000000LL + i * 100000000);
  }
  for (int i = 0; i < 3; ++i) {
    boxes = scene;
    global.assign(boxes, 20000000000LL + i * 100000000);
  }
  assert(boxes.size() == 2);
  std::cout << "Object projection/tracking tests passed\n";
}
