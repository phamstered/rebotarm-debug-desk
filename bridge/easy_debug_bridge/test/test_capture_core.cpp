#include "easy_debug_bridge/capture_core.hpp"
#include <cassert>
#include <iostream>
using namespace easy_debug_bridge;
template<class F> void rejects(F action) { bool failed = false; try { action(); } catch (const std::exception &) { failed = true; } assert(failed); }
int main() {
  CaptureSpec valid{"capture-1", "拍照", "camera_capture", "/isolated/camera", 5};
  validate_capture(valid);
  for (const auto topic : {"relative", "/", "/camera//image", "/9camera", "/camera/../image", "/camera/image/"}) {
    auto bad = valid; bad.topic = topic; rejects([&] { validate_capture(bad); });
  }
  for (const auto timeout : {0., -.1, 60.01, std::nan("")}) { auto bad = valid; bad.timeout_s = timeout; rejects([&] { validate_capture(bad); }); }
  auto bad = valid; bad.type = "shell"; rejects([&] { validate_capture(bad); });
  bad = valid; bad.id = "../escape"; rejects([&] { validate_capture(bad); });
  assert(capture_stamp_valid(10, 9.9, 9.95));
  assert(!capture_stamp_valid(10, 9, 9.95)); assert(!capture_stamp_valid(10, 10.2, 10));
  assert(!capture_stamp_valid(10, 9.8, 10)); assert(!capture_stamp_valid(10, 0, 10));
  CaptureImage image{2, 1, 8, "bgr8", {3,2,1, 6,5,4, 0,0}};
  assert(capture_rgb(image) == std::vector<uint8_t>({1,2,3,4,5,6}));
  const auto png = capture_png(image);
  assert(png.size() > 50 && png[0] == 137 && png[1] == 80);
  // Verify the actual PNG IDAT stream rather than mirroring the encoder.
  const auto length = (uint32_t(png[33]) << 24) | (uint32_t(png[34]) << 16) | (uint32_t(png[35]) << 8) | png[36];
  std::vector<uint8_t> raw(7); uLongf size = raw.size();
  assert(uncompress(raw.data(), &size, png.data() + 41, length) == Z_OK);
  assert(raw == std::vector<uint8_t>({0,1,2,3,4,5,6}));
  image.data.pop_back(); rejects([&] { capture_png(image); });
  image = {1,1,1,"mono8",{42}}; assert(capture_rgb(image) == std::vector<uint8_t>({42,42,42}));
  image.encoding = "16UC1"; rejects([&] { capture_png(image); });
  image = {4097,1,12291,"rgb8",{}}; rejects([&] { capture_png(image); });
  assert(capture_base64({1,2,3}) == "AQID"); assert(capture_base64({1}) == "AQ==");
  std::cout << "capture core tests passed\n";
}
