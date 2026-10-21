import type { TopicSample } from "./appLogic";
import { extractMessageTimeMs, parseRosTime } from "./monitorTimeline";
import type { HardwareStatus } from "./types";

export type CollectionConfig = {
  repoId: string;
  root: string;
  task: string;
  fps: number;
  wristImageTopic: string;
  baseImageTopic: string;
  stateTopic: string;
  armCommandTopic: string;
  gripperCommandTopic: string;
  pythonPath: string;
  resume: boolean;
};

export type CollectionAction = "status" | "launch" | "start_episode" | "save_episode" | "discard_episode" | "finish";
export type CollectionStatus = {
  state: "stopped" | "starting" | "idle" | "recording" | "finalizing";
  managed: boolean;
  pid: number;
  recording: boolean;
  pendingFrames: number;
  savedEpisodes: number;
  fps: number;
  task: string;
  repoId: string;
  root: string;
  message: string;
  log: string;
};

export const COLLECTION_STORAGE_KEY = "robot-console-data-collection";
/** Wall-clock age beyond which joint-state samples are treated as stale for Episode start. */
export const COLLECTION_JOINT_STALE_MS = 2000;

export const defaultCollectionConfig: CollectionConfig = {
  repoId: "", root: "lerobot_datasets/rebotarm_dataset", task: "", fps: 20,
  wristImageTopic: "/camera/camera/color/image_raw", baseImageTopic: "",
  stateTopic: "/joint_states", armCommandTopic: "/arm_teleop_controller/commands",
  gripperCommandTopic: "/gripper_teleop_controller/commands", pythonPath: "venvs/lerobot/bin/python", resume: false,
};

export function validCollectionPath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && /^[A-Za-z0-9/._-]+$/.test(path) &&
    path.replace(/^\//, "").split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith("-"));
}

export function collectionConfigError(config: CollectionConfig): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.repoId) || config.repoId.length > 255) return "数据集 ID 需为 namespace/dataset 格式";
  if (!validCollectionPath(config.root)) return "Jetson 保存目录需为绝对路径或相对用户主目录的路径，不支持空格、~ 或 ..";
  if (!config.task.trim() || config.task.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(config.task)) return "请填写 1–2000 字符的任务描述";
  if (!Number.isInteger(config.fps) || config.fps < 1 || config.fps > 120) return "采样频率需为 1–120 的整数";
  if (!validCollectionPath(config.pythonPath)) return "Python 路径格式无效";
  for (const topic of [config.wristImageTopic, config.stateTopic, config.armCommandTopic, config.gripperCommandTopic, ...(config.baseImageTopic ? [config.baseImageTopic] : [])]) {
    if (topic.length > 255 || !/^\/(?:[A-Za-z_][A-Za-z0-9_]*)(?:\/[A-Za-z_][A-Za-z0-9_]*)*$/.test(topic)) return "Topic 需为完整 ROS 名称（以 / 开头）";
  }
  return "";
}

export function loadCollectionConfig(storage: Pick<Storage, "getItem"> = localStorage): CollectionConfig {
  try {
    const value = JSON.parse(storage.getItem(COLLECTION_STORAGE_KEY) ?? "null");
    const next = { ...defaultCollectionConfig };
    if (!value || typeof value !== "object") return next;
    for (const key of Object.keys(next) as Array<keyof CollectionConfig>) {
      if (typeof value[key] === typeof next[key]) Object.assign(next, { [key]: value[key] });
    }
    return next;
  } catch { return { ...defaultCollectionConfig }; }
}

/** TRACK is mode === 1; fall back to mode_name when mode is absent. */
export function collectionIsTrackMode(hardwareStatus: HardwareStatus): boolean {
  if (typeof hardwareStatus.mode === "number") return hardwareStatus.mode === 1;
  return hardwareStatus.mode_name === "TRACK";
}

/**
 * Arm is ready for demos only in TRACK with an explicit fault_code === 0.
 * Missing status, unknown fault, HOLD, or any non-zero fault blocks start.
 */
export function collectionArmReady(hardwareStatus: HardwareStatus | null): boolean {
  if (!hardwareStatus) return false;
  if (hardwareStatus.fault_code !== 0) return false;
  return collectionIsTrackMode(hardwareStatus);
}

function jointHeaderStamp(data: unknown) {
  if (!data || typeof data !== "object") return undefined;
  const header = (data as Record<string, unknown>).header;
  if (!header || typeof header !== "object") return undefined;
  return parseRosTime((header as Record<string, unknown>).stamp);
}

/**
 * Joint-state stamps are only meaningful when the micro-ROS Agent epoch is up;
 * otherwise firmware publishes all-zero stamps. Also require a fresh wall-clock sample.
 */
export function collectionStampOk(
  sample: Pick<TopicSample, "data" | "lastAt"> | null | undefined,
  nowMs: number,
  maxAgeMs = COLLECTION_JOINT_STALE_MS,
): boolean {
  if (!sample) return false;
  if (!Number.isFinite(nowMs) || !Number.isFinite(sample.lastAt)) return false;
  if (nowMs - sample.lastAt > maxAgeMs) return false;
  const stamp = jointHeaderStamp(sample.data);
  if (!stamp) {
    // No header.stamp — still try top-level / clock-shaped stamps via shared extractor.
    const ms = extractMessageTimeMs(sample.data);
    if (ms === undefined || ms === 0) return false;
    return true;
  }
  if (stamp.sec === 0 && stamp.nanosec === 0) return false;
  return true;
}

export type CollectionPreflightInput = {
  hardwareStatus: HardwareStatus | null;
  jointStateSample?: Pick<TopicSample, "data" | "lastAt"> | null;
  rosReady: boolean;
  nowMs?: number;
  maxAgeMs?: number;
};

/** Chinese reason when Episode start should be blocked by arm/stamp/ROS gates; empty when clear. */
export function collectionStartBlockedReason(input: CollectionPreflightInput): string {
  const { hardwareStatus, jointStateSample, rosReady, nowMs = Date.now(), maxAgeMs } = input;
  if (!rosReady) return "等待 JointState（ROS 就绪）后可开始 Episode。";
  if (!hardwareStatus) return "等待 /stm32/status（机械臂状态）后再开始 Episode。";
  if (hardwareStatus.fault_code == null || !Number.isFinite(hardwareStatus.fault_code)) {
    return "机械臂 fault_code 未知，不能开始 Episode。";
  }
  if (hardwareStatus.fault_code !== 0) {
    if (hardwareStatus.fault_code === 11) {
      return "机械臂故障码 11（指令中断锁存 / COMMAND_LOSS_LATCHED），不能开始 Episode；需重启 STM32。";
    }
    return `机械臂故障码 ${hardwareStatus.fault_code}，不能开始 Episode。`;
  }
  if (!collectionIsTrackMode(hardwareStatus)) {
    const label = hardwareStatus.mode_name?.trim()
      || (typeof hardwareStatus.mode === "number" ? `mode ${hardwareStatus.mode}` : "未知");
    if (hardwareStatus.mode === 0 || hardwareStatus.mode_name === "HOLD") {
      return "机械臂处于 HOLD（effort=0 / 无重力补偿），示范质量差，请切换到 TRACK 后再开始 Episode。";
    }
    return `机械臂模式为 ${label}（需要 TRACK），不能开始 Episode。`;
  }
  if (!collectionStampOk(jointStateSample, nowMs, maxAgeMs)) {
    if (!jointStateSample) return "未收到关节状态采样，不能开始 Episode。";
    if (nowMs - jointStateSample.lastAt > (maxAgeMs ?? COLLECTION_JOINT_STALE_MS)) {
      return "关节状态过期（长时间未更新），不能开始 Episode。";
    }
    const stamp = jointHeaderStamp(jointStateSample.data);
    if (stamp && stamp.sec === 0 && stamp.nanosec === 0) {
      return "关节状态时间戳为全 0（需 micro-ROS Agent epoch），对齐不可靠，不能开始 Episode。";
    }
    return "关节状态时间戳无效或缺失，不能开始 Episode。";
  }
  return "";
}

/** Mid-recording hazard when arm leaves TRACK or latches a fault; empty when still healthy. */
export function collectionRecordingHazardReason(hardwareStatus: HardwareStatus | null): string {
  if (!hardwareStatus) return "采集中未收到 /stm32/status，建议确认机械臂状态；异常时请丢弃本 Episode。";
  if (hardwareStatus.fault_code == null || !Number.isFinite(hardwareStatus.fault_code)) {
    return "采集中 fault_code 未知，建议丢弃本 Episode。";
  }
  if (hardwareStatus.fault_code !== 0) {
    if (hardwareStatus.fault_code === 11) {
      return "采集中出现故障码 11（指令中断锁存），建议丢弃本 Episode。";
    }
    return `采集中出现故障码 ${hardwareStatus.fault_code}，建议丢弃本 Episode。`;
  }
  if (!collectionIsTrackMode(hardwareStatus)) {
    const label = hardwareStatus.mode_name?.trim()
      || (typeof hardwareStatus.mode === "number" ? `mode ${hardwareStatus.mode}` : "未知");
    return `采集中机械臂离开 TRACK（当前 ${label}），建议丢弃本 Episode。`;
  }
  return "";
}

export function collectionActions(
  status: CollectionStatus | null,
  fresh: boolean,
  rosReady: boolean,
  armReady = true,
  stampOk = true,
  faultCode?: number | null,
) {
  const ready = fresh && Boolean(status);
  const idle = ready && status?.state === "idle";
  const fault11 = faultCode === 11;
  return {
    launch: ready && status?.state === "stopped" && !fault11,
    start: idle && !status?.pendingFrames && rosReady && armReady && stampOk,
    save: ready && (status?.state === "recording" || idle) && Boolean(status?.pendingFrames),
    discard: ready && (status?.state === "recording" || (idle && Boolean(status?.pendingFrames))),
    finish: idle && status?.managed && !status?.pendingFrames,
  };
}

export const COLLECTION_FAULT11_HINT = "需先安全回零/托住，再重启 STM32（无软恢复）";

export const collectionStateLabels: Record<CollectionStatus["state"], string> = {
  stopped: "未启动", starting: "启动中", idle: "待采集", recording: "正在采集", finalizing: "正在完成数据集",
};
