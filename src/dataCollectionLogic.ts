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

export function collectionActions(
  status: CollectionStatus | null,
  fresh: boolean,
  rosReady: boolean,
  options?: { faultCode?: number | null },
) {
  const ready = fresh && Boolean(status);
  const idle = ready && status?.state === "idle";
  const fault11 = options?.faultCode === 11;
  return {
    launch: ready && status?.state === "stopped" && !fault11,
    start: idle && !status?.pendingFrames && rosReady && !fault11,
    save: ready && (status?.state === "recording" || idle) && Boolean(status?.pendingFrames),
    discard: ready && (status?.state === "recording" || (idle && Boolean(status?.pendingFrames))),
    finish: idle && status?.managed && !status?.pendingFrames,
  };
}

export const COLLECTION_FAULT11_HINT = "需先安全回零/托住，再重启 STM32（无软恢复）";

export const collectionStateLabels: Record<CollectionStatus["state"], string> = {
  stopped: "未启动", starting: "启动中", idle: "待采集", recording: "正在采集", finalizing: "正在完成数据集",
};
