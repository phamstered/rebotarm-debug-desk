#pragma once
#include <zlib.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace easy_debug_bridge {
struct CaptureSpec { std::string id, label, type, topic; double timeout_s{}; };
inline void validate_capture(const CaptureSpec &s) {
  if (s.id.empty() || s.id.size() > 128 || s.id.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_") != std::string::npos ||
      s.label.empty() || s.label.size() > 512 || s.type != "camera_capture" || !std::isfinite(s.timeout_s) || s.timeout_s < .1 || s.timeout_s > 60)
    throw std::runtime_error("拍照 Action 类型、ID、名称或超时无效");
  if (s.topic.empty() || s.topic[0] != '/' || s.topic.size() > 256) throw std::runtime_error("相机 Topic 必须为绝对路径");
  bool first = true;
  for (size_t i = 1; i <= s.topic.size(); ++i) {
    if (i == s.topic.size() || s.topic[i] == '/') {
      if (first) throw std::runtime_error("相机 Topic 含空段");
      first = true;
    } else {
      const char c = s.topic[i];
      const bool alpha = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
      if (!alpha && (first || c < '0' || c > '9')) throw std::runtime_error("相机 Topic 无效");
      first = false;
    }
  }
}
inline bool capture_stamp_valid(double now, double image, double joint) {
  return std::isfinite(now) && std::isfinite(image) && std::isfinite(joint) && image > 0 && joint > 0 &&
      now - image >= -.05 && now - image <= .5 && now - joint >= -.05 && now - joint <= .5 && std::abs(image - joint) <= .1;
}
struct CaptureImage { uint32_t width{}, height{}, step{}; std::string encoding; std::vector<uint8_t> data; };
inline std::vector<uint8_t> capture_rgb(const CaptureImage &image, unsigned max_edge = 4096) {
  const unsigned channels = image.encoding == "rgb8" || image.encoding == "bgr8" ? 3 :
    image.encoding == "rgba8" || image.encoding == "bgra8" ? 4 : image.encoding == "mono8" ? 1 : 0;
  if (!channels || !image.width || !image.height || image.width > 4096 || image.height > 4096 ||
      image.step < uint64_t(image.width) * channels || uint64_t(image.step) * image.height != image.data.size() || image.data.size() > 64 * 1024 * 1024)
    throw std::runtime_error("相机图像格式、尺寸或数据长度无效（支持 rgb8/bgr8/rgba8/bgra8/mono8，最大 4096×4096）");
  const double scale = std::min(1., double(max_edge) / std::max(image.width, image.height));
  const unsigned w = std::max(1u, unsigned(image.width * scale)), h = std::max(1u, unsigned(image.height * scale));
  std::vector<uint8_t> rgb(w * h * 3);
  const bool bgr = image.encoding == "bgr8" || image.encoding == "bgra8";
  for (unsigned y = 0; y < h; ++y) for (unsigned x = 0; x < w; ++x) {
    const auto in = size_t(std::min(image.height - 1, unsigned(y / scale))) * image.step + std::min(image.width - 1, unsigned(x / scale)) * channels;
    for (unsigned c = 0; c < 3; ++c) rgb[(y * w + x) * 3 + c] = image.data[in + (channels == 1 ? 0 : bgr ? 2 - c : c)];
  }
  return rgb;
}
inline void capture_u32(std::vector<uint8_t> &out, uint32_t value) { for (int n = 24; n >= 0; n -= 8) out.push_back(uint8_t(value >> n)); }
inline void capture_chunk(std::vector<uint8_t> &out, const std::string &type, const std::vector<uint8_t> &data) {
  capture_u32(out, uint32_t(data.size())); const auto start = out.size();
  out.insert(out.end(), type.begin(), type.end()); out.insert(out.end(), data.begin(), data.end());
  capture_u32(out, uint32_t(crc32(0, out.data() + start, uInt(out.size() - start))));
}
inline std::vector<uint8_t> capture_png(const CaptureImage &image, unsigned max_edge = 4096) {
  const auto rgb = capture_rgb(image, max_edge);
  const double scale = std::min(1., double(max_edge) / std::max(image.width, image.height));
  const auto w = std::max(1u, unsigned(image.width * scale)), h = std::max(1u, unsigned(image.height * scale));
  std::vector<uint8_t> raw;
  raw.reserve(rgb.size() + h);
  for (unsigned y = 0; y < h; ++y) { raw.push_back(0); raw.insert(raw.end(), rgb.begin() + y * w * 3, rgb.begin() + (y + 1) * w * 3); }
  std::vector<uint8_t> compressed(compressBound(raw.size())); uLongf size = compressed.size();
  if (compress2(compressed.data(), &size, raw.data(), raw.size(), 3) != Z_OK) throw std::runtime_error("PNG 压缩失败");
  compressed.resize(size);
  std::vector<uint8_t> out{137,80,78,71,13,10,26,10}, header;
  capture_u32(header, w); capture_u32(header, h); header.insert(header.end(), {8,2,0,0,0});
  capture_chunk(out, "IHDR", header); capture_chunk(out, "IDAT", compressed); capture_chunk(out, "IEND", {});
  return out;
}
inline std::string capture_base64(const std::vector<uint8_t> &data) {
  static const char *alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  for (size_t i = 0; i < data.size(); i += 3) {
    uint32_t n = uint32_t(data[i]) << 16;
    if (i + 1 < data.size()) n |= uint32_t(data[i + 1]) << 8;
    if (i + 2 < data.size()) n |= data[i + 2];
    out += alphabet[n >> 18]; out += alphabet[(n >> 12) & 63];
    out += i + 1 < data.size() ? alphabet[(n >> 6) & 63] : '=';
    out += i + 2 < data.size() ? alphabet[n & 63] : '=';
  }
  return out;
}
}
