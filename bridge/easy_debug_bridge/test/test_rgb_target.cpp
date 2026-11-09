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
// A 45-degree cube has a diamond footprint occupying half of its XY AABB.
RgbTargetFrame rotated_frame(int tick) {
  auto f = frame(tick);
  auto rgb = std::make_shared<DownsampledImage>(*f.rgb);
  auto d = std::make_shared<DownsampledImage>(*f.depth);
  std::fill(rgb->data.begin(), rgb->data.end(), 30);
  std::fill(d->data.begin(), d->data.end(), 0);
  for (int y = 90; y <= 150; ++y)
    for (int x = 130; x <= 190; ++x)
      if (std::abs(x-160) + std::abs(y-120) <= 30) {
        const int i = y*320+x;
        rgb->data[i*3]=20; rgb->data[i*3+1]=220; rgb->data[i*3+2]=20;
        d->data[i*2]=350&255; d->data[i*2+1]=350>>8;
      }
  f.rgb=rgb; f.depth=d; return f;
}
// Ray-cast a rotated solid cube viewed obliquely: visible side faces must
// initialize within the volume projection rather than only its top rectangle.
RgbTargetFrame oblique_frame(int tick) {
  auto f=frame(tick);
  const double tilt=.52, yaw=.52, c=std::cos(yaw), s=std::sin(yaw);
  f.camera_to_base.position={.4*std::sin(tilt),0,.025+.4*std::cos(tilt)};
  f.camera_to_base.orientation={std::cos(tilt/2),0,-std::sin(tilt/2),0};
  auto rgb=std::make_shared<DownsampledImage>(*f.rgb);
  auto d=std::make_shared<DownsampledImage>(*f.depth);
  std::fill(rgb->data.begin(),rgb->data.end(),30);
  std::fill(d->data.begin(),d->data.end(),0);
  const auto origin=f.camera_to_base.position;
  const ObjectPoint local_origin{c*origin[0]+s*origin[1],-s*origin[0]+c*origin[1],origin[2]-.025};
  for(int y=0;y<240;++y) for(int x=0;x<320;++x) {
    auto v=tcp_rotate_vector(f.camera_to_base.orientation,{(x-160)/300.,(y-120)/300.,1});
    const ObjectPoint direction{c*v[0]+s*v[1],-s*v[0]+c*v[1],v[2]};
    double near=0,far=3;
    for(int a=0;a<3;++a) {
      if(std::abs(direction[a])<1e-9) {
        if(std::abs(local_origin[a])>.025)far=-1;
      } else {
        auto lo=(-.025-local_origin[a])/direction[a],hi=(.025-local_origin[a])/direction[a];
        if(lo>hi)std::swap(lo,hi);
        near=std::max(near,lo);far=std::min(far,hi);
      }
    }
    if(near>=far)continue;
    const int i=y*320+x,z=std::lround(near*1000);
    rgb->data[i*3]=20;rgb->data[i*3+1]=220;rgb->data[i*3+2]=20;
    d->data[i*2]=z&255;d->data[i*2+1]=z>>8;
  }
  f.rgb=rgb;f.depth=d;return f;
}
int main() {
  assert(rgb_target_supported());
  RgbTargetTracker t;
  auto oblique_box=box();
  oblique_box.size[0]=oblique_box.size[1]=.05*(std::cos(.52)+std::sin(.52));
  assert(t.select(oblique_frame(0),oblique_box,{}).mode=="confirming");
  t.update(oblique_frame(1));t.update(oblique_frame(2));
  assert(t.snapshot().identity_valid);
  auto rotated_box = box();
  rotated_box.size[0] = rotated_box.size[1] = .05 * std::sqrt(2.);
  auto rotated = t.select(rotated_frame(0), rotated_box, {});
  assert(rotated.mode == "confirming");
  t.update(rotated_frame(1)); t.update(rotated_frame(2));
  assert(t.snapshot().identity_valid);
  auto wrong_depth = rotated_frame(3);
  auto too_far = std::make_shared<DownsampledImage>(*wrong_depth.depth);
  for(size_t i=0;i<too_far->data.size();i+=2) {
    too_far->data[i]=450&255; too_far->data[i+1]=450>>8;
  }
  wrong_depth.depth=too_far;
  assert(t.select(wrong_depth, rotated_box, {}).mode=="uncertain");
  t.select(rotated_frame(0), rotated_box, {});
  t.invalidate("original association failure");
  std::this_thread::sleep_for(std::chrono::milliseconds(505));
  assert(t.snapshot().message == "original association failure");
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
  assert(s.diagnostic.find("depth_status=missing") != std::string::npos);
  assert(s.handoff_reason.find("depth_unavailable") != std::string::npos);
  assert(s.handoff_reason.find("camera_z_m=") != std::string::npos);
  assert(rgb_target_json(s).find("\"diagnostic\"") != std::string::npos);
  const auto cause = s.handoff_reason;
  t.update(frame(5, false, .01, .4, .003));
  assert(t.snapshot().handoff_reason == cause);
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
  auto obsolete=frame(0); obsolete.generation=99;
  t.update(obsolete, true, id);
  t.invalidate("obsolete worker error", id);
  assert(t.snapshot().identity_valid); // old worker cannot poison a new binding
  // An explicit verified plane is required for RGB metric observations.
  RgbTargetConfig verified;
  verified.plane_verified = true;
  confirmed(t, verified);
  t.update(frame(3, false));
  assert(t.snapshot().metric_ready);
  // Approaching along optical Z expands the image; projection preserves world
  // identity.
  confirmed(t, verified);
  const auto approaching_id = t.snapshot().target_id;
  t.update(frame(3, true, 0, .35));
  assert(t.snapshot().mode == "rgbd");
  t.update(frame(4, true, 0, .28));
  auto close = t.snapshot();
  assert(close.mode == "rgb" && close.identity_valid && close.metric_ready);
  assert(close.handoff_reason.find("near_range") != std::string::npos);
  assert(close.diagnostic.find("depth_status=valid") != std::string::npos);
  assert(close.target_id == approaching_id &&
         std::abs(close.box.center[0]) < .001);
  t.update(frame(5, false, 0, .24));
  close = t.snapshot();
  assert(close.mode == "rgb" && close.identity_valid &&
         close.target_id == approaching_id);
  assert(close.camera_z_m < .195 && close.metric_ready);
  const auto yaw = t.snapshot().locked_yaw;
  t.update(frame(6, false, 0, .24));
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
  assert(t.snapshot().mode == "waiting" && !t.snapshot().identity_valid);
  const auto recovery_id=t.snapshot().target_id;
  t.update(frame(13)); // caller cannot prove stopped: no recovery
  assert(t.snapshot().mode == "waiting");
  t.update(frame(14), true);
  assert(t.snapshot().mode == "recovering" && !t.snapshot().identity_valid);
  t.update(frame(14), true); // duplicate cannot count
  t.update(frame(15), true);
  assert(!t.snapshot().identity_valid);
  t.update(frame(16), true);
  assert(t.snapshot().identity_valid && t.snapshot().target_id==recovery_id);
  // A timestamp gap also requires revalidation even without a snapshot poll.
  t.update(frame(28), true);
  assert(!t.snapshot().identity_valid);
  auto foreign=frame(29); foreign.generation++;
  t.update(foreign, true);
  assert(t.snapshot().mode=="uncertain");
  t.update(frame(30), true);
  assert(t.snapshot().mode=="uncertain");
  confirmed(t);
  t.update(frame(50), true);
  assert(t.snapshot().mode=="uncertain");
  confirmed(t);
  std::this_thread::sleep_for(std::chrono::milliseconds(2005));
  assert(t.snapshot().mode=="uncertain");
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
