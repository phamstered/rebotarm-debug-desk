import { panelSeries, updateMonitorFromMessages, type MonitorWorkspace } from "./monitorLogic";
import { ARM_ERROR_CONTROLLER_TOPIC, EMPTY_MOTION_ERROR_STATUS, MOTION_ERROR_PREFIX, MotionErrorSampler, clearMotionErrorPoints, hasMotionErrorPanels, type MotionErrorStatus } from "./motionErrorMonitorLogic";
import { resolveMonitorSampleTimeMs } from "./monitorTimeline";
import { VLA_CHUNK_MESSAGE_TYPE, VLA_CHUNK_TOPIC } from "./vlaLogic";
import type { MonitorHistoryPage, NativeMonitorConfig, TopicInfo } from "./types";

export function monitorCaptureConfig(workspace: MonitorWorkspace, discovered: TopicInfo[], jointTopic: string, paused: boolean, bag: boolean): {config: NativeMonitorConfig; notice: string} {
  const wanted = new Set(workspace.dashboards.flatMap(d => d.panels.flatMap(p => panelSeries(p).map(s => s.topic))).filter(t => !t.startsWith(MOTION_ERROR_PREFIX)));
  if (workspace.dashboards.some(hasMotionErrorPanels)) { wanted.add(jointTopic); wanted.add(ARM_ERROR_CONTROLLER_TOPIC); }
  if (bag) wanted.add("/clock");
  const known = new Map<string, string>([[jointTopic,"sensor_msgs/msg/JointState"],["/joint_states","sensor_msgs/msg/JointState"],
    [ARM_ERROR_CONTROLLER_TOPIC,"control_msgs/msg/JointTrajectoryControllerState"],[VLA_CHUNK_TOPIC,VLA_CHUNK_MESSAGE_TYPE],["/clock","rosgraph_msgs/msg/Clock"]]);
  for (const topic of discovered) if (topic.types.length === 1) known.set(topic.name, topic.types[0]!);
  const topics: Record<string,string> = {}, missing: string[] = [];
  for (const topic of [...wanted].sort()) {
    const type = known.get(topic);
    if (!type || ["sensor_msgs/msg/Image","sensor_msgs/msg/CompressedImage","sensor_msgs/msg/PointCloud2"].includes(type)) missing.push(topic);
    else topics[topic] = type;
  }
  return {config:{topics,paused,bag_playing:bag}, notice:missing.length ? `未采集：${missing.join("、")}（缺少唯一消息类型或不是数值流）` : ""};
}

type Frame = {topic:string;data:unknown;at:number};
export type MonitorReplayBatch = {frames:Frame[];reset:boolean;resetDiagnostics:boolean;status:MotionErrorStatus;bagClockMs:number|null;notice:string};

export function applyMonitorReplay(workspace: MonitorWorkspace, batch: MonitorReplayBatch): MonitorWorkspace {
  let next = batch.reset ? {...workspace,dashboards:workspace.dashboards.map(d=>({...d,panels:d.panels.map(p=>({...p,series:{...p.series,points:[]},additionalSeries:p.additionalSeries.map(s=>({...s,points:[]}))}))}))} : workspace;
  if(batch.resetDiagnostics)next=clearMotionErrorPoints(next);
  return updateMonitorFromMessages(next,batch.frames);
}

/** Separate from live telemetry: historical frames only update Monitor charts. */
export class MonitorReplay {
  private epoch=-1; private resetVersion=-1; private cursor=0; private segment=-1;
  private clock:number|null=null; private sampler=new MotionErrorSampler();
  private status:MotionErrorStatus={...EMPTY_MOTION_ERROR_STATUS};
  accept(page: MonitorHistoryPage, jointTopic: string, diagnostic: boolean): MonitorReplayBatch {
    if(this.epoch===page.epoch && this.resetVersion===page.reset && page.cursor<=this.cursor)
      return {frames:[],reset:false,resetDiagnostics:false,status:this.status,bagClockMs:this.clock,notice:""};
    const reset=this.epoch!==page.epoch || this.resetVersion!==page.reset || page.lost>0;
    if(reset){this.cursor=0;this.segment=-1;this.clock=null;this.sampler.reset();this.status={...EMPTY_MOTION_ERROR_STATUS};}
    this.epoch=page.epoch;this.resetVersion=page.reset;
    const frames:Frame[]=[];
    let resetDiagnostics=false;
    for(const row of page.rows){
      if(row.sequence<=this.cursor)continue;
      if(this.segment!==row.segment){this.sampler.reset();this.status={...EMPTY_MOTION_ERROR_STATUS};this.segment=row.segment;}
      const receivedAt=page.localOffset+row.received_ms;
      const time=resolveMonitorSampleTimeMs({bagPlaying:page.config.bag_playing,topic:row.topic,data:row.data,wallNowMs:receivedAt,bagClockMs:this.clock});
      this.clock=time.bagClockMs;
      frames.push({topic:row.topic,data:row.data,at:time.sampleMs});
      if(diagnostic){const update=this.sampler.accept(row.topic,row.data,receivedAt,jointTopic,page.config.bag_playing);
        if(update){this.status=update.status;if(update.reset){resetDiagnostics=true;for(let i=frames.length-1;i>=0;i--)if(frames[i]!.topic.startsWith(MOTION_ERROR_PREFIX))frames.splice(i,1);}for(const frame of update.frames)frames.push({topic:frame.topic,data:frame.data,at:page.config.bag_playing?frame.sourceTimeMs??time.sampleMs:time.sampleMs});}}
      this.cursor=row.sequence;
    }
    this.cursor=Math.max(this.cursor,page.cursor);
    return {frames,reset,resetDiagnostics,status:this.status,bagClockMs:this.clock,notice:page.lost>0?`历史缓冲已截断 ${page.lost} 帧，已从保留数据重建曲线` : page.skipped>0?`已跳过 ${page.skipped} 帧超限消息（单帧上限 64 KiB）`:""};
  }
}
