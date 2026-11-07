#include "easy_debug_bridge/rgb_target.hpp"
#include <boost/property_tree/json_parser.hpp>
#include <chrono>
#include <iomanip>
#include <mutex>
#include <random>
#ifdef EASY_DEBUG_HAS_OPENCV
#include <opencv2/calib3d.hpp>
#include <opencv2/imgproc.hpp>
#endif
namespace easy_debug_bridge {
using Steady = std::chrono::steady_clock;
RgbTargetConfig load_rgb_target_config(const std::string &path) {
  boost::property_tree::ptree t;
  boost::property_tree::read_json(path, t);
  RgbTargetConfig c;
  c.enabled = t.get<bool>("rgb_tracking.enabled", true);
  c.plane_verified = t.get<bool>("rgb_tracking.plane_verified", false);
  c.confirmation_frames =
      t.get<unsigned>("rgb_tracking.confirmation_frames", 3);
  c.handoff_distance_m = t.get<double>("rgb_tracking.handoff_distance_m", .25);
  c.max_rgb_seconds = t.get<double>("rgb_tracking.max_seconds", 90);
  c.max_rgb_travel_m = t.get<double>("rgb_tracking.max_travel_m", .15);
  if (c.confirmation_frames < 3 || c.confirmation_frames > 10 ||
      !std::isfinite(c.handoff_distance_m) || c.handoff_distance_m < .15 ||
      c.handoff_distance_m > .5 || !std::isfinite(c.max_rgb_seconds) ||
      c.max_rgb_seconds < 1 || c.max_rgb_seconds > 90 ||
      !std::isfinite(c.max_rgb_travel_m) || c.max_rgb_travel_m < .001 ||
      c.max_rgb_travel_m > .15)
    throw std::runtime_error("RGB tracking configuration invalid");
  return c;
}
std::string rgb_target_json(const RgbTargetState &s) {
  std::ostringstream o;
  o << std::setprecision(17);
  o << "{\"target_id\":" << position_json_quote(s.target_id)
    << ",\"object_id\":" << s.object_id << ",\"sequence\":" << s.sequence
    << ",\"generation\":" << s.generation
    << ",\"mode\":" << position_json_quote(s.mode)
    << ",\"message\":" << position_json_quote(s.message)
    << ",\"diagnostic\":" << position_json_quote(s.diagnostic)
    << ",\"handoff_reason\":" << position_json_quote(s.handoff_reason)
    << ",\"identity_valid\":" << (s.identity_valid ? "true" : "false")
    << ",\"metric_ready\":" << (s.metric_ready ? "true" : "false")
    << ",\"plane_verified\":" << (s.plane_verified ? "true" : "false")
    << ",\"confidence\":" << s.confidence
    << ",\"depth_valid_fraction\":" << s.depth_valid_fraction
    << ",\"age_ms\":" << s.age_ms << ",\"camera_z_m\":" << s.camera_z_m
    << ",\"geometry_source\":" << position_json_quote(s.geometry_source)
    << ",\"source_frame\":" << position_json_quote(s.frame.source_frame)
    << ",\"target_frame\":" << position_json_quote(s.frame.target_frame)
    << ",\"stamp_ns\":" << s.stamp_ns << ",\"roi\":[" << s.roi[0] << ','
    << s.roi[1] << ',' << s.roi[2] << ',' << s.roi[3]
    << "],\"box\":{\"id\":" << s.box.id << ",\"center\":[";
  for (int i = 0; i < 3; ++i) {
    if (i)
      o << ',';
    o << s.box.center[i];
  }
  o << "],\"size\":[";
  for (int i = 0; i < 3; ++i) {
    if (i)
      o << ',';
    o << s.box.size[i];
  }
  o << "],\"point_count\":" << s.box.point_count
    << "},\"locked_yaw\":" << s.locked_yaw << '}';
  return o.str();
}
bool rgb_target_supported() {
#ifdef EASY_DEBUG_HAS_OPENCV
  return true;
#else
  return false;
#endif
}
struct RgbTargetTracker::Impl {
  std::mutex mutex;
  RgbTargetState state;
  RgbTargetConfig config;
  Steady::time_point received{}, rgb_started{};
#ifdef EASY_DEBUG_HAS_OPENCV
  cv::Mat hsv;
  int hue = 0, saturation = 0;
  ObjectBox initial;
  ObjectPoint anchor{}, correction{};
  std::vector<ObjectPoint> polygon;
  RgbTargetFrame reference;
  unsigned agreements = 0;
  bool handed_off = false;
  void lose(const std::string &why) {
    if (state.target_id.empty() || state.mode == "uncertain")
      return;
    state.mode = "uncertain";
    state.message = why;
    state.identity_valid = false;
    state.metric_ready = false;
    state.confidence = 0;
    state.geometry_source = "none";
  }
  static ObjectPoint point(const TcpPose &t, const ObjectPoint &p) {
    auto v = tcp_rotate_vector(t.orientation, p);
    for (int i = 0; i < 3; ++i)
      v[i] += t.position[i];
    return v;
  }
  static cv::Mat camera(const RgbTargetFrame &f) {
    return (cv::Mat_<double>(3, 3) << f.k[0], f.k[1], f.k[2], f.k[3], f.k[4],
            f.k[5], f.k[6], f.k[7], f.k[8]);
  }
  static cv::Mat distortion(const RgbTargetFrame &f) {
    return f.distortion.empty() ? cv::Mat() : cv::Mat(f.distortion).clone();
  }
  static cv::Point2f project(const RgbTargetFrame &f,
                             const ObjectPoint &world) {
    const auto p = point(tcp_pose_inverse(f.camera_to_base), world);
    if (p[2] <= .03)
      throw std::runtime_error("目标不在相机前方");
    std::vector<cv::Point3d> object{{p[0], p[1], p[2]}};
    std::vector<cv::Point2d> image;
    cv::projectPoints(object, cv::Vec3d{}, cv::Vec3d{}, camera(f),
                      distortion(f), image);
    if (!std::isfinite(image[0].x) || !std::isfinite(image[0].y) ||
        std::abs(image[0].x) > 100000 || std::abs(image[0].y) > 100000)
      throw std::runtime_error("RGB 投影越界");
    return {float(image[0].x), float(image[0].y)};
  }
  ObjectPoint ray(const RgbTargetFrame &f, cv::Point2f pixel) const {
    std::vector<cv::Point2f> in{pixel}, out;
    cv::undistortPoints(in, out, camera(f), distortion(f));
    auto direction = tcp_rotate_vector(f.camera_to_base.orientation,
                                       {out[0].x, out[0].y, 1});
    if (std::abs(direction[2]) < .2)
      throw std::runtime_error("目标顶面投影退化");
    const double z = (anchor[2] - f.camera_to_base.position[2]) / direction[2];
    if (!std::isfinite(z) || z < .03 || z > 3)
      throw std::runtime_error("RGB 顶面几何不可解");
    ObjectPoint p;
    for (int i = 0; i < 3; ++i)
      p[i] = f.camera_to_base.position[i] + direction[i] * z;
    return p;
  }
  static cv::Mat image(const RgbTargetFrame &f) {
    if (!f.rgb || !f.rgb->width || !f.rgb->height || f.rgb->width > 1280 ||
        f.rgb->height > 720 || f.rgb->step < size_t(f.rgb->width) * 3 ||
        f.rgb->data.size() < size_t(f.rgb->step) * f.rgb->height)
      throw std::runtime_error("RGB 图像无效");
    cv::Mat view(f.rgb->height, f.rgb->width, CV_8UC3,
                 const_cast<uint8_t *>(f.rgb->data.data()), f.rgb->step),
        result;
    if (f.rgb->encoding == "rgb8")
      cv::cvtColor(view, result, cv::COLOR_RGB2HSV);
    else if (f.rgb->encoding == "bgr8")
      cv::cvtColor(view, result, cv::COLOR_BGR2HSV);
    else
      throw std::runtime_error("RGB 跟踪仅支持 rgb8/bgr8");
    for (double k : f.k)
      if (!std::isfinite(k))
        throw std::runtime_error("RGB 内参无效");
    if (f.k[0] < 1 || f.k[4] < 1 || f.k[0] > 10000 || f.k[4] > 10000 ||
        std::abs(f.k[2]) > 2 * f.rgb->width ||
        std::abs(f.k[5]) > 2 * f.rgb->height || f.k[1] != 0 || f.k[3] != 0 ||
        f.k[6] != 0 || f.k[7] != 0 || f.k[8] != 1 ||
        f.target_frame != "base_link" || f.source_frame.empty() ||
        f.stamp_ns <= 0)
      throw std::runtime_error("RGB 坐标系或内参无效");
    if (!f.distortion.empty() && f.distortion.size() != 4 &&
        f.distortion.size() != 5 && f.distortion.size() != 8 &&
        f.distortion.size() != 12 && f.distortion.size() != 14)
      throw std::runtime_error("不支持的 RGB 畸变参数");
    for (double d : f.distortion)
      if (!std::isfinite(d) || std::abs(d) > 100)
        throw std::runtime_error("RGB 畸变参数无效");
    if (!f.distortion_model.empty() && f.distortion_model != "plumb_bob" &&
        f.distortion_model != "rational_polynomial")
      throw std::runtime_error("不支持的 RGB 畸变模型");
    if (!std::isfinite(f.source_age_ms) || f.source_age_ms < 0 ||
        f.source_age_ms >= 500)
      throw std::runtime_error("RGB 帧已过期");
    validate_tcp_pose(f.camera_to_base);
    for (double p : f.camera_to_base.position)
      if (std::abs(p) > 10)
        throw std::runtime_error("RGB 相机变换超出工作范围");
    return result;
  }
  struct Candidate {
    std::vector<cv::Point> contour;
    cv::Rect roi;
    cv::Point2f center;
    double score;
  };
  std::vector<Candidate>
  candidates(const cv::Mat &image,
             const std::vector<cv::Point> &expected, bool seed = false) const {
    cv::Mat mask(image.rows, image.cols, CV_8U, cv::Scalar(0));
    for (int y = 0; y < image.rows; ++y)
      for (int x = 0; x < image.cols; ++x) {
        const auto p = image.at<cv::Vec3b>(y, x);
        int d = std::abs(int(p[0]) - hue);
        d = std::min(d, 180 - d);
        if (d <= 10 && p[1] >= std::max(40, saturation / 2) && p[2] >= 35)
          mask.at<uint8_t>(y, x) = 255;
      }
    cv::morphologyEx(mask, mask, cv::MORPH_OPEN, cv::Mat::ones(3, 3, CV_8U));
    std::vector<std::vector<cv::Point>> contours;
    cv::findContours(mask, contours, cv::RETR_EXTERNAL,
                     cv::CHAIN_APPROX_SIMPLE);
    cv::Mat prediction(mask.size(), CV_8U, cv::Scalar(0));
    cv::fillConvexPoly(prediction, expected, cv::Scalar(255));
    const double expected_area = cv::countNonZero(prediction);
    if (expected_area < 25)
      throw std::runtime_error("目标投影过小");
    const auto rect = cv::boundingRect(expected);
    const auto center =
        cv::Point2f(rect.x + rect.width * .5f, rect.y + rect.height * .5f);
    std::vector<Candidate> result;
    if (contours.size() > 256)
      throw std::runtime_error("RGB 场景候选过多");
    for (const auto &c : contours) {
      const auto r = cv::boundingRect(c);
      const double area = cv::contourArea(c);
      if (area < 25 || r.x <= 0 || r.y <= 0 || r.br().x >= image.cols - 1 ||
          r.br().y >= image.rows - 1 || area / double(r.area()) < .40)
        continue;
      cv::Mat component(mask.size(), CV_8U, cv::Scalar(0));
      cv::drawContours(component, std::vector<std::vector<cv::Point>>{c}, -1,
                       cv::Scalar(255), cv::FILLED);
      cv::Mat intersection;
      cv::bitwise_and(component, prediction, intersection);
      const double overlap = cv::countNonZero(intersection) / expected_area;
      const double ratio = cv::countNonZero(component) / expected_area;
      const auto m = cv::moments(c);
      if (m.m00 <= 0)
        continue;
      cv::Point2f actual(float(m.m10 / m.m00), float(m.m01 / m.m00));
      const double displacement =
          cv::norm(actual - center) /
          std::max(10., std::hypot(rect.width, rect.height));
      // An AABB encloses background at rotated corners and includes side faces.
      // Only initialization uses enclosure occupancy; tracking still compares
      // against the learned contour with the original strict overlap limits.
      if (overlap < (seed ? .40 : .85) || ratio < (seed ? .40 : .85) ||
          ratio > 1.20 || displacement > (seed ? .25 : .5) ||
          (seed && overlap / ratio < .90))
        continue;
      result.push_back(
          {c, r, actual,
           overlap - displacement - std::abs(std::log(ratio)) * .2});
    }
    std::sort(result.begin(), result.end(),
              [](const auto &a, const auto &b) { return a.score > b.score; });
    return result;
  }
  static double depth(const DownsampledImage &d, int x, int y) {
    const bool floating = d.encoding == "32FC1" || d.encoding == "32fc1";
    const bool integer = d.encoding == "16UC1" || d.encoding == "16uc1" ||
                         d.encoding == "mono16";
    if (!floating && !integer)
      return 0;
    const size_t bytes = floating ? 4 : 2;
    if (d.step < size_t(d.width) * bytes ||
        d.data.size() < size_t(d.step) * d.height || x < 0 || y < 0 ||
        x >= int(d.width) || y >= int(d.height))
      return 0;
    const auto *p = d.data.data() + size_t(y) * d.step + size_t(x) * bytes;
    uint32_t bits = 0;
    for (size_t i = 0; i < bytes; ++i)
      bits |= uint32_t(p[i]) << (8 * (d.is_bigendian ? bytes - 1 - i : i));
    if (floating) {
      float value;
      std::memcpy(&value, &bits, 4);
      return value;
    }
    return bits * .001;
  }
  bool depth_agrees(const RgbTargetFrame &f, const Candidate &c) {
    state.depth_valid_fraction = 0;
    std::ostringstream detail;
    detail << std::setprecision(17) << "rgb_stamp_ns=" << f.stamp_ns
           << " depth_stamp_ns=" << (f.depth ? f.depth_stamp_ns : 0)
           << " delta_ms=" << (f.depth ? double(f.depth_stamp_ns-f.stamp_ns)/1e6 : 0);
    state.diagnostic = detail.str() + " depth_status=" + (!f.depth ? "missing" : "incompatible_dimensions_or_timestamp");
    if (!f.depth || f.depth->width != f.rgb->width ||
        f.depth->height != f.rgb->height ||
        std::llabs(f.depth_stamp_ns - f.stamp_ns) > 50000000LL)
      return false;
    cv::Mat mask(hsv.size(), CV_8U, cv::Scalar(0));
    cv::drawContours(mask, std::vector<std::vector<cv::Point>>{c.contour}, -1,
                     cv::Scalar(255), cv::FILLED);
    std::vector<double> heights, depths;
    std::vector<cv::Point2f> pixels, normalized;
    size_t total = 0;
    for (int y = c.roi.y; y < c.roi.br().y; y += 2)
      for (int x = c.roi.x; x < c.roi.br().x; x += 2) {
        if (!mask.at<uint8_t>(y, x))
          continue;
        ++total;
        const double z = depth(*f.depth, x, y);
        if (!std::isfinite(z) || z < .03 || z > 3)
          continue;
        pixels.push_back({float(x), float(y)});
        depths.push_back(z);
      }
    if (!pixels.empty())
      cv::undistortPoints(pixels, normalized, camera(f), distortion(f));
    for (size_t i = 0; i < normalized.size(); ++i) {
      const auto z = depths[i];
      heights.push_back(point(
          f.camera_to_base, {normalized[i].x * z, normalized[i].y * z, z})[2]);
    }
    state.depth_valid_fraction = total ? double(heights.size()) / total : 0;
    detail << " samples=" << heights.size() << " total=" << total
           << " valid_fraction=" << state.depth_valid_fraction;
    state.diagnostic = detail.str() + " depth_status=insufficient_valid_samples";
    if (state.depth_valid_fraction < .3 || heights.size() < 8)
      return false;
    std::sort(heights.begin(), heights.end());
    const auto height = heights[heights.size() * 4 / 5];
    detail << " height_m=" << height << " anchor_height_m=" << anchor[2]
           << " height_error_m=" << height-anchor[2];
    state.diagnostic = detail.str() + " depth_status=" +
        (std::abs(height-anchor[2]) > .01 ? "height_mismatch" : "valid");
    if (std::abs(height - anchor[2]) > .01) {
      lose("RGB 与目标顶面深度不一致");
      return false;
    }
    return true;
  }
  bool inside_selected_box(const RgbTargetFrame &f, int x, int y) const {
    if (!f.depth || f.depth->width != f.rgb->width ||
        f.depth->height != f.rgb->height ||
        std::llabs(f.depth_stamp_ns - f.stamp_ns) > 50000000LL)
      return false;
    const double z = depth(*f.depth, x, y);
    if (!std::isfinite(z) || z < .03 || z > 3) return false;
    std::vector<cv::Point2f> in{{float(x), float(y)}}, out;
    cv::undistortPoints(in, out, camera(f), distortion(f));
    const auto p = point(f.camera_to_base, {out[0].x*z, out[0].y*z, z});
    for (int i=0; i<3; ++i)
      if (std::abs(p[i]-initial.center[i]) > initial.size[i]/2 + .006)
        return false;
    return true;
  }
  void process(const RgbTargetFrame &f) {
    if (state.target_id.empty() || state.mode == "uncertain")
      return;
    if (f.stamp_ns == state.stamp_ns)
      return;
    if (f.stamp_ns < state.stamp_ns ||
        f.stamp_ns - state.stamp_ns > 500000000LL ||
        f.generation != reference.generation ||
        f.subscription != reference.subscription ||
        f.source_frame != reference.source_frame ||
        f.target_frame != reference.target_frame || !f.rgb ||
        f.rgb->width != reference.rgb->width ||
        f.rgb->height != reference.rgb->height || f.k != reference.k ||
        f.distortion != reference.distortion ||
        f.distortion_model != reference.distortion_model) {
      lose("RGB 来源、内参、时间代次改变或观测中断，需重新选择");
      return;
    }
    hsv = image(f);
    std::vector<cv::Point> expected;
    for (auto p : polygon) {
      p[0] += correction[0];
      p[1] += correction[1];
      auto pixel = project(f, p);
      expected.emplace_back(cvRound(pixel.x), cvRound(pixel.y));
    }
    auto found = candidates(hsv, expected);
    if (found.empty()) {
      lose("RGB 目标被遮挡、离开视野或外观不匹配");
      return;
    }
    if (found.size() > 1 && found[0].score - found[1].score < .25) {
      lose("相似 RGB 目标存在歧义，需重新选择");
      return;
    }
    const auto &c = found.front();
    const auto measured = ray(f, c.center);
    ObjectPoint delta{measured[0] - anchor[0], measured[1] - anchor[1], 0};
    if (std::hypot(delta[0], delta[1]) > .02 ||
        std::hypot(delta[0] - correction[0], delta[1] - correction[1]) > .01) {
      lose("RGB 目标位置跳变，需重新选择");
      return;
    }
    const bool depth_valid = depth_agrees(f, c);
    if (state.mode == "uncertain")
      return;
    if (depth_valid)
      ++agreements;
    else if (agreements < config.confirmation_frames) {
      lose("深度丢失前未完成 RGBD/RGB 多帧核验");
      return;
    }
    state.frame = f;
    state.stamp_ns = f.stamp_ns;
    state.sequence++;
    received = Steady::now();
    correction = delta;
    state.box = initial;
    state.box.center[0] += delta[0];
    state.box.center[1] += delta[1];
    const auto camera_point = point(tcp_pose_inverse(f.camera_to_base),
                                    {initial.center[0] + delta[0],
                                     initial.center[1] + delta[1], anchor[2]});
    state.camera_z_m = camera_point[2];
    state.roi = {double(c.roi.x), double(c.roi.y), double(c.roi.width),
                 double(c.roi.height)};
    state.confidence = std::clamp(found[0].score, 0., 1.);
    state.identity_valid = agreements >= config.confirmation_frames;
    if (!handed_off && state.identity_valid &&
        (state.camera_z_m <= config.handoff_distance_m || !depth_valid)) {
      std::ostringstream cause;
      cause << std::setprecision(17) << (depth_valid ? "near_range" : "depth_unavailable")
            << " camera_z_m=" << state.camera_z_m << " threshold_m=" << config.handoff_distance_m
            << " " << state.diagnostic;
      state.handoff_reason = cause.str();
      handed_off = true;
    }
    if (handed_off && rgb_started == Steady::time_point{})
      rgb_started = Steady::now();
    if (handed_off &&
        std::chrono::duration<double>(Steady::now() - rgb_started).count() >
            config.max_rgb_seconds) {
      lose("RGB 接管时限已到");
      return;
    }
    state.mode = !state.identity_valid ? "confirming"
                 : handed_off          ? "rgb"
                                       : "rgbd";
    state.geometry_source =
        handed_off ? (config.plane_verified ? "verified_surface_plane"
                                            : "surface_plane_unverified")
                   : "depth_verified_surface";
    const auto optical_z =
        tcp_rotate_vector(f.camera_to_base.orientation, {0, 0, 1});
    const bool downward =
        optical_z[2] <=
        -.985; // First metric fallback supports nearly normal top views only.
    state.metric_ready = state.identity_valid &&
                         (!handed_off || (config.plane_verified && downward));
    state.message = handed_off && config.plane_verified && !downward
                        ? "RGB 身份保持；相机非近垂直俯视，禁止平面接近"
                    : !state.identity_valid ? "RGBD/RGB 多帧核验中"
                    : handed_off
                        ? (config.plane_verified
                               ? "RGB 跟踪；固定顶面几何约束"
                               : "RGB 身份保持；顶面几何未核验，禁止继续接近")
                        : "RGBD 与 RGB 一致跟踪";
  }
#else
  void lose(const std::string &why) {
    state.mode = "uncertain";
    state.message = why;
    state.identity_valid = false;
    state.metric_ready = false;
  }
#endif
};
RgbTargetTracker::RgbTargetTracker() : impl_(std::make_unique<Impl>()) {}
RgbTargetTracker::~RgbTargetTracker() = default;
bool RgbTargetTracker::matches_config(const RgbTargetConfig &c) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  const auto &old = impl_->config;
  return old.enabled == c.enabled && old.plane_verified == c.plane_verified &&
         old.confirmation_frames == c.confirmation_frames &&
         old.handoff_distance_m == c.handoff_distance_m &&
         old.max_rgb_seconds == c.max_rgb_seconds &&
         old.max_rgb_travel_m == c.max_rgb_travel_m;
}
void RgbTargetTracker::release() {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->state = {};
  impl_->received = {};
  impl_->rgb_started = {};
}
void RgbTargetTracker::invalidate(const std::string &why) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->lose(why);
}
RgbTargetState RgbTargetTracker::snapshot() {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  auto &s = impl_->state;
  if (!s.target_id.empty() && impl_->received != Steady::time_point{}) {
    s.age_ms =
        s.frame.source_age_ms + std::chrono::duration<double, std::milli>(
                                    Steady::now() - impl_->received)
                                    .count();
    if (s.age_ms >= 500)
      impl_->lose("RGB 目标观测已过期，需重新选择");
  }
  return s;
}
void RgbTargetTracker::update(const RgbTargetFrame &f) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
#ifdef EASY_DEBUG_HAS_OPENCV
  try {
    impl_->process(f);
  } catch (const std::exception &e) {
    impl_->lose(e.what());
  }
#else
  (void)f;
#endif
}
RgbTargetState RgbTargetTracker::select(const RgbTargetFrame &f,
                                        const ObjectBox &b,
                                        const RgbTargetConfig &config) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  for (int i = 0; i < 3; ++i)
    if (!std::isfinite(b.center[i]) || std::abs(b.center[i]) > 3 ||
        !std::isfinite(b.size[i]) || b.size[i] < .001 || b.size[i] > .5)
      throw std::runtime_error("三维目标范围无效");
  if (!b.id || config.confirmation_frames < 3 ||
      config.confirmation_frames > 10)
    throw std::runtime_error("RGB 目标或核验帧数无效");
#ifdef EASY_DEBUG_HAS_OPENCV
  auto checked_image = Impl::image(f);
#endif
  impl_->state = {};
  impl_->received = Steady::now();
  impl_->rgb_started = {};
  auto &s = impl_->state;
  std::random_device random;
  std::ostringstream uuid;
  uuid << std::hex << std::setfill('0');
  for (int i = 0; i < 16; ++i) {
    if (i == 4 || i == 6 || i == 8 || i == 10)
      uuid << '-';
    unsigned value = random() & 255;
    if (i == 6)
      value = (value & 15) | 64;
    if (i == 8)
      value = (value & 63) | 128;
    uuid << std::setw(2) << value;
  }
  s.target_id = uuid.str();
  s.object_id = b.id;
  s.box = b;
  s.sequence = 1;
  s.generation = f.generation;
  s.stamp_ns = f.stamp_ns;
  s.frame = f;
  s.plane_verified = config.plane_verified;
  impl_->config = config;
  s.locked_yaw = b.size[1] < b.size[0] ? 1.5707963267948966 : 0;
#ifdef EASY_DEBUG_HAS_OPENCV
  try {
    if (!config.enabled)
      throw std::runtime_error("RGB 跟踪未启用");
    impl_->config = config;
    impl_->reference = f;
    impl_->initial = b;
    impl_->correction = {};
    impl_->agreements = 1;
    impl_->handed_off = false;
    impl_->hsv = std::move(checked_image);
    impl_->anchor = {b.center[0], b.center[1], b.center[2] + b.size[2] / 2};
    std::vector<cv::Point> expected;
    for (double x : {-.5, .5})
      for (double y : {-.5, .5})
       for (double z : {-.5, .5}) {
        auto p = b.center;
        p[0] += x * b.size[0];
        p[1] += y * b.size[1];
        p[2] += z * b.size[2];
        auto v = Impl::project(f, p);
        expected.emplace_back(cvRound(v.x), cvRound(v.y));
      }
    std::vector<cv::Point> hull_expected;
    cv::convexHull(expected, hull_expected);
    expected = std::move(hull_expected);
    auto roi = cv::boundingRect(expected) &
               cv::Rect(0, 0, impl_->hsv.cols, impl_->hsv.rows);
    if (roi.area() < 36)
      throw std::runtime_error("目标 RGB 投影过小");
    std::array<unsigned, 180> bins{};
    for (int y = roi.y; y < roi.br().y; ++y)
      for (int x = roi.x; x < roi.br().x; ++x) {
        auto pixel = impl_->hsv.at<cv::Vec3b>(y, x);
        if (pixel[1] >= 60 && pixel[2] >= 35 &&
            impl_->inside_selected_box(f, x, y))
          ++bins[pixel[0]];
      }
    impl_->hue = int(std::max_element(bins.begin(), bins.end()) - bins.begin());
    impl_->saturation = 80;
    if (bins[impl_->hue] < 12)
      throw std::runtime_error("目标缺少可稳定跟踪的颜色");
    auto found = impl_->candidates(impl_->hsv, expected, true);
    // A looser AABB silhouette is never sufficient evidence by itself:
    // require depth-supported membership in this exact selected 3D box.
    found.erase(std::remove_if(found.begin(), found.end(), [&](const auto &c) {
      unsigned pixels=0, members=0;
      for (int y=c.roi.y; y<c.roi.br().y; y+=2)
        for (int x=c.roi.x; x<c.roi.br().x; x+=2)
          if (cv::pointPolygonTest(c.contour, cv::Point2f(x,y), false)>=0) {
            ++pixels;
            if (impl_->inside_selected_box(f,x,y)) ++members;
          }
      return members<8 || members < pixels*.80;
    }), found.end());
    if (found.empty() ||
        (found.size() > 1 && found[0].score - found[1].score < .25))
      throw std::runtime_error("无法将 RGB 区域唯一对应到所选三维物体");
    const auto &c = found.front();
    const auto measured = impl_->ray(f, c.center);
    impl_->anchor = measured;
    impl_->polygon.clear();
    std::vector<cv::Point> hull;
    cv::convexHull(c.contour, hull);
    for (size_t i = 0; i < hull.size();
         i += std::max(size_t{1}, hull.size() / 24))
      impl_->polygon.push_back(impl_->ray(f, hull[i]));
    if (!impl_->depth_agrees(f, c))
      throw std::runtime_error("选择时 RGB 区域缺少一致深度，需重新选择");
    s.roi = {double(c.roi.x), double(c.roi.y), double(c.roi.width),
             double(c.roi.height)};
    s.camera_z_m =
        Impl::point(tcp_pose_inverse(f.camera_to_base), impl_->anchor)[2];
    s.mode = "confirming";
    s.message = "RGBD/RGB 多帧核验中";
    s.confidence = std::clamp(c.score, 0., 1.);
    s.geometry_source = "depth_verified_surface";
  } catch (const std::exception &e) {
    impl_->lose(e.what());
  }
#else
  (void)config;
  impl_->lose("Bridge 未安装 OpenCV RGB 跟踪组件");
#endif
  return s;
}
} // namespace easy_debug_bridge
