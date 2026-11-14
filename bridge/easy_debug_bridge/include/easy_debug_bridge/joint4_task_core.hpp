#pragma once
#include <chrono>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>

namespace easy_debug_bridge {
// One outstanding Trigger at a time. A timed-out request remains pending:
// abandoning it could let a delayed begin re-enable a pose after release.
class Joint4TaskCore {
 public:
  using Clock = std::chrono::steady_clock;
  using Time = Clock::time_point;
  struct Observation {
    int64_t ros_now{}, joint_stamp{}, hardware_stamp{};
    uint64_t clock_generation{}, status_revision{};
    bool fresh{}, stopped{}, pose_released{};
    uint8_t mode{};
    uint32_t sequence{};
  };
  struct Call { uint64_t serial{}; std::string action, operation; bool root{}; };
  struct Terminal { std::string phase, evidence; };
  struct Task {
    uint64_t owner{}, serial{};
    std::string id, action;
    Time lease{}, call_at{}, release_attempt{}, verified_at{}, settled{}, disable_at{};
    std::optional<Call> pending;
    bool called{}, root_result{}, root_success{}, cancel{}, disabled{}, released{}, captured{};
    std::optional<uint32_t> disable_sequence;
    Observation baseline;
    int64_t last_joint{}, last_hardware{};
  };
  const std::optional<Task> &active() const { return task_; }
  bool busy() const { return task_.has_value(); }
  bool matches(const std::string &id) const { return task_ && task_->id==id; }
  void start(uint64_t owner, const std::string &id, const std::string &action, Time now) {
    if (task_) throw std::runtime_error("Joint4 task is busy");
    Task t; t.owner=owner;t.id=id;t.action=action;t.lease=now;t.cancel=action=="release_pose";task_=t;
  }
  void cancel(uint64_t owner=0) {
    if (task_ && (!owner || owner==task_->owner)) { task_->cancel=true; task_->settled={}; }
  }
  void disable() { if(task_) {cancel();task_->disabled=true;task_->settled={};} }
  bool renew(uint64_t owner, const std::string &id, Time now) {
    if(!matches(id)||task_->owner!=owner||task_->cancel)return false;
    task_->lease=now;return true;
  }
  void tick(Time now) { if(task_ && now-task_->lease>=std::chrono::seconds(5) && !task_->cancel) cancel(); }
  Call call(const std::string &action, const std::string &operation, bool root, Time now) {
    if(!task_||task_->pending)throw std::runtime_error("Joint4 service already pending");
    if(!root && action=="capture_pose" && (task_->cancel||!task_->root_result||!task_->root_success||task_->captured||task_->action!="begin_pose"))
      throw std::runtime_error("Joint4 capture has no active uncaptured pose");
    Call call{++task_->serial,action,operation,root}; task_->pending=call;task_->called=true;task_->call_at=now;
    if(action=="release_pose")task_->release_attempt=now;
    return call;
  }
  bool result(uint64_t serial, bool success, const Observation &o, Time now) {
    if(!task_||!task_->pending||task_->pending->serial!=serial)return false;
    const auto call=*task_->pending;task_->pending.reset();
    if(call.root) {task_->root_result=true;task_->root_success=success;}
    if(call.action=="capture_pose" && success)task_->captured=true;
    if(call.action=="release_pose")task_->released=success;
    if(call.root && !success)task_->cancel=true;
    if(call.action=="release_pose" || (call.root && call.action!="begin_pose")) {
      task_->verified_at=now;task_->baseline=o;task_->last_joint=o.ros_now;task_->last_hardware=o.ros_now;task_->settled={};
    }
    return true;
  }
  bool release_due(Time now) const {
    return task_&&task_->cancel&&!task_->pending&&!task_->released&&
      (task_->release_attempt==Time{}||now-task_->release_attempt>=std::chrono::seconds(1));
  }
  bool disable_due(Time now) const {
    return task_&&task_->disabled&&(task_->disable_at==Time{}||now-task_->disable_at>=std::chrono::seconds(1));
  }
  void disabled_sent(uint32_t sequence,const Observation &o,Time now) {
    if(!task_)return;task_->disable_sequence=sequence;task_->disable_at=now;
    task_->baseline=o;task_->last_joint=o.ros_now;task_->last_hardware=o.ros_now;task_->settled={};
  }
  std::optional<Terminal> observe(const Observation &o,Time now) {
    if(!task_||task_->pending||!task_->root_result)return std::nullopt;
    const bool finite=task_->action=="fit"||task_->action=="reset";
    if(task_->cancel&&!task_->released)return std::nullopt;
    if(!task_->cancel&&!finite)return std::nullopt;
    const bool disabled=task_->disabled && task_->disable_sequence && o.mode==3 &&
      o.sequence>=*task_->disable_sequence && task_->disable_at>=task_->verified_at;
    const bool pose=task_->disabled ? disabled : (o.pose_released&&o.status_revision>task_->baseline.status_revision);
    if(!o.fresh||!o.stopped||!pose||o.clock_generation!=task_->baseline.clock_generation) {task_->settled={};return std::nullopt;}
    if(o.joint_stamp<=task_->last_joint||o.hardware_stamp<=task_->last_hardware)return std::nullopt;
    task_->last_joint=o.joint_stamp;task_->last_hardware=o.hardware_stamp;
    if(task_->settled==Time{})task_->settled=now;
    if(now-task_->settled<std::chrono::milliseconds(200))return std::nullopt;
    if(task_->disabled)return Terminal{"canceled","output_disabled"};
    if(!task_->root_success)return Terminal{"failed","service_rejected"};
    if(task_->cancel)return Terminal{"canceled","pose_released"};
    return Terminal{"succeeded","service_verified"};
  }
  void clear() { task_.reset(); }
 private:
  std::optional<Task> task_;
};
}
