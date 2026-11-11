import { expect, it } from "vitest";
import { createDefaultMonitorWorkspace, addMonitorDashboard, updateMonitorFromMessage } from "./monitorLogic";
import { createMotionErrorDashboard, ARM_ERROR_CONTROLLER_TOPIC } from "./motionErrorMonitorLogic";
import { MonitorReplay, applyMonitorReplay, monitorCaptureConfig } from "./nativeMonitorLogic";
import type { MonitorHistoryPage } from "./types";

function page(overrides:Partial<MonitorHistoryPage>={}):MonitorHistoryPage {
  return {epoch:1,reset:0,now_ms:1000,localOffset:500,cursor:3,tail:3,lost:0,skipped:0,
    config:{topics:{"/joints":"sensor_msgs/msg/JointState"},paused:false,bag_playing:false},
    rows:[1,2,3].map(n=>({sequence:n,received_ms:n*10,segment:1,topic:"/joints",data:{effort:[n]}})),...overrides};
}
it("replays all retained samples at their original monotonic times and ignores duplicate pages",()=>{
  const replay=new MonitorReplay(); const workspace=createDefaultMonitorWorkspace("/joints");
  const batch=replay.accept(page(),"/joints",false);
  const next=applyMonitorReplay(workspace,batch);
  expect(next.dashboards[0]!.panels[0]!.series.points).toEqual([{t:510,value:1},{t:520,value:2},{t:530,value:3}]);
  expect(replay.accept(page(),"/joints",false).frames).toHaveLength(0);
  expect(workspace.dashboards[0]!.panels[0]!.series.points).toHaveLength(0);
});
it("clears discontinuous old points on truncation and separates reconnect/timeline history",()=>{
  const replay=new MonitorReplay();let workspace=createDefaultMonitorWorkspace("/joints");
  workspace=applyMonitorReplay(workspace,replay.accept(page(),"/joints",false));
  const next=page({cursor:9,tail:9,lost:5,rows:[{sequence:9,received_ms:90,segment:1,topic:"/joints",data:{effort:[9]}}]});
  const batch=replay.accept(next,"/joints",false);expect(batch.notice).toContain("截断 5");
  workspace=applyMonitorReplay(workspace,batch);expect(workspace.dashboards[0]!.panels[0]!.series.points).toEqual([{t:590,value:9}]);
  expect(replay.accept({...next,lost:0,epoch:2,cursor:0,tail:0,rows:[]},"/joints",false).reset).toBe(true);
  expect(replay.accept({...next,lost:0,epoch:2,reset:1,cursor:0,tail:0,rows:[]},"/joints",false).reset).toBe(true);
});
it("resolves all dashboards and diagnostic inputs to one capture subscription per topic",()=>{
  const workspace=addMonitorDashboard(createDefaultMonitorWorkspace("/joints"),createMotionErrorDashboard());
  const {config,notice}=monitorCaptureConfig(workspace,[],"/joints",true,true);
  expect(Object.keys(config.topics).sort()).toEqual([ARM_ERROR_CONTROLLER_TOPIC,"/clock","/joints"].sort());
  expect(config.paused).toBe(true);expect(notice).toBe("");
  const unknown=monitorCaptureConfig(createDefaultMonitorWorkspace("/unknown"),[],"/joints",false,false);
  expect(unknown.config.topics).toEqual({});expect(unknown.notice).toContain("/unknown");
});
it("pause segments invalidate diagnostic pairing and historical age is not renewed on replay",()=>{
  const replay=new MonitorReplay();
  const data=(stamp:number)=>({header:{stamp:{sec:stamp,nanosec:0}},name:["joint1"],position:[1]});
  const controller={header:{stamp:{sec:1,nanosec:0}},joint_names:["joint1"],actual:{positions:[2]},desired:{positions:[3]}};
  const sample=page({cursor:2,tail:2,rows:[{sequence:1,segment:1,received_ms:10,topic:"/joints",data:data(1)},
    {sequence:2,segment:2,received_ms:20,topic:ARM_ERROR_CONTROLLER_TOPIC,data:controller}]});
  const batch=replay.accept(sample,"/joints",true);
  expect(batch.frames.some(f=>f.topic.endsWith("/feedback"))).toBe(false);
  expect(batch.status.controllerAt).toBe(520);expect(batch.status.stm32At).toBeNull();
});
it("bag history uses source stamps and backward stamps remove earlier diagnostic points",()=>{
  const replay=new MonitorReplay();
  const row=(sequence:number,sec:number)=>({sequence,segment:1,received_ms:sequence*10,topic:ARM_ERROR_CONTROLLER_TOPIC,data:{header:{stamp:{sec,nanosec:0}},joint_names:["joint1"],actual:{positions:[1]},desired:{positions:[2]}}});
  const sample=page({cursor:2,tail:2,config:{topics:{},paused:false,bag_playing:true},rows:[row(1,2),row(2,1)]});
  const batch=replay.accept(sample,"/joints",true);expect(batch.resetDiagnostics).toBe(true);
  expect(batch.frames.filter(f=>f.topic.endsWith("/tracking")).map(f=>f.at)).toEqual([1000]);
  let workspace=addMonitorDashboard(createDefaultMonitorWorkspace("/joints"),createMotionErrorDashboard());
  workspace=updateMonitorFromMessage(workspace,"monitor://motion-errors/tracking",{joint1:9},500);
  workspace=applyMonitorReplay(workspace,batch);
  expect(workspace.dashboards[1]!.panels[0]!.series.points).toEqual([{t:1000,value:1}]);
});
