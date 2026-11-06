import { createSeries } from "./dataGraphLogic";
import { createPanelFromSeries, newDashboardId, newPanelId, panelSeries, type MonitorDashboard, type MonitorWorkspace } from "./monitorLogic";

export const ARM_ERROR_CONTROLLER_TOPIC = "/arm_trajectory_controller/controller_state";
export const MOTION_ERROR_PREFIX = "monitor://motion-errors/";
export const MOTION_ERROR_MAX_AGE_MS = 1000;
const JOINTS = Array.from({ length: 6 }, (_, i) => `joint${i + 1}`);
const topicFor = (kind: string) => `${MOTION_ERROR_PREFIX}${kind}`;

export function hasMotionErrorPanels(dashboard: MonitorDashboard): boolean {
  return dashboard.panels.some(panel => panelSeries(panel).some(series => series.topic.startsWith(MOTION_ERROR_PREFIX)));
}

export function createMotionErrorDashboard(): MonitorDashboard {
  const specs = [
    { kind: "tracking", title: "轨迹跟踪误差 · desired − actual (rad)", fields: JOINTS },
    { kind: "feedback", title: "反馈差值 · JTC actual − STM32 (rad)", fields: JOINTS },
    { kind: "timing", title: "采样时间差 · JTC − STM32 (ms)", fields: ["header_stamp_ms", "receive_time_ms"] },
  ];
  return {
    id: newDashboardId(), name: "运动误差",
    panels: specs.map((spec, index) => {
      const id = newPanelId();
      const series = spec.fields.map((field, i) => createSeries(topicFor(spec.kind), field, i));
      return { ...createPanelFromSeries(series[0]!, { i: id, x: index === 1 ? 6 : 0, y: index === 2 ? 3 : 0, w: index === 2 ? 12 : 6, h: 3 }),
        title: spec.title, additionalSeries: series.slice(1),
        // Dots do not interpolate through missing/invalid observations.
        chart: { type: "time-series", timeStyle: "points", barOrientation: "vertical", gaugeMin: -0.02, gaugeMax: 0.02, gaugeThreshold: 0.02 },
      };
    }),
  };
}

export function clearMotionErrorPoints(workspace: MonitorWorkspace): MonitorWorkspace {
  return { ...workspace, dashboards: workspace.dashboards.map(dashboard => ({ ...dashboard, panels: dashboard.panels.map(panel => {
    const clear = (series: typeof panel.series) => series.topic.startsWith(MOTION_ERROR_PREFIX) ? { ...series, points: [] } : series;
    return { ...panel, series: clear(panel.series), additionalSeries: panel.additionalSeries.map(clear) };
  }) })) };
}

type Positions = Partial<Record<string, number>>;
type Sample = { stamp: number | null; receivedAt: number; positions: Positions; desired: Positions };
export type MotionErrorStatus = {
  controllerAt: number | null; stm32At: number | null;
  tracking: string; feedback: string;
};
export const EMPTY_MOTION_ERROR_STATUS: MotionErrorStatus = {
  controllerAt: null, stm32At: null, tracking: "等待控制器反馈", feedback: "等待两路有效反馈",
};
export type MotionErrorUpdate = {
  frames: { topic: string; data: Positions; sourceTimeMs: number | null }[];
  status: MotionErrorStatus;
  reset: boolean;
};

function record(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
}
function stampMs(data: Record<string, unknown>): number | null {
  const stamp = record(record(data.header).stamp);
  const { sec, nanosec } = stamp;
  return typeof sec === "number" && Number.isInteger(sec) && sec >= 0
    && typeof nanosec === "number" && Number.isInteger(nanosec) && nanosec >= 0 && nanosec < 1e9
    && (sec > 0 || nanosec > 0) ? sec * 1000 + nanosec / 1e6 : null;
}
function positions(names: unknown, values: unknown): Positions {
  if (!Array.isArray(names) || !names.every(name => typeof name === "string") || new Set(names).size !== names.length
    || !Array.isArray(values) || values.length !== names.length) return {};
  const result: Positions = {};
  JOINTS.forEach(joint => {
    const value = values[names.indexOf(joint)];
    if (typeof value === "number" && Number.isFinite(value)) result[joint] = value;
  });
  return result;
}
function controllerPositions(data: Record<string, unknown>, legacy: string, modern: string): unknown {
  const old = record(data[legacy]).positions;
  return Array.isArray(old) && old.length > 0 ? old : record(data[modern]).positions;
}
function difference(a: Positions, b: Positions): Positions {
  const result: Positions = {};
  JOINTS.forEach(joint => {
    if (a[joint] != null && b[joint] != null) {
      const value = a[joint]! - b[joint]!;
      if (Number.isFinite(value)) result[joint] = value;
    }
  });
  return result;
}
function coverage(values: Positions): string {
  const missing = JOINTS.filter(joint => values[joint] == null);
  return missing.length ? `缺少有效数据：${missing.join("、")}` : "六轴数据有效";
}

/** Desktop diagnostic samples only. No interpolation, no control decisions or ROS writes. */
export class MotionErrorSampler {
  private controller: Sample | null = null;
  private stm32: Sample | null = null;
  private context = "";
  private status: MotionErrorStatus = { ...EMPTY_MOTION_ERROR_STATUS };

  reset() {
    this.controller = null; this.stm32 = null; this.context = "";
    this.status = { ...EMPTY_MOTION_ERROR_STATUS };
  }

  accept(topic: string, data: unknown, receivedAt: number, jointStateTopic: string, bagPlaying: boolean): MotionErrorUpdate | null {
    if (topic !== ARM_ERROR_CONTROLLER_TOPIC && topic !== jointStateTopic) return null;
    if (!Number.isFinite(receivedAt)) return null;
    const context = `${jointStateTopic}:${bagPlaying}`;
    let reset = this.context !== "" && this.context !== context;
    if (reset) this.reset();
    this.context = context;
    const controller = topic === ARM_ERROR_CONTROLLER_TOPIC;
    const raw = record(data);
    const stamp = stampMs(raw);
    const previous = controller ? this.controller : this.stm32;
    // A backward source clock starts a new diagnostic epoch; never compare across it.
    if (stamp != null && previous?.stamp != null && stamp < previous.stamp) {
      this.reset(); this.context = context; reset = true;
    } else if (stamp != null && previous?.stamp === stamp) {
      // Repeated source samples must not renew freshness or produce fake measurements.
      return { frames: [], status: this.status, reset };
    }
    const sample: Sample = { stamp, receivedAt,
      positions: positions(controller ? raw.joint_names : raw.name, controller ? controllerPositions(raw, "actual", "feedback") : raw.position),
      desired: controller ? positions(raw.joint_names, controllerPositions(raw, "desired", "reference")) : {},
    };
    if (controller) this.controller = sample; else this.stm32 = sample;
    const frames: MotionErrorUpdate["frames"] = [];
    if (controller) {
      const values = difference(sample.desired, sample.positions);
      frames.push({ topic: topicFor("tracking"), data: values, sourceTimeMs: sample.stamp });
      this.status = { ...this.status, tracking: coverage(values) };
    }
    const a = this.controller, b = this.stm32;
    let feedback = "等待两路有效反馈";
    if (a && b) {
      if (receivedAt - a.receivedAt >= MOTION_ERROR_MAX_AGE_MS || receivedAt - b.receivedAt >= MOTION_ERROR_MAX_AGE_MS
        || receivedAt < a.receivedAt || receivedAt < b.receivedAt) feedback = "反馈已过期，停止差值采样";
      else if (a.stamp == null || b.stamp == null) feedback = "源时间戳无效，停止差值采样";
      else {
        const skew = a.stamp - b.stamp;
        frames.push({ topic: topicFor("timing"), data: { header_stamp_ms: skew, receive_time_ms: a.receivedAt - b.receivedAt }, sourceTimeMs: Math.max(a.stamp, b.stamp) });
        if (Math.abs(skew) >= MOTION_ERROR_MAX_AGE_MS) feedback = "源时间差 ≥ 1 s，停止差值采样";
        else {
          const values = difference(a.positions, b.positions);
          frames.push({ topic: topicFor("feedback"), data: values, sourceTimeMs: Math.max(a.stamp, b.stamp) });
          feedback = `${coverage(values)}；最新采样，未对齐`;
        }
      }
    }
    this.status = { ...this.status, controllerAt: a?.receivedAt ?? null, stm32At: b?.receivedAt ?? null, feedback };
    return { frames, status: this.status, reset };
  }
}
