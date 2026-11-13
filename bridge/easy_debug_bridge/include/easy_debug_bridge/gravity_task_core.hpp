#pragma once
#include "easy_debug_bridge/task_observation_core.hpp"
#include <chrono>
#include <optional>
#include <stdexcept>
#include <string>

namespace easy_debug_bridge {
// Caller serializes this state with its ROS handle. Queries never extend leases.
class GravityTaskCore {
 public:
  using Clock = std::chrono::steady_clock;
  struct Task {
    std::string id, phase{"accepted"}, result_phase, result_json;
    uint64_t owner{};
    bool cancel_requested{}, result_received{}, disable_requested{};
    std::optional<uint32_t> disable_sequence;
    Clock::time_point disable_at{};
    Clock::time_point lease, result_at{}, settled_at{}, cancel_at{};
    int64_t status_stamp{}, joint_stamp{};
  };
  const std::optional<Task> &active() const { return task_; }
  bool busy() const { return task_.has_value(); }
  bool matches(const std::string &id) const { return task_ && task_->id == id; }
  void start(uint64_t owner, const std::string &id, Clock::time_point now) {
    if (!valid_motion_command_id(id)) throw std::runtime_error("重力辨识 command_id 无效");
    if (busy()) throw std::runtime_error("已有重力辨识任务，需等待停止确认");
    if (history_.find(id)) throw std::runtime_error("重力辨识 command_id 已使用");
    Task task; task.id=id;task.owner=owner;task.lease=now;task_=std::move(task);
  }
  bool renew(uint64_t owner, const std::string &id, Clock::time_point now) {
    if (!matches(id) || task_->owner!=owner || task_->cancel_requested || task_->result_received) return false;
    task_->lease=now;return true;
  }
  void accepted(const std::string &id) { if (matches(id) && !task_->cancel_requested && !task_->result_received) task_->phase="executing"; }
  bool cancel(const std::string &id) {
    if (!matches(id)) return false;
    task_->cancel_requested=true;
    if (!task_->result_received) task_->phase="canceling";
    return true;
  }
  void lost(uint64_t owner) { if (task_ && (owner==0 || task_->owner==owner)) cancel(task_->id); }
  void disable() { if (task_) {cancel(task_->id);task_->disable_requested=true;task_->settled_at={};} }
  bool disable_due(Clock::time_point now) const {
    return task_ && task_->disable_requested && task_->result_received &&
      now-task_->result_at>=std::chrono::milliseconds(300) &&
      (task_->disable_at==Clock::time_point{} || now-task_->disable_at>=std::chrono::seconds(1));
  }
  void disabled_sent(uint32_t sequence, Clock::time_point now) {
    if (task_) {task_->disable_sequence=sequence;task_->disable_at=now;task_->settled_at={};}
  }
  bool cancel_due(Clock::time_point now) {
    if (!task_ || task_->result_received) return false;
    if (now-task_->lease >= std::chrono::seconds(5)) cancel(task_->id);
    if (!task_->cancel_requested || (task_->cancel_at!=Clock::time_point{} && now-task_->cancel_at<std::chrono::seconds(1))) return false;
    task_->cancel_at=now;return true;
  }
  void rejected(const std::string &id, const std::string &json) {
    if (!matches(id)) return;
    history_.record(id,"failed",json);task_.reset();
  }
  void result(const std::string &id, const std::string &phase, const std::string &json,
              Clock::time_point now, int64_t status_stamp, int64_t joint_stamp) {
    if (!matches(id) || task_->result_received) return;
    if (!motion_terminal_phase(phase) || json.size()>256*1024) throw std::runtime_error("重力辨识结果无效或过大");
    task_->result_received=true;task_->phase="awaiting_stop";task_->result_phase=phase;
    task_->result_json=json;task_->result_at=now;
    task_->status_stamp=status_stamp;task_->joint_stamp=joint_stamp;
  }
  // Both inputs must be newly sourced, fresh and post-result; a replay cannot
  // accumulate settling time. The adapter checks six named finite velocities.
  std::optional<Task> observe_stop(Clock::time_point now, int64_t status_stamp, int64_t joint_stamp,
                                  bool stopped_and_fresh, uint8_t mode=0, uint32_t sequence=0) {
    if (!task_ || !task_->result_received) return std::nullopt;
    if (task_->disable_requested) stopped_and_fresh=stopped_and_fresh && mode==3 &&
      task_->disable_sequence && sequence>=*task_->disable_sequence && now>=task_->disable_at;
    if (!stopped_and_fresh) {task_->settled_at={};return std::nullopt;}
    if (status_stamp<=task_->status_stamp || joint_stamp<=task_->joint_stamp) return std::nullopt;
    task_->status_stamp=status_stamp;task_->joint_stamp=joint_stamp;
    if (task_->settled_at==Clock::time_point{}) task_->settled_at=now;
    if (now-task_->result_at<std::chrono::milliseconds(300) || now-task_->settled_at<std::chrono::milliseconds(200)) return std::nullopt;
    auto done=*task_;history_.record(done.id,done.result_phase,done.result_json);task_.reset();return done;
  }
  std::optional<std::string> terminal(const std::string &id) const {return history_.find(id);}
  std::string retained(const std::string &id) const {return history_.state(id);}
 private:
  std::optional<Task> task_;
  MotionTerminalHistory history_;
};
}
