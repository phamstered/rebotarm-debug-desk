#include "easy_debug_bridge/joint4_calibration.hpp"
#include "easy_debug_bridge/controller_registry.hpp"
#include "easy_debug_bridge/task_observation_core.hpp"
#include <std_srvs/srv/trigger.hpp>
#include <std_msgs/msg/float64_multi_array.hpp>
#include <array>
#include <cmath>
#include <map>
#include <mutex>
#include <set>

namespace easy_debug_bridge {
struct Joint4Calibration::Impl {
  using Core=Joint4TaskCore;
  using Clock=Core::Clock;
  using Trigger=std_srvs::srv::Trigger;
  rclcpp::Node &node;
  std::shared_ptr<ControllerRegistry> controllers;
  Snapshot safety; Disable disable_output; Send broadcast;
  mutable std::mutex mutex;
  Core task;
  MotionTerminalHistory history;
  std::map<std::string,rclcpp::Client<Trigger>::SharedPtr> clients;
  rclcpp::Subscription<std_msgs::msg::Float64MultiArray>::SharedPtr subscription;
  rclcpp::TimerBase::SharedPtr timer;
  std::array<double,12> status{};
  bool status_valid{};
  uint64_t revision{};
  Clock::time_point received{};
  std::map<std::string,std::string> captures;
  std::string message;
  std::optional<std::string> start_receipt;
  bool hold_confirmed{};
  Clock::time_point begin_result_at{};
  uint64_t begin_revision{};
  struct Reply { std::string request_id; Send send; };
  std::vector<Reply> start_waiters;

  static std::string q(const std::string &s) {return position_json_quote(s);}
  Impl(rclcpp::Node &n,std::shared_ptr<ControllerRegistry> registry,Snapshot s,Disable d,Send b):
      node(n),controllers(std::move(registry)),safety(std::move(s)),disable_output(std::move(d)),broadcast(std::move(b)) {
    const auto group=controllers->callback_group();
    for(const auto *action:{"begin_pose","capture_pose","release_pose","fit","reset"})
      clients[action]=node.create_client<Trigger>(std::string("/joint4_calibration_controller/")+action,rmw_qos_profile_services_default,group);
    rclcpp::SubscriptionOptions options; options.callback_group=group;
    subscription=node.create_subscription<std_msgs::msg::Float64MultiArray>("/joint4_calibration_controller/status",rclcpp::QoS(1).best_effort(),
      [this](std_msgs::msg::Float64MultiArray::ConstSharedPtr value) {
        std::lock_guard<std::mutex> lock(mutex); ++revision; received=Clock::now();
        status_valid=value->data.size()==12;
        if(status_valid) {
          std::copy(value->data.begin(),value->data.end(),status.begin());
          for(auto v:status)status_valid=status_valid&&std::isfinite(v);
          for(auto i:{9,10,11})status_valid=status_valid&&(status[i]==0||status[i]==1);
          status_valid=status_valid&&status[7]>=0&&status[8]>=0&&std::floor(status[8])==status[8];
        }
      },options);
    timer=node.create_wall_timer(std::chrono::milliseconds(50),[this]{tick();},group);
  }
  bool fresh_status() const {return status_valid&&Clock::now()-received<std::chrono::milliseconds(1500);}
  Core::Observation observation() {
    auto o=safety().observation; o.status_revision=revision;
    o.pose_released=o.mode==1&&fresh_status()&&status[9]==0&&status[10]==0&&std::abs(status[3])<=1e-6;
    if(task.active()&&task.active()->action=="reset")o.pose_released=o.pose_released&&status[8]==0;
    return o;
  }
  bool controller_active() {
    const auto c=controllers->snapshot();bool active=false;
    for(const auto &row:c.controllers)if(row.name=="joint4_calibration_controller")
      active=row.state=="active"&&row.type_name=="microros_stm32h723_bridge/Joint4CalibrationController";
    return c.fresh&&active;
  }
  std::string ready(const std::string &action) {
    if(action=="release_pose")return ""; // Release remains callable with stale/faulted feedback.
    if(!controller_active())return "Joint4 Controller 未激活或状态已过期";
    const auto safe=safety();
    if(!safe.observation.fresh||!safe.healthy||!safe.tracking)return "时钟、六轴反馈或硬件 TRACK 状态未就绪";
    if(!fresh_status())return "Joint4 状态缺失或已过期";
    if(action=="begin_pose") {
      if(status[9]!=0||std::abs(status[1])>.05)return "Begin 需要已释放且停稳的姿态";
      return ""; // Existing controller allows supported recovery from a latched fault.
    }
    if(status[10]!=0||std::abs(status[1])>=.2||std::abs(status[3])>=1.5||
      (status[9]!=0&&std::abs(status[0]-status[6])>=.12))return "Joint4 姿态保护或力矩/速度/位移检查失败";
    if(action=="capture_pose"&&(status[9]!=1||status[11]!=0||status[7]<1.5||std::abs(status[1])>.01))
      return "Capture 需要未采样、无外力且连续稳定的保持姿态";
    if((action=="fit"||action=="reset")&&status[9]!=0)return "请先支撑并释放姿态";
    if(action=="fit"&&status[8]<4)return "Fit 至少需要 4 个姿态";
    return "";
  }
  std::string event(bool terminal=false,const std::string &phase="",const std::string &evidence="") const {
    const auto &t=*task.active();
    return "{\"op\":\"joint4_task_state\",\"command_id\":"+q(t.id)+",\"action\":"+q(t.action)+
      ",\"terminal\":"+(terminal?"true":"false")+",\"task_phase\":"+q(terminal?phase:t.cancel?"stopping":t.root_result?"running":"queued")+
      ",\"evidence\":"+q(evidence)+",\"message\":"+q(message)+"}";
  }
  void finish(const std::string &phase,const std::string &evidence) {
    const auto text=event(true,phase,evidence);history.record(task.active()->id,phase,text);broadcast(text);
    task.clear();captures.clear();start_receipt.reset();start_waiters.clear();
  }
  void send_start(const std::string &fields) {
    start_receipt=fields;
    for(const auto &waiter:start_waiters)waiter.send("{\"op\":\"joint4_start_ack\",\"request_id\":"+q(waiter.request_id)+","+fields+"}");
    start_waiters.clear();
  }
  std::string start_fields(bool accepted,bool success,const std::string &detail,const std::string &evidence="") const {
    const auto &t=*task.active();return "\"command_id\":"+q(t.id)+",\"action\":"+q(t.action)+
      ",\"accepted\":"+(accepted?"true":"false")+",\"success\":"+(success?"true":"false")+
      ",\"message\":"+q(detail)+",\"evidence\":"+q(evidence);
  }
  void call(const std::string &action,const std::string &operation,bool root,Reply reply={}) {
    const auto id=task.active()->id;
    const auto call=task.call(action,operation,root,Clock::now()); // Before async_send: throws may be ambiguous.
    try {
      clients.at(action)->async_send_request(std::make_shared<Trigger::Request>(),[this,id,call,reply](rclcpp::Client<Trigger>::SharedFuture future) {
        std::lock_guard<std::mutex> lock(mutex);
        if(!task.matches(id))return;
        bool success=false;std::string detail;
        try {const auto response=future.get();success=response->success;detail=response->message;}
        catch(const std::exception &e) {
          task.cancel();message=std::string("服务结果未知，保留在途占用：")+e.what();broadcast(event());return;
        }
        if(detail.size()>16384) {detail="服务响应超过 16 KiB，结果不可信";success=false;task.cancel();}
        task.result(call.serial,success,observation(),Clock::now());message=detail;
        if(call.root&&call.action=="begin_pose"&&success) {begin_result_at=Clock::now();begin_revision=revision;}
        if(call.root)send_start(start_fields(true,success,detail));
        if(call.action=="capture_pose") {
          const auto fields="\"command_id\":"+q(id)+",\"operation_id\":"+q(call.operation)+
            ",\"success\":"+(success?"true":"false")+",\"message\":"+q(detail);
          captures[call.operation]=fields;
          if(reply.send)reply.send("{\"op\":\"joint4_capture_ack\",\"request_id\":"+q(reply.request_id)+","+fields+"}");
        }
        broadcast(event());
      });
    } catch(const std::exception &e) {
      task.cancel();message=std::string("服务提交结果未知，保留在途占用：")+e.what();broadcast(event());
      // Do not clear pending or retry: ROS may already have received the call.
    }
  }
  void tick() {
    std::lock_guard<std::mutex> lock(mutex);
    if(!task.busy())return;
    task.tick(Clock::now());
    if(task.active()->action=="begin_pose"&&task.active()->root_result&&!task.active()->cancel) {
      const auto safe=safety();
      if(!hold_confirmed && revision>begin_revision && fresh_status() && status[9]==1)hold_confirmed=true;
      const bool missing_hold=hold_confirmed?status[9]!=1:Clock::now()-begin_result_at>=std::chrono::milliseconds(1500);
      const bool bad_status=revision>begin_revision&&(status[10]!=0||std::abs(status[1])>=.2||std::abs(status[3])>=1.5||std::abs(status[0]-status[6])>=.12);
      if(!controller_active()||!safe.observation.fresh||!safe.healthy||!safe.tracking||!fresh_status()||bad_status||missing_hold) {
        task.cancel();message="Joint4 状态丢失或保护触发，正在请求释放姿态";
      }
    }
    if(task.release_due(Clock::now())&&clients.at("release_pose")->service_is_ready())call("release_pose","",false);
    if(task.disable_due(Clock::now())) {
      try {const auto seq=disable_output();task.disabled_sent(seq,observation(),Clock::now());}
      catch(const std::exception &e) {message=e.what();}
    }
    if(const auto done=task.observe(observation(),Clock::now())) {
      message=done->evidence=="pose_released"?"已核验姿态释放；重力前馈仍有效":done->evidence=="output_disabled"?"已核验新 DISABLE 序列及六轴停稳":"已核验服务结果与释放状态";
      finish(done->phase,done->evidence);
    }
  }
  static void validate(const boost::property_tree::ptree &r) {
    const auto op=r.get<std::string>("op","");
    std::set<std::string> keys;
    for(const auto &field:r) {
      const bool allowed=field.first=="op"||field.first=="request_id"||field.first=="command_id"||
        (op=="joint4_start"&&(field.first=="action"||field.first=="confirmation"))||
        (op=="joint4_capture"&&(field.first=="operation_id"||field.first=="confirmation"));
      if(!allowed||!field.second.empty()||!keys.insert(field.first).second)throw std::runtime_error("Joint4 字段重复、未知或类型错误");
    }
    if(r.get<std::string>("request_id","").size()>128)throw std::runtime_error("Joint4 request_id 过长");
    if(!valid_motion_command_id(r.get<std::string>("command_id","")))throw std::runtime_error("Joint4 command_id 无效");
    if(op=="joint4_capture"&&(!valid_motion_command_id(r.get<std::string>("operation_id",""))||r.get<std::string>("confirmation","")!="HANDS_CLEAR"))
      throw std::runtime_error("Capture 缺少唯一编号或手离开确认");
    if(op=="joint4_start") {
      const auto action=r.get<std::string>("action","");
      if(action!="begin_pose"&&action!="release_pose"&&action!="fit"&&action!="reset")throw std::runtime_error("Joint4 操作无效");
      if((action=="begin_pose"||action=="release_pose")&&r.get<std::string>("confirmation","")!="SUPPORTED")throw std::runtime_error("请先托住机械臂并确认");
    }
  }
  void request(uint64_t owner,const boost::property_tree::ptree &r,Send send,bool conflict) {
    validate(r);std::lock_guard<std::mutex> lock(mutex);
    const auto op=r.get<std::string>("op"),id=r.get<std::string>("command_id"),rid=r.get<std::string>("request_id","");
    const auto prefix="\"request_id\":"+q(rid)+",\"command_id\":"+q(id);
    if(op=="joint4_heartbeat") {
      const bool renewed=task.renew(owner,id,Clock::now());send("{\"op\":\"joint4_heartbeat_ack\","+prefix+",\"renewed\":"+(renewed?"true":"false")+"}");return;
    }
    if(op=="joint4_cancel") {
      const bool accepted=task.matches(id)&&task.active()->owner==owner;
      if(accepted) {task.cancel(owner);message="已请求释放，等待服务返回和新鲜反馈";broadcast(event());}
      send("{\"op\":\"joint4_cancel_ack\","+prefix+",\"accepted\":"+(accepted?"true":"false")+"}");return;
    }
    if(op=="joint4_task_status") {
      const auto terminal=history.find(id);const bool known=terminal.has_value()||task.matches(id);
      send("{\"op\":\"joint4_task_status\","+prefix+",\"known\":"+(known?"true":"false")+
        ",\"terminal\":"+(terminal?"true":"false")+",\"busy\":"+(task.matches(id)?"true":"false")+
        ",\"task_phase\":"+q(terminal?*terminal:task.matches(id)?task.active()->cancel?"stopping":task.active()->root_result?"running":"queued":"unknown")+
        ",\"result\":"+(terminal?history.state(id):"null")+"}");return;
    }
    if(op=="joint4_start") {
      const auto action=r.get<std::string>("action");
      if(task.matches(id)) {
        if(task.active()->owner!=owner||task.active()->action!=action)throw std::runtime_error("Joint4 编号已属于另一请求");
        if(start_receipt)send("{\"op\":\"joint4_start_ack\",\"request_id\":"+q(rid)+","+*start_receipt+"}");
        else {if(start_waiters.size()>=8)throw std::runtime_error("等待服务回执的请求过多");start_waiters.push_back({rid,send});}
        return;
      }
      if(history.find(id))throw std::runtime_error("Joint4 command_id 已完成，不能重复调用服务；请查询终态");
      if(task.busy()||conflict||!controllers->supported()) {
        const std::string reason="已有任务占用或 Controller 查询能力不可用，未调用 Joint4 服务";
        const auto result="{\"op\":\"joint4_task_state\",\"command_id\":"+q(id)+",\"action\":"+q(action)+",\"terminal\":true,\"task_phase\":\"failed\",\"evidence\":\"not_called\",\"message\":"+q(reason)+"}";
        history.record(id,"failed",result);
        send("{\"op\":\"joint4_start_ack\","+prefix+",\"action\":"+q(action)+",\"accepted\":false,\"success\":false,\"evidence\":\"not_called\",\"message\":"+q(reason)+"}");
        broadcast(result);return;
      }
      task.start(owner,id,action,Clock::now());captures.clear();start_receipt.reset();start_waiters={{rid,send}};hold_confirmed=false;begin_result_at={};begin_revision=0;
      const auto error=ready(action);
      if(!error.empty()||!clients.at(action)->service_is_ready()) {
        message=error.empty()?"Joint4 Trigger 服务不可用":error;send_start(start_fields(false,false,message,"not_called"));finish("failed","not_called");return;
      }
      message="正在调用 Joint4 服务";broadcast(event());call(action,"",true);return;
    }
    if(op=="joint4_capture") {
      const auto operation=r.get<std::string>("operation_id");
      if(!task.matches(id)||task.active()->owner!=owner||task.active()->action!="begin_pose")throw std::runtime_error("Capture 不属于当前姿态任务");
      const auto receipt=captures.find(operation);
      if(receipt!=captures.end()) {send("{\"op\":\"joint4_capture_ack\",\"request_id\":"+q(rid)+","+receipt->second+"}");return;}
      if(captures.size()>=64)throw std::runtime_error("当前姿态采样记录已达上限");
      if(task.active()->pending)throw std::runtime_error("Joint4 服务仍在途，不能重复采样");
      const auto error=ready("capture_pose");if(!error.empty())throw std::runtime_error(error);
      if(!clients.at("capture_pose")->service_is_ready())throw std::runtime_error("Capture 服务不可用");
      call("capture_pose",operation,false,{rid,send});return;
    }
    throw std::runtime_error("未知 Joint4 操作");
  }
};
Joint4Calibration::Joint4Calibration(rclcpp::Node &node,std::shared_ptr<ControllerRegistry> c,Snapshot s,Disable d,Send b):impl_(std::make_unique<Impl>(node,std::move(c),std::move(s),std::move(d),std::move(b))){}
Joint4Calibration::~Joint4Calibration()=default;
void Joint4Calibration::request(uint64_t owner,const boost::property_tree::ptree &r,Send send,bool conflict){impl_->request(owner,r,std::move(send),conflict);}
void Joint4Calibration::disconnected(uint64_t owner){std::lock_guard<std::mutex> lock(impl_->mutex);impl_->task.cancel(owner);}
void Joint4Calibration::disable(){std::lock_guard<std::mutex> lock(impl_->mutex);impl_->task.disable();}
bool Joint4Calibration::busy()const{std::lock_guard<std::mutex> lock(impl_->mutex);return impl_->task.busy();}
bool Joint4Calibration::supported()const{return impl_->controllers->supported();}
}
