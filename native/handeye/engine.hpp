#pragma once
#include <cmath>
#include <nlohmann/json.hpp>
#include <opencv2/aruco.hpp>
#include <opencv2/aruco/charuco.hpp>
#include <opencv2/calib3d.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <stdexcept>
#include <string>
#include <vector>

namespace handeye {
using Json = nlohmann::json;
inline void require(bool ok, const std::string &message) {
  if (!ok)
    throw std::runtime_error(message);
}
inline double finite(const Json &x) {
  require(x.is_number(), "Expected numeric value");
  double v = x.get<double>();
  require(std::isfinite(v), "Non-finite number");
  return v;
}
inline cv::Mat matrix(const Json &j, int rows, int cols) {
  require(j.is_array() && j.size() == size_t(rows * cols),
          "Invalid matrix size");
  cv::Mat m(rows, cols, CV_64F);
  for (int i = 0; i < rows * cols; ++i)
    m.at<double>(i / cols, i % cols) = finite(j.at(i));
  return m;
}
inline Json array(const cv::Mat &in) {
  cv::Mat m;
  in.convertTo(m, CV_64F);
  Json a = Json::array();
  for (int r = 0; r < m.rows; ++r)
    for (int c = 0; c < m.cols; ++c)
      a.push_back(m.at<double>(r, c));
  return a;
}
inline cv::Mat pose(const Json &j) {
  cv::Mat m = matrix(j, 4, 4), r = m(cv::Rect(0, 0, 3, 3));
  require(cv::norm(r.t() * r - cv::Mat::eye(3, 3, CV_64F)) < 1e-5 &&
              std::abs(cv::determinant(r) - 1) < 1e-5,
          "Pose rotation is not orthonormal");
  require(cv::norm(m.row(3) - (cv::Mat_<double>(1, 4) << 0, 0, 0, 1)) < 1e-8,
          "Invalid homogeneous pose");
  return m;
}
inline cv::Mat transform(const cv::Mat &r, const cv::Mat &t) {
  cv::Mat m = cv::Mat::eye(4, 4, CV_64F);
  r.copyTo(m(cv::Rect(0, 0, 3, 3)));
  t.reshape(1, 3).copyTo(m(cv::Rect(3, 0, 1, 3)));
  return m;
}
inline double angle(const cv::Mat &a, const cv::Mat &b) {
  cv::Mat v;
  cv::Rodrigues(a(cv::Rect(0, 0, 3, 3)).t() * b(cv::Rect(0, 0, 3, 3)), v);
  return cv::norm(v);
}
inline std::string encode(const std::vector<uchar> &bytes) {
  const char *chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  for (size_t i = 0; i < bytes.size(); i += 3) {
    uint32_t n = uint32_t(bytes[i]) << 16;
    if (i + 1 < bytes.size())
      n |= uint32_t(bytes[i + 1]) << 8;
    if (i + 2 < bytes.size())
      n |= bytes[i + 2];
    out += chars[(n >> 18) & 63];
    out += chars[(n >> 12) & 63];
    out += i + 1 < bytes.size() ? chars[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.size() ? chars[n & 63] : '=';
  }
  return out;
}
inline std::vector<uchar> decode(const std::string &s) {
  require(s.size() <= 24 * 1024 * 1024 && s.size() % 4 == 0,
          "Image payload too large or invalid");
  std::vector<uchar> out;
  unsigned acc = 0;
  int bits = 0;
  bool pad = false;
  const std::string chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (char c : s) {
    if (c == '=') {
      pad = true;
      continue;
    }
    auto n = chars.find(c);
    require(!pad && n != std::string::npos, "Invalid base64 image");
    acc = (acc << 6) | unsigned(n);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(uchar((acc >> bits) & 255));
    }
  }
  return out;
}
inline std::string png(const cv::Mat &m) {
  std::vector<uchar> b;
  require(cv::imencode(".png", m, b), "PNG encoding failed");
  return encode(b);
}
struct Board {
  cv::Ptr<cv::aruco::Dictionary> dict;
  cv::Ptr<cv::aruco::Board> board;
  cv::Ptr<cv::aruco::CharucoBoard> charuco;
  cv::Ptr<cv::aruco::GridBoard> grid;
  int x, y;
  double square, marker;
  bool is_charuco;
  explicit Board(const Json &j) {
    x = j.at("squares_x").get<int>();
    y = j.at("squares_y").get<int>();
    square = finite(j.at("square_m"));
    marker = finite(j.at("marker_m"));
    require(x >= 3 && x <= 30 && y >= 3 && y <= 30,
            "Board dimensions must be 3–30");
    require(square >= 0.002 && square <= 0.2 && marker >= 0.001 &&
                marker < square,
            "Board lengths are invalid (metres)");
    std::string d = j.at("dictionary");
    int id;
    if (d == "DICT_4X4_50")
      id = cv::aruco::DICT_4X4_50;
    else if (d == "DICT_5X5_250")
      id = cv::aruco::DICT_5X5_250;
    else if (d == "DICT_6X6_250")
      id = cv::aruco::DICT_6X6_250;
    else
      throw std::runtime_error("Unsupported marker dictionary");

#if CV_VERSION_MAJOR > 4 || CV_VERSION_MINOR >= 7
    dict = cv::makePtr<cv::aruco::Dictionary>(
        cv::aruco::getPredefinedDictionary(id));
#else
    dict = cv::aruco::getPredefinedDictionary(id);
#endif
    std::string kind = j.at("kind");
    require(kind == "charuco" || kind == "aruco", "Unsupported board type");
    is_charuco = kind == "charuco";
    require((is_charuco ? x * y / 2 : x * y) <= dict->bytesList.rows,
            "Board exceeds dictionary marker count");
#if CV_VERSION_MAJOR > 4 || CV_VERSION_MINOR >= 7
    if (is_charuco) {
      charuco = cv::makePtr<cv::aruco::CharucoBoard>(
          cv::Size(x, y), float(square), float(marker), *dict);
      charuco->setLegacyPattern(j.value("legacy_pattern", true));
      board = charuco;
    } else
      board = cv::makePtr<cv::aruco::GridBoard>(cv::Size(x, y), float(marker),
                                                float(square - marker), *dict);
#else
    require(j.value("legacy_pattern", true),
            "This OpenCV version only supports legacy board layout");
    if (is_charuco) {
      charuco = cv::aruco::CharucoBoard::create(x, y, float(square),
                                                float(marker), dict);
      board = charuco;
    } else {
      grid = cv::aruco::GridBoard::create(x, y, float(marker),
                                          float(square - marker), dict);
      board = grid;
    }
#endif
  }
  cv::Mat render() const {
    cv::Mat image;
    cv::Size size(1200, int(std::round(1200.0 * y / x)));
#if CV_VERSION_MAJOR > 4 || CV_VERSION_MINOR >= 7
    board->generateImage(size, image, 20, 1);
#else
    if (is_charuco)
      charuco->draw(size, image, 20, 1);
    else
      grid->draw(size, image, 20, 1);
#endif
    return image;
  }
  std::vector<cv::Point3f> chess() const {
#if CV_VERSION_MAJOR > 4 || CV_VERSION_MINOR >= 7
    return charuco->getChessboardCorners();
#else
    return charuco->chessboardCorners;
#endif
  }
  void points(const std::vector<std::vector<cv::Point2f>> &corners,
              const std::vector<int> &ids, std::vector<cv::Point3f> &obj,
              std::vector<cv::Point2f> &img) const {
#if CV_VERSION_MAJOR > 4 || CV_VERSION_MINOR >= 7
    auto bid = board->getIds();
    auto bp = board->getObjPoints();
#else
    auto bid = board->ids;
    auto bp = board->objPoints;
#endif
    for (size_t i = 0; i < ids.size(); ++i) {
      auto it = std::find(bid.begin(), bid.end(), ids[i]);
      if (it == bid.end())
        continue;
      auto n = size_t(it - bid.begin());
      obj.insert(obj.end(), bp[n].begin(), bp[n].end());
      img.insert(img.end(), corners[i].begin(), corners[i].end());
    }
  }
};
inline Json detect(const Json &req) {
  Board board(req.at("board"));
  cv::Mat image = cv::imdecode(decode(req.at("image_png").get<std::string>()),
                               cv::IMREAD_COLOR);
  require(!image.empty() && image.cols <= 4096 && image.rows <= 4096,
          "Invalid image dimensions");
  cv::Mat k = matrix(req.at("k"), 3, 3);
  require(k.at<double>(0, 0) > 0 && k.at<double>(1, 1) > 0,
          "Invalid focal length");
  auto dj = req.at("d");
  require(dj.is_array() &&
              (dj.size() == 0 || dj.size() == 4 || dj.size() == 5 ||
               dj.size() == 8 || dj.size() == 12 || dj.size() == 14),
          "Unsupported distortion coefficients");
  std::string model = req.value("distortion_model", "plumb_bob");
  require(model == "plumb_bob" || model == "rational_polynomial" ||
              model == "none",
          "Unsupported camera distortion model");
  cv::Mat d = dj.empty() ? cv::Mat() : matrix(dj, 1, int(dj.size()));
  std::vector<int> ids;
  std::vector<std::vector<cv::Point2f>> corners;
  cv::aruco::detectMarkers(image, board.dict, corners, ids);
  std::vector<cv::Point3f> obj;
  std::vector<cv::Point2f> img;
  Json corner_ids = Json::array();
  if (board.is_charuco && !ids.empty()) {
    cv::Mat cc, ci;
    cv::aruco::interpolateCornersCharuco(corners, ids, image, board.charuco, cc,
                                         ci, k, d);
    auto chess = board.chess();
    for (int i = 0; i < ci.rows; ++i) {
      int id = ci.at<int>(i);
      obj.push_back(chess.at(id));
      img.push_back(cc.at<cv::Point2f>(i));
      corner_ids.push_back(id);
    }
  } else if (!board.is_charuco)
    board.points(corners, ids, obj, img);
  require(img.size() >= (board.is_charuco ? 8u : 12u),
          "Not enough board corners; keep the board in view and in focus");
  std::vector<cv::Point2f> hull;
  cv::convexHull(img, hull);
  double coverage = cv::contourArea(hull) / (image.cols * image.rows);
  require(coverage >= 0.01, "Board is too small in the image");
  cv::Mat rv, tv;
  require(cv::solvePnP(obj, img, k, d, rv, tv, false, cv::SOLVEPNP_ITERATIVE),
          "Board pose estimation failed");
  require(tv.at<double>(2) > 0, "Board pose is behind camera");
  cv::Mat r;
  cv::Rodrigues(rv, r);
  std::vector<cv::Point2f> projected;
  cv::projectPoints(obj, rv, tv, k, d, projected);
  double sum = 0, max_error = 0;
  for (size_t i = 0; i < img.size(); ++i) {
    double e = cv::norm(projected[i] - img[i]);
    sum += e * e;
    max_error = std::max(max_error, e);
    cv::circle(image, img[i], 3, cv::Scalar(0, 255, 0), -1);
  }
  double rms = std::sqrt(sum / img.size());
  require(rms <= 1.5 && max_error <= 4,
          "Board reprojection error is too high; reject this sample");
  cv::drawFrameAxes(image, k, d, rv, tv, float(board.square * 2));
  return {{"target", array(transform(r, tv))},
          {"corners", img.size()},
          {"corner_ids", corner_ids},
          {"rms_px", rms},
          {"max_px", max_error},
          {"coverage", coverage},
          {"annotated_png", png(image)}};
}
inline cv::Mat mean_pose(const std::vector<cv::Mat> &poses) {
  cv::Mat r = cv::Mat::zeros(3, 3, CV_64F), t = cv::Mat::zeros(3, 1, CV_64F);
  for (auto &p : poses) {
    r += p(cv::Rect(0, 0, 3, 3));
    t += p(cv::Rect(3, 0, 1, 3));
  }
  cv::SVD svd(r);
  cv::Mat fix = cv::Mat::eye(3, 3, CV_64F);
  fix.at<double>(2, 2) = cv::determinant(svd.u * svd.vt);
  return transform(svd.u * fix * svd.vt, t / double(poses.size()));
}
inline Json residuals(const std::vector<cv::Mat> &poses,
                      const cv::Mat &reference) {
  Json rows = Json::array();
  double st = 0, sr = 0, mt = 0, mr = 0;
  for (auto &p : poses) {
    double t =
        cv::norm(p(cv::Rect(3, 0, 1, 3)) - reference(cv::Rect(3, 0, 1, 3)));
    double r = angle(p, reference) * 180 / CV_PI;
    st += t * t;
    sr += r * r;
    mt = std::max(mt, t);
    mr = std::max(mr, r);
    rows.push_back({{"translation_m", t}, {"rotation_deg", r}});
  }
  return {
      {"samples", rows},
      {"translation_rms_m", poses.empty() ? 0 : std::sqrt(st / poses.size())},
      {"rotation_rms_deg", poses.empty() ? 0 : std::sqrt(sr / poses.size())},
      {"translation_max_m", mt},
      {"rotation_max_deg", mr}};
}
inline Json solve(const Json &req) {
  auto samples = req.at("samples");
  require(samples.is_array() && samples.size() >= 8 && samples.size() <= 200,
          "Collect 8–200 training samples");
  std::string mode = req.value("mode", "eye_in_hand");
  require(mode == "eye_in_hand" || mode == "eye_to_hand",
          "Invalid sensor configuration");
  std::vector<cv::Mat> robot, targets, rot, tr, cr, ct;
  for (auto &s : samples) {
    auto b = pose(s.at("robot")), c = pose(s.at("target"));
    robot.push_back(b);
    targets.push_back(c);
    cv::Mat a = mode == "eye_in_hand" ? b : b.inv();
    rot.push_back(a(cv::Rect(0, 0, 3, 3)).clone());
    tr.push_back(a(cv::Rect(3, 0, 1, 3)).clone());
    cr.push_back(c(cv::Rect(0, 0, 3, 3)).clone());
    ct.push_back(c(cv::Rect(3, 0, 1, 3)).clone());
  }
  cv::Mat axes(int(robot.size() - 1), 3, CV_64F);
  double span = 0;
  for (size_t i = 1; i < robot.size(); ++i) {
    cv::Mat v;
    cv::Rodrigues(rot[0].t() * rot[i], v);
    cv::Mat row = v.t();
    row.copyTo(axes.row(int(i - 1)));
    span = std::max(span, cv::norm(v));
  }
  cv::SVD diversity(axes);
  require(span >= 15 * CV_PI / 180 &&
              diversity.w.at<double>(1) > 0.15 * diversity.w.at<double>(0),
          "Insufficient rotation diversity: rotate around at least two "
          "different axes");
  std::string method = req.value("method", "PARK");
  cv::HandEyeCalibrationMethod alg;
  if (method == "PARK")
    alg = cv::CALIB_HAND_EYE_PARK;
  else if (method == "TSAI")
    alg = cv::CALIB_HAND_EYE_TSAI;
  else if (method == "HORAUD")
    alg = cv::CALIB_HAND_EYE_HORAUD;
  else if (method == "ANDREFF")
    alg = cv::CALIB_HAND_EYE_ANDREFF;
  else if (method == "DANIILIDIS")
    alg = cv::CALIB_HAND_EYE_DANIILIDIS;
  else
    throw std::runtime_error("Unsupported solver");
  cv::Mat r, t;
  cv::calibrateHandEye(rot, tr, cr, ct, r, t, alg);
  auto x = pose(array(transform(r, t)));
  std::vector<cv::Mat> estimates;
  for (size_t i = 0; i < robot.size(); ++i) {
    cv::Mat b = mode == "eye_in_hand" ? robot[i] : robot[i].inv();
    estimates.push_back(b * x * targets[i]);
  }
  auto reference = mean_pose(estimates);
  auto fit = residuals(estimates, reference);
  std::vector<cv::Mat> held;
  auto validation = req.value("validation", Json::array());
  require(validation.is_array() && validation.size() <= 200,
          "Invalid validation set");
  std::vector<cv::Mat> seen = robot;
  for (auto &s : validation) {
    auto b = pose(s.at("robot"));
    for (const auto &prior : seen)
      require(angle(prior, b) >= 5 * CV_PI / 180,
              "Validation poses must be new and differ by at least 5 degrees "
              "from training and other validation poses");
    seen.push_back(b.clone());
    if (mode == "eye_to_hand")
      b = b.inv();
    held.push_back(b * x * pose(s.at("target")));
  }
  auto check = residuals(held, reference);
  bool passed = held.size() >= 3 &&
                fit["translation_max_m"].get<double>() <= 0.005 &&
                fit["rotation_max_deg"].get<double>() <= 2 &&
                check["translation_max_m"].get<double>() <= 0.005 &&
                check["rotation_max_deg"].get<double>() <= 2;
  return {{"transform", array(x)}, {"reference_target", array(reference)},
          {"training", fit},       {"validation", check},
          {"validated", passed},   {"method", method},
          {"mode", mode},          {"opencv_version", CV_VERSION}};
}
inline Json run(const Json &req) {
  std::string op = req.at("op");
  if (op == "board")
    return {{"image_png", png(Board(req.at("board")).render())}};
  if (op == "detect")
    return detect(req);
  if (op == "solve")
    return solve(req);
  throw std::runtime_error("Unknown hand-eye operation");
}
} // namespace handeye
