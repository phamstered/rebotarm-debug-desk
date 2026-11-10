#include "engine.hpp"
#include <iostream>
using namespace handeye;
cv::Mat make(double x, double y, double z, double a, double b, double c) {
  cv::Mat r, v = (cv::Mat_<double>(3, 1) << a, b, c);
  cv::Rodrigues(v, r);
  return transform(r, (cv::Mat_<double>(3, 1) << x, y, z));
}
void near(const cv::Mat &a, const cv::Mat &b, double eps, const char *why) {
  require(cv::norm(a - b) < eps, why);
}
void rejects(const Json &request, const char *why) {
  bool failed = false;
  try {
    run(request);
  } catch (const std::exception &) {
    failed = true;
  }
  require(failed, why);
}
int main() {
  try {
    Json board = {{"kind", "charuco"},     {"dictionary", "DICT_5X5_250"},
                  {"squares_x", 12},       {"squares_y", 9},
                  {"square_m", .015},      {"marker_m", .01125},
                  {"legacy_pattern", true}};
    auto rendered = run({{"op", "board"}, {"board", board}});
    auto detected = run({{"op", "detect"},
                         {"board", board},
                         {"image_png", rendered["image_png"]},
                         {"k", {1000, 0, 600, 0, 1000, 450, 0, 0, 1}},
                         {"d", {0, 0, 0, 0, 0}}});
    require(detected["corners"].get<int>() >= 70, "charuco corners missing");
    require(detected["rms_px"].get<double>() < .7, "charuco pose error");
    cv::Mat blank(900, 1200, CV_8U, cv::Scalar(255));
    rejects({{"op", "detect"},
             {"board", board},
             {"image_png", png(blank)},
             {"k", {1000, 0, 600, 0, 1000, 450, 0, 0, 1}},
             {"d", Json::array()}},
            "blank accepted");
    board["kind"] = "aruco";
    rendered = run({{"op", "board"}, {"board", board}});
    auto aruco = run({{"op", "detect"},
                      {"board", board},
                      {"image_png", rendered["image_png"]},
                      {"k", {1000, 0, 600, 0, 1000, 450, 0, 0, 1}},
                      {"d", {0, 0, 0, 0, 0}}});
    require(aruco["corners"].get<int>() > 100, "grid board not detected");
    auto x = make(.05, -.014, .067, .2, -.7, .1),
         fixed = make(.3, .2, .1, -.2, .1, .4);
    for (std::string mode : {"eye_in_hand", "eye_to_hand"}) {
      Json samples = Json::array(), validation = Json::array();
      for (int i = 0; i < 15; i++) {
        auto b =
            make(.1 + .01 * i, .2 + std::sin(i) * .04, .3 + std::cos(i) * .02,
                 std::sin(i * .7) * .6, std::cos(i * .9) * .5, .15 * i);
        cv::Mat robot = mode == "eye_in_hand" ? b : b.inv();
        cv::Mat target = x.inv() * robot.inv() * fixed;
        Json sample = {{"robot", array(b)}, {"target", array(target)}};
        (i < 12 ? samples : validation).push_back(sample);
      }
      for (std::string method :
           {"PARK", "TSAI", "HORAUD", "ANDREFF", "DANIILIDIS"}) {
        Json req = {{"op", "solve"},
                    {"mode", mode},
                    {"method", method},
                    {"samples", samples},
                    {"validation", validation}};
        auto result = run(req);
        near(pose(result["transform"]), x, 1e-5,
             "handeye direction / solution wrong");
        require(result["validated"] == true, "held-out exact samples failed");
        req["validation"][0]["target"][3] =
            req["validation"][0]["target"][3].get<double>() + .03;
        require(run(req)["validated"] == false, "held-out drift accepted");
        req["validation"] = Json::array();
        require(run(req)["validated"] == false, "empty validation accepted");
      }
      rejects({{"op", "solve"},
               {"samples", samples},
               {"validation", {samples[0], samples[1], samples[2]}}},
              "training poses reused as validation");
      auto same = samples;
      for (auto &s : same)
        s["robot"] = samples[0]["robot"];
      rejects({{"op", "solve"}, {"samples", same}},
              "degenerate rotations accepted");
      auto malformed = samples;
      malformed[0]["robot"][0] = 2.;
      rejects({{"op", "solve"}, {"samples", malformed}},
              "invalid rotation accepted");
    }
    rejects({{"op", "solve"}, {"samples", Json::array()}},
            "insufficient samples accepted");
    rejects({{"op", "unknown"}}, "unknown operation accepted");
    std::cout << "PASS: ChArUco / grid detection, blank rejection, 5 solvers x "
                 "2 sensor configurations, independent drift rejection, "
                 "degeneracy and malformed poses\n";
  } catch (const std::exception &e) {
    std::cerr << e.what() << '\n';
    return 1;
  }
}
