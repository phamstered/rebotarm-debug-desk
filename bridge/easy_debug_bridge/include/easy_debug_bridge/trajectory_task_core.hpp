#pragma once
#include "easy_debug_bridge/bridge_core.hpp"
#include "easy_debug_bridge/task_observation_core.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <deque>
#include <limits>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace easy_debug_bridge {
// Topic publication has no action result. This state machine only records
// observed arrival/output-off, never infers controller acceptance from an ACK.
// The ROS adapter must serialize admission, publish and feedback with this core.
class TrajectoryTaskCore {
 public:
  using Clock = std::chrono::steady_clock;
  using Time = Clock::time_point;
  struct Limits { double position, velocity; };
  struct Sample {
    int64_t stamp{};
    Time received{};
    std::vector<std::string> names;
    std::vector<double> positions, velocities;
  };
  struct Feedback {
    int64_t ros_now{};
    uint64_t clock_epoch{};
    bool clock_valid{};
    // Both arrays come from one JTC sample; their name order can differ from
    // the command. joint is independently received measured JointState.
    Sample reference, actual, joint;
    int64_t status_stamp{};
    Time status_received{};
    uint8_t mode{};
    uint32_t sequence{};
  };
  struct Result {
    std::string id, phase, evidence;
  };
  struct Task {
    uint64_t owner{}, epoch{};
    std::string id, phase{"queued"};
    TrajectoryCommand command;
    std::vector<Limits> limits;
    Time lease{}, sent_at{}, disable_at{}, feedback_at{};
    std::optional<Time> settled_at;
    std::optional<uint32_t> disable_sequence;
    int64_t sent_stamp{}, end_stamp{}, status_baseline{}, joint_baseline{}, controller_baseline{};
    bool sent{}, stopping{}, clock_changed{};
  };
  const std::optional<Task> &active() const { return active_; }
  bool busy() const { return active_.has_value(); }
  bool matches(const std::string &id) const { return active_ && active_->id==id; }
  void reserve(uint64_t owner, const std::string &id, const TrajectoryCommand &command,
               const std::vector<Limits> &limits, uint64_t epoch, Time now) {
    if (!owner || !valid_motion_command_id(id)) throw std::runtime_error("轨迹任务身份无效");
    if (busy()) throw std::runtime_error("已有直接轨迹任务，等待终态确认");
    if (result(id)) throw std::runtime_error("轨迹任务编号已使用");
    if (validate_trajectory_command(command)!=TrajectoryValidation::Ok)
      throw std::runtime_error("轨迹任务输入无效");
    // A finite task must end in a stationary reference. Some controller
    // configurations permit nonzero terminal velocity and repeat it indefinitely.
    for (double velocity: command.points.back().velocities)
      if (velocity!=0.) throw std::runtime_error("有限轨迹末点速度必须为零");
    if (limits.size()!=command.joint_names.size()) throw std::runtime_error("缺少轨迹关节确认阈值");
    for (const auto &limit: limits)
      if (!std::isfinite(limit.position) || !std::isfinite(limit.velocity) || limit.position<=0 || limit.velocity<=0)
        throw std::runtime_error("轨迹确认阈值必须为正有限值");
    // Conversion is only done after this bound; no floating integer overflow.
    if (command.points.back().time_from_start>=static_cast<double>(std::numeric_limits<int32_t>::max()))
      throw std::runtime_error("直接轨迹时长无法表示为 ROS Duration");
    Task task;task.owner=owner;task.id=id;task.command=command;task.limits=limits;task.epoch=epoch;task.lease=now;
    active_=std::move(task);
  }
  // Called before publish, under the same adapter lock. Once marked sent,
  // publication exceptions are uncertain and may never call reject().
  void sending(const std::string &id, int64_t stamp, Time now) {
    if (!matches(id) || active_->sent || active_->stopping) throw std::runtime_error("轨迹已发送或撤销");
    const auto duration=static_cast<int64_t>(std::ceil(active_->command.points.back().time_from_start*1e9));
    if (stamp<=0 || stamp>std::numeric_limits<int64_t>::max()-duration)
      throw std::runtime_error("轨迹源时间无效");
    active_->sent=true;active_->sent_at=now;active_->feedback_at=now;active_->sent_stamp=stamp;
    active_->end_stamp=stamp+duration;active_->phase="running";
    active_->status_baseline=active_->joint_baseline=active_->controller_baseline=stamp;
  }
  bool renew(uint64_t owner, const std::string &id, Time now) {
    if (!matches(id) || owner!=active_->owner || active_->stopping) return false;
    active_->lease=now;return true;
  }
  bool cancel(const std::string &id) {
    if (!matches(id)) return false;
    active_->stopping=true;active_->phase="stopping";active_->settled_at.reset();return true;
  }
  void lost(uint64_t owner) { if (active_ && (owner==0 || owner==active_->owner)) cancel(active_->id); }
  bool reject(const std::string &id) {
    if (!matches(id) || active_->sent) return false;
    finish("failed","not_published");return true;
  }
  void tick(Time now) {
    if (!active_) return;
    if (now-active_->lease>=std::chrono::seconds(5)) cancel_once();
    if (active_->sent) {
      if (now-active_->feedback_at>=std::chrono::seconds(1)) cancel_once();
      const double elapsed=std::chrono::duration<double>(now-active_->sent_at).count();
      if (elapsed>active_->command.points.back().time_from_start+5.) cancel_once();
    }
  }
  bool disable_due(Time now) const {
    return active_ && active_->sent && active_->stopping &&
      (!active_->disable_sequence || now-active_->disable_at>=std::chrono::seconds(1));
  }
  void disabled_sent(const std::string &id, uint32_t sequence, Time now,
                     int64_t status_baseline, int64_t joint_baseline, int64_t controller_baseline) {
    if (!matches(id) || !active_->sent || !active_->stopping) return;
    active_->disable_sequence=sequence;active_->disable_at=now;active_->settled_at.reset();
    active_->status_baseline=std::max(active_->status_baseline,status_baseline);
    active_->joint_baseline=std::max(active_->joint_baseline,joint_baseline);
    active_->controller_baseline=std::max(active_->controller_baseline,controller_baseline);
  }
  std::optional<Result> observe(const Feedback &f, Time now) {
    if (!active_ || !active_->sent) return std::nullopt;
    auto &task=*active_;
    tick(now);
    if (!f.clock_valid || f.clock_epoch!=task.epoch) {
      task.clock_changed=true;cancel_once();task.phase="uncertain";
    }
    // A time reset invalidates the original command's expiry. It cannot be
    // repaired by passing a new epoch or waiting longer on the wall clock.
    if (task.clock_changed) return std::nullopt;
    const bool frames=fresh(f.reference.stamp,f.reference.received,f.ros_now,now) &&
      fresh(f.actual.stamp,f.actual.received,f.ros_now,now) &&
      fresh(f.joint.stamp,f.joint.received,f.ros_now,now) &&
      fresh(f.status_stamp,f.status_received,f.ros_now,now) &&
      f.reference.stamp==f.actual.stamp && f.reference.received==f.actual.received;
    if (!frames || f.mode>3) {task.settled_at.reset();return std::nullopt;}
    // All sources must be newer than publish/reassertion and the previous
    // settling sample. Replayed callbacks cannot accumulate settled duration.
    if (f.reference.stamp<=task.controller_baseline || f.joint.stamp<=task.joint_baseline ||
        f.status_stamp<=task.status_baseline) return std::nullopt;
    task.controller_baseline=f.reference.stamp;task.joint_baseline=f.joint.stamp;task.status_baseline=f.status_stamp;
    task.feedback_at=std::min({f.reference.received,f.actual.received,f.joint.received,f.status_received});
    const auto &goal=task.command.points.back().positions;
    const bool after_end=f.reference.stamp>=task.end_stamp && f.joint.stamp>=task.end_stamp &&
      f.status_stamp>=task.end_stamp && std::chrono::duration<double>(now-task.sent_at).count()>=task.command.points.back().time_from_start;
    // A nonempty JTC reference at the terminal point plus zero reference
    // velocity is required even after DISABLE. Output-off alone does not prove
    // a delayed/unconsumed trajectory cannot resume when output is re-enabled.
    const bool reference_stopped=std::all_of(f.reference.velocities.begin(),f.reference.velocities.end(),
      [](double value){return std::isfinite(value) && std::abs(value)<=1e-9;});
    bool settled=after_end && reference_stopped && values_match(f.reference,task,goal,true) &&
      values_match(f.actual,task,goal,!task.stopping) && values_match(f.joint,task,goal,!task.stopping,false);
    if (task.stopping) settled=settled && task.disable_sequence && f.mode==3 &&
      f.sequence>=*task.disable_sequence && f.status_received>=task.disable_at &&
      f.joint.received>=task.disable_at && f.reference.received>=task.disable_at;
    else settled=settled && (f.mode==0 || f.mode==1);
    if (!settled) {task.settled_at.reset();return std::nullopt;}
    if (!task.settled_at) task.settled_at=now;
    if (now-*task.settled_at<std::chrono::milliseconds(200)) return std::nullopt;
    return finish(task.stopping?"canceled":"succeeded",task.stopping?"output_disabled":"target_observed");
  }
  std::optional<Result> result(const std::string &id) const {
    for (const auto &entry: history_) if (entry.id==id) return entry;
    return std::nullopt;
  }
 private:
  std::optional<Task> active_;
  std::deque<Result> history_;
  void cancel_once() { if (active_ && !active_->stopping) cancel(active_->id); }
  Result finish(const std::string &phase,const std::string &evidence) {
    Result value{active_->id,phase,evidence};history_.push_back(value);
    if (history_.size()>256) history_.pop_front();
    active_.reset();return value;
  }
  static bool fresh(int64_t stamp,Time received,int64_t ros_now,Time now) {
    return stamp>0 && ros_now>=stamp && ros_now-stamp<1000000000LL &&
      now>=received && now-received<std::chrono::milliseconds(500);
  }
  static bool values_match(const Sample &sample,const Task &task,const std::vector<double> &goal,bool at_goal,bool exact_names=true) {
    const auto count=sample.names.size();
    if (count>32 || (exact_names && count!=task.command.joint_names.size()) || sample.positions.size()!=count || sample.velocities.size()!=count) return false;
    for (size_t i=0;i<task.command.joint_names.size();++i) {
      const auto &name=task.command.joint_names[i];
      if (std::count(sample.names.begin(),sample.names.end(),name)!=1) return false;
      const size_t j=std::distance(sample.names.begin(),std::find(sample.names.begin(),sample.names.end(),name));
      if (!std::isfinite(sample.positions[j]) || !std::isfinite(sample.velocities[j]) ||
          std::abs(sample.velocities[j])>task.limits[i].velocity ||
          (at_goal && std::abs(sample.positions[j]-goal[i])>task.limits[i].position)) return false;
    }
    return true;
  }
};
}
