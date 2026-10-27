#pragma once

#include "easy_debug_bridge/bridge_core.hpp"

#include <array>
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace easy_debug_bridge {

inline std::vector<uint8_t> binary_rgbd_frame(const std::string &metadata, const std::vector<uint8_t> &payload) {
  return binary_payload_frame(metadata, payload, 'D');
}

inline int bytes_per_pixel(const std::string &encoding) {
  std::string kind = encoding;
  for (char &c : kind) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  if (kind == "mono8" || kind == "8uc1") return 1;
  if (kind == "16uc1" || kind == "mono16") return 2;
  if (kind == "rgb8" || kind == "bgr8" || kind == "8uc3") return 3;
  if (kind == "rgba8" || kind == "bgra8" || kind == "8uc4") return 4;
  if (kind == "32fc1") return 4;
  return 0;
}

inline bool stamps_within_tolerance(int32_t a_sec, uint32_t a_nsec, int32_t b_sec, uint32_t b_nsec,
                                    int64_t tolerance_ns) {
  const int64_t a = static_cast<int64_t>(a_sec) * 1000000000LL + static_cast<int64_t>(a_nsec);
  const int64_t b = static_cast<int64_t>(b_sec) * 1000000000LL + static_cast<int64_t>(b_nsec);
  const int64_t diff = a > b ? a - b : b - a;
  return diff <= tolerance_ns;
}

inline int64_t stamp_diff_ns(int32_t a_sec, uint32_t a_nsec, int32_t b_sec, uint32_t b_nsec) {
  const int64_t a = static_cast<int64_t>(a_sec) * 1000000000LL + static_cast<int64_t>(a_nsec);
  const int64_t b = static_cast<int64_t>(b_sec) * 1000000000LL + static_cast<int64_t>(b_nsec);
  return a > b ? a - b : b - a;
}

struct PreviewSize {
  uint32_t width = 0;
  uint32_t height = 0;
};

inline PreviewSize choose_preview_size(uint32_t width, uint32_t height, uint32_t max_width, uint32_t max_height) {
  if (width == 0 || height == 0) return {0, 0};
  const double scale = std::min({1.0, static_cast<double>(max_width) / width,
                                 static_cast<double>(max_height) / height});
  return {
      static_cast<uint32_t>(std::max(1.0, std::round(width * scale))),
      static_cast<uint32_t>(std::max(1.0, std::round(height * scale))),
  };
}

/** Scale CameraInfo K for nearest-neighbor resize. K is row-major 9 elements. */
inline std::array<double, 9> scale_intrinsics(const double k[9], uint32_t src_w, uint32_t src_h,
                                              uint32_t dst_w, uint32_t dst_h) {
  const double sx = static_cast<double>(dst_w) / static_cast<double>(src_w);
  const double sy = static_cast<double>(dst_h) / static_cast<double>(src_h);
  return {
      k[0] * sx, k[1] * sx, k[2] * sx,
      k[3] * sy, k[4] * sy, k[5] * sy,
      k[6], k[7], k[8],
  };
}

struct DownsampledImage {
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t step = 0;
  std::string encoding;
  uint8_t is_bigendian = 0;
  std::vector<uint8_t> data;
};

/** Nearest-neighbor downsample preserving encoding / endianness.
 *  src_nbytes must cover at least src_h * src_step bytes (truncated Image → nullopt). */
inline std::optional<DownsampledImage> downsample_image_nn(
    const uint8_t *src, size_t src_nbytes, uint32_t src_w, uint32_t src_h, uint32_t src_step,
    const std::string &encoding, uint8_t is_bigendian,
    uint32_t dst_w, uint32_t dst_h) {
  const int bpp = bytes_per_pixel(encoding);
  if (!src || bpp <= 0 || src_w == 0 || src_h == 0 || dst_w == 0 || dst_h == 0) return std::nullopt;
  if (src_step < src_w * static_cast<uint32_t>(bpp)) return std::nullopt;
  if (src_nbytes < static_cast<size_t>(src_h) * static_cast<size_t>(src_step)) return std::nullopt;
  DownsampledImage out;
  out.width = dst_w;
  out.height = dst_h;
  out.encoding = encoding;
  out.is_bigendian = is_bigendian;
  out.step = dst_w * static_cast<uint32_t>(bpp);
  out.data.resize(static_cast<size_t>(out.step) * dst_h);
  for (uint32_t y = 0; y < dst_h; ++y) {
    const uint32_t sy = static_cast<uint32_t>(std::min<uint64_t>(
        src_h - 1, (static_cast<uint64_t>(y) * src_h) / dst_h));
    for (uint32_t x = 0; x < dst_w; ++x) {
      const uint32_t sx = static_cast<uint32_t>(std::min<uint64_t>(
          src_w - 1, (static_cast<uint64_t>(x) * src_w) / dst_w));
      const uint8_t *from = src + static_cast<size_t>(sy) * src_step + static_cast<size_t>(sx) * bpp;
      uint8_t *to = out.data.data() + static_cast<size_t>(y) * out.step + static_cast<size_t>(x) * bpp;
      std::memcpy(to, from, static_cast<size_t>(bpp));
    }
  }
  return out;
}

/**
 * Latest-only complete frame group queue. Pushing replaces any unfinished/complete
 * previous group so RGB/Depth/pose never mix across generations.
 */
template <typename T>
class LatestFrameGroupQueue {
 public:
  void push(T value) {
    if (has_) ++dropped_;
    value_ = std::move(value);
    has_ = true;
  }
  std::optional<T> take() {
    if (!has_) return std::nullopt;
    has_ = false;
    return std::move(value_);
  }
  bool empty() const { return !has_; }
  size_t dropped_count() const { return dropped_; }
  void clear() { has_ = false; dropped_ = 0; }

 private:
  T value_{};
  bool has_ = false;
  size_t dropped_ = 0;
};

}  // namespace easy_debug_bridge
