#include "easy_debug_bridge/rgb_target.hpp"
#include <cassert>
#include <iostream>
#include <thread>
using namespace easy_debug_bridge;
// Synthetic downward wrist camera, green 50 mm cube top at z=.05 m.
RgbTargetFrame frame(int tick, bool depth = true, double camera_x = 0,
                     double camera_z = .4, double object_x = 0) {
  RgbTargetFrame f;
  f.k = {300, 0, 160, 0, 300, 120, 0, 0, 1};
  f.distortion_model = "plumb_bob";
  f.source_frame = "color_optical";
  f.subscription = "lease";
  f.generation = 1;
  f.stamp_ns = 1000000000LL + tick * 50000000LL;
  f.depth_stamp_ns = f.stamp_ns;
  f.camera_to_base.position = {camera_x, 0, camera_z};
  f.camera_to_base.orientation = {1, 0, 0, 0};
  auto rgb = std::make_shared<DownsampledImage>();
  rgb->width = 320;
  rgb->height = 240;
  rgb->step = 960;
  rgb->encoding = "rgb8";
  rgb->data.resize(320 * 240 * 3, 30);
  auto d = std::make_shared<DownsampledImage>();
  d->width = 320;
  d->height = 240;
  d->step = 640;
  d->encoding = "16UC1";
  d->data.resize(320 * 240 * 2);
  const double z = camera_z - .05;
  const int cx = int(160 + (object_x - camera_x) * 300 / z),
            half = int(.025 * 300 / z);
  for (int y = 120 - half; y <= 120 + half; ++y)
    for (int x = cx - half; x <= cx + half; ++x)
      if (x >= 0 && x < 320 && y >= 0 && y < 240) {
        auto offset = (y * 320 + x) * 3;
        rgb->data[offset] = 20;
        rgb->data[offset + 1] = 220;
        rgb->data[offset + 2] = 20;
        auto value = unsigned(std::lround(z * 1000));
        d->data[(y * 320 + x) * 2] = value & 255;
        d->data[(y * 320 + x) * 2 + 1] = value >> 8;
      }
  f.rgb = rgb;
  if (depth)
    f.depth = d;
  return f;
}
ObjectBox box() { return {7, {0, 0, .025}, {.05, .05, .05}, 300}; }
void confirmed(RgbTargetTracker &t, RgbTargetConfig c = {}) {
  auto s = t.select(frame(0), box(), c);
  assert(s.mode == "confirming");
  t.update(frame(1));
  t.update(frame(2));
  assert(t.snapshot().mode == "rgbd");
  assert(t.snapshot().identity_valid);
}
int main() {
  assert(rgb_target_supported());
  RgbTargetTracker t;
  confirmed(t);
  const auto id = t.snapshot().target_id;
  // Camera translation moves pixels, while the selected world target stays
  // fixed.
  t.update(frame(3, true, .01));
  auto s = t.snapshot();
  assert(s.target_id == id && s.identity_valid);
  assert(std::abs(s.box.center[0]) < .001);
  // Missing depth does not freeze RGB tracking or change identity; metric
  // motion stays blocked.
  t.update(frame(4, false, .01));
  s = t.snapshot();
  assert(s.mode == "rgb" && s.target_id == id && !s.metric_ready &&
         s.identity_valid);
  t.update(frame(5, false, .01, .4, .003));
  s = t.snapshot();
  assert(s.identity_valid && std::abs(s.box.center[0] - .003) < .002);
  // Opaque occlusion must latch uncertain. A later similar green target cannot
  // restore it.
  auto hidden = frame(6, false);
  auto blank = std::make_shared<DownsampledImage>(*hidden.rgb);
  std::fill(blank->data.begin(), blank->data.end(), 30);
  hidden.rgb = blank;
  t.update(hidden);
  assert(t.snapshot().mode == "uncertain");
  t.update(frame(7));
  assert(!t.snapshot().identity_valid);
  confirmed(t);
  assert(t.snapshot().target_id != id);
  // An explicit verified plane is required for RGB metric observations.
  RgbTargetConfig verified;
  verified.plane_verified = true;
  confirmed(t, verified);
  t.update(frame(3, false));
  assert(t.snapshot().metric_ready);
  const auto yaw = t.snapshot().locked_yaw;
  t.update(frame(4, false));
  assert(t.snapshot().locked_yaw == yaw);
  RgbTargetFrame changed;
  // Nearby green objects remain separate; merged contours and occlusion latch
  // uncertainty.
  confirmed(t);
  changed = frame(3);
  auto neighbors = std::make_shared<DownsampledImage>(*changed.rgb);
  for (int y = 100; y < 140; ++y)
    for (int x = 230; x < 270; ++x) {
      auto i = (y * 320 + x) * 3;
      neighbors->data[i] = 20;
      neighbors->data[i + 1] = 220;
      neighbors->data[i + 2] = 20;
    }
  changed.rgb = neighbors;
  t.update(changed);
  assert(t.snapshot().identity_valid);
  changed = frame(4);
  auto merged = std::make_shared<DownsampledImage>(*changed.rgb);
  for (int y = 99; y <= 141; ++y)
    for (int x = 180; x < 220; ++x) {
      auto i = (y * 320 + x) * 3;
      merged->data[i] = 20;
      merged->data[i + 1] = 220;
      merged->data[i + 2] = 20;
    }
  changed.rgb = merged;
  t.update(changed);
  assert(t.snapshot().mode == "uncertain");
  confirmed(t);
  changed = frame(3);
  auto occluded = std::make_shared<DownsampledImage>(*changed.rgb);
  for (int y = 90; y < 150; ++y)
    for (int x = 135; x < 150; ++x)
      for (int c = 0; c < 3; ++c)
        occluded->data[(y * 320 + x) * 3 + c] = 30;
  changed.rgb = occluded;
  t.update(changed);
  assert(t.snapshot().mode == "uncertain");
  confirmed(t);
  changed = frame(3);
  changed.k[0] += 1;
  t.update(changed);
  assert(!t.snapshot().identity_valid);
  confirmed(t);
  changed = frame(3);
  changed.generation = 2;
  t.update(changed);
  assert(!t.snapshot().identity_valid);
  confirmed(t);
  changed = frame(3);
  changed.source_frame = "other_camera";
  t.update(changed);
  assert(!t.snapshot().identity_valid);
  t.select(frame(0), box(), {});
  t.update(frame(1, false));
  assert(t.snapshot().mode == "uncertain");
  confirmed(t);
  t.update(frame(1));
  assert(t.snapshot().mode == "uncertain");
  confirmed(t);
  t.update(frame(3, true, 0, .4, .018));
  assert(t.snapshot().mode == "uncertain");
  confirmed(t);
  changed = frame(3);
  auto bad = std::make_shared<DownsampledImage>(*changed.depth);
  for (size_t i = 0; i < bad->data.size(); i += 2) {
    bad->data[i] = 200;
    bad->data[i + 1] = 0;
  }
  changed.depth = bad;
  t.update(changed);
  assert(t.snapshot().mode == "uncertain");
  confirmed(t);
  std::this_thread::sleep_for(std::chrono::milliseconds(505));
  assert(t.snapshot().mode == "uncertain");
  confirmed(t);
  const auto preserved = t.snapshot().target_id;
  auto malformed = box();
  malformed.center[0] = std::numeric_limits<double>::quiet_NaN();
  bool rejected = false;
  try {
    t.select(frame(0), malformed, {});
  } catch (...) {
    rejected = true;
  }
  assert(rejected && t.snapshot().target_id == preserved);
  rejected = false;
  auto invalid_frame = frame(0);
  invalid_frame.k[0] = 1e300;
  try {
    t.select(invalid_frame, box(), {});
  } catch (...) {
    rejected = true;
  }
  assert(rejected && t.snapshot().target_id == preserved);
  assert(t.matches_config({}));
  RgbTargetConfig changed_config;
  changed_config.max_rgb_seconds = 10;
  assert(!t.matches_config(changed_config));
  t.release();
  assert(t.snapshot().target_id.empty());
  std::cout << "RGB identity, projection, depth handoff, geometry gates and "
               "failure boundaries passed\n";
}
