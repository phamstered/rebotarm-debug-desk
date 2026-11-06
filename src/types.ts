export type VisualPickPose = { position: [number,number,number]; orientation: [number,number,number,number] };
export type RgbTargetState = {
  target_id: string; object_id: number; sequence: number; generation: number;
  mode: "confirming" | "rgbd" | "rgb" | "uncertain";
  identity_valid: boolean; metric_ready: boolean; plane_verified: boolean;
  confidence: number; age_ms: number; camera_z_m: number; depth_valid_fraction: number;
  geometry_source: string; message: string; source_frame: string; target_frame: string; stamp_ns: number;
  roi: [number,number,number,number]; box: ObjectBox;
};
export type VisualPickPreview = { tracking?: RgbTargetState | null; subscription_id: string; object_id: number; frame_seq: number; calibrated: boolean; execution_ready: boolean; grasp: VisualPickPose; pregrasp: VisualPickPose; opening_m: number; message: string };
export type VisualPickState = { command_id: string; phase: string; message: string; busy: boolean };
export type ObjectBox = { id: number; center: [number, number, number]; size: [number, number, number]; point_count: number };
export type ObjectDetectionFrame = { status: "ok" | "empty" | "no_table" | "error"; message: string; frame_seq: number; items: ObjectBox[] };

export type ConnectionProfile = {
  id: string;
  name: string;
  host: string;
  sshPort: number;
  username: string;
  identityFile: string;
  localPort: number;
  remotePort: number;
  rosDomainId: number;
  rosSetupScript: string;
  urdfTopic: string;
  jointStateTopic: string;
  commandTopic: string;
  statusTopic: string;
  /** TCP link；留空时优先稳定工具坐标系，避免选到可动手指。 */
  tcpLink: string;
  /** Robot View RGBD 默认 Topic / TF（可覆盖）。 */
  rgbdRgbTopic: string;
  rgbdDepthTopic: string;
  rgbdCameraInfoTopic: string;
  rgbdTargetFrame: string;
  rgbdMaxWidth: number;
  rgbdMaxHeight: number;
  rgbdMaxFps: number;
  rgbdEnabled: boolean;
};

export type TopicInfo = {
  name: string;
  types: string[];
};

export type RosGraphNode = {
  id: string;
  label: string;
  kind: "node" | "topic";
  types: string[];
};

export type RosGraphEdge = {
  source: string;
  target: string;
  relation: "publish" | "subscribe";
};

export type RosGraph = {
  nodes: RosGraphNode[];
  edges: RosGraphEdge[];
};

export type TopicEndpointInfo = {
  node_name: string;
  node_namespace: string;
  topic_type: string;
  endpoint_type: "PUBLISHER" | "SUBSCRIPTION";
  gid: string;
  qos: {
    reliability: string;
    history: string;
    depth: number;
    durability: string;
    lifespan: string;
    deadline: string;
    liveliness: string;
    liveliness_lease_duration: string;
  };
};

export type TopicDetails = {
  name: string;
  types: string[];
  publishers: TopicEndpointInfo[];
  subscriptions: TopicEndpointInfo[];
};

export type NodeDetails = {
  name: string;
  namespace: string;
  publishers: TopicInfo[];
  subscriptions: TopicInfo[];
  services: TopicInfo[];
  clients: TopicInfo[];
};

export type AgentServiceStatus = {
  loadState: string;
  activeState: string;
  subState: string;
  result: string;
  mainPid: number;
  unitFileState: string;
  description: string;
};

export type ControllerInfo = {
  name: string;
  typeName: string;
  state: string;
};

export type RosControlStatus = {
  supported?: boolean;
  fresh?: boolean;
  hasSnapshot?: boolean;
  snapshotSequence?: number;
  snapshotAgeMs?: number;
  snapshotTimeMs?: number;
  queryState?: import("./controllersInfoLogic").ControllerQueryState;
  queryPending?: boolean;
  retryAfterMs?: number;
  requestWaitMs?: number;
  manager: string;
  available: boolean;
  controllers: ControllerInfo[];
  message: string;
};

export type RosbagStatus = {
  recording: boolean;
  pid: number;
  outputPath: string;
  message: string;
};

export type RosbagPlayStatus = {
  playing: boolean;
  pid: number;
  bagPath: string;
  message: string;
};

export type TrajectoryPoint = {
  positions: number[];
  velocities?: number[];
  /** 相对轨迹起点的时间，单位秒，必须严格递增。 */
  time_from_start: number;
};

export type TcpPose = { frame_id: string; tcp_link: string; position: [number, number, number]; orientation: [number, number, number, number] };

export type ClockSyncInfo = {
  supported: boolean;
  state: "waiting" | "synchronized" | "unsynchronized" | "stale";
  message: string;
  source_topic: string;
  /** Source stamp minus Jetson ROS time at receipt; positive means ahead. */
  source_offset_ms?: number;
  feedback_age_ms?: number;
  generation: number;
  firmware?: { supported: boolean; synchronized?: boolean; sync_age_ms?: number; failure_count?: number; last_sync_duration_ms?: number };
};

export type MotionHoldFailure = {
  reason: "position_drift" | "velocity_timeout";
  phase: "holding" | "paused";
  capturedAtMs: number;
  feedbackAgeMs: number;
  samples: MotionArrivalError[];
  stableForMs?: number;
  requiredStableMs?: number;
};
export type MotionHoldFailureEnvelope = {
  reason: MotionHoldFailure["reason"];
  phase: MotionHoldFailure["phase"];
  captured_at_ms: number;
  feedback_age_ms: number;
  samples: MotionArrivalError[];
  stable_for_ms?: number;
  required_stable_ms?: number;
};

export type MotionArrivalError = {
  joint_name: string;
  target: number;
  actual: number;
  position_error: number;
  position_tolerance: number;
  velocity: number;
  velocity_tolerance: number;
  unit: "rad" | "m";
};

export type BridgeEnvelope = {
  controllers_info_supported?: boolean;
  refresh?: boolean;
  manager?: string;
  fresh?: boolean;
  has_snapshot?: boolean;
  snapshot_sequence?: number;
  snapshot_age_ms?: number;
  snapshot_time_ms?: number;
  query_state?: import("./controllersInfoLogic").ControllerQueryState;
  query_pending?: boolean;
  retry_after_ms?: number;
  request_wait_ms?: number;
  controllers?: Array<{name:string; type_name:string; state:string}>;
  subscription_id?: string;
  frame_age_ms?: number;
  rgbd_subscription_id_supported?: boolean;
  object_detection_supported?: boolean;
  visual_pick_supported?: boolean;
  rgb_target_tracking_supported?: boolean;
  tracking?: RgbTargetState | null;
  target_id?: string;
  target_rgb_payload?: Uint8Array;
  grasp?: VisualPickPose;
  pregrasp?: VisualPickPose;
  object_id?: number;
  frame_seq?: number;
  calibrated?: boolean;
  execution_ready?: boolean;
  opening_m?: number;
  pick_phase?: string;
  preview_frame_seq?: number;
  objects?: ObjectDetectionFrame;
  supported?: boolean;
  state?: ClockSyncInfo["state"];
  source_topic?: string;
  source_offset_ms?: number;
  feedback_age_ms?: number;
  generation?: number;
  firmware?: ClockSyncInfo["firmware"];
  op: string;
  request_id?: string;
  topic?: string;
  node?: string;
  type?: string;
  /** ROS message content: scalars for legacy built-ins, structured fields for runtime-decoded types. */
  data?: unknown;
  topics?: TopicInfo[];
  nodes?: RosGraphNode[];
  edges?: RosGraphEdge[];
  topic_info?: TopicDetails;
  node_info?: NodeDetails;
  message?: string;
  uri?: string;
  mime?: string;
  base64?: string;
  encoding?: "binary" | "base64";
  resource_bytes?: Uint8Array;
  data_length?: number;
  mode?: number;
  /** Scalar (legacy joint1) or per-joint positions matching Bridge array index. */
  position?: number | number[];
  velocity?: number;
  kp?: number;
  kd?: number;
  effort?: number;
  /** Bitmask of joints the UI wants to command; Bridge requires full firmware coverage. */
  active_joint_mask?: number;
  confirmation?: string;
  sequence?: number;
  joint_names?: string[];
  trajectory_points?: TrajectoryPoint[];
  joints?: number;
  points?: number;
  /** MoveIt saved-position protocol. */
  command_id?: string;
  label?: string;
  home?: boolean;
  positions?: number[];
  home_positions?: number[];
  gripper_supported?: boolean;
  gripper_available?: boolean;
  gripper_message?: string;
  gripper_joint_name?: string;
  gripper_lower?: number;
  gripper_upper?: number;
  gripper_position?: number;
  gripper_feedback_fresh?: boolean;
  gripper_feedback_age_ms?: number;
  tcp_pose_supported?: boolean;
  tcp_pose?: TcpPose;
  joint_rotation_supported?: boolean;
  joint_targets_supported?: boolean;
  motion_duration_supported?: boolean;
  motion_duration_message?: string;
  motion_group_supported?: boolean;
  group_id?: string;
  preparation_duration_s?: number;
  steps?: Array<{ id: string; label: string; positions: number[]; gripper_position?: number; motion_duration_s: number; hold_duration_s: number; captures?: Array<{ id: string; label: string; type: "camera_capture"; topic: string; timeout_s: number }> }>;
  group_index?: number;
  group_count?: number;
  group_phase?: "preparing" | "moving" | "holding" | "paused";
  group_elapsed_s?: number;
  group_step_label?: string;
  arrival_errors?: MotionArrivalError[];
  hold_failure?: MotionHoldFailureEnvelope;
  position_error_check_enforced?: boolean;
  joint_targets?: Record<string, number>;
  motion_log_session?: string;
  motion_log_after?: number;
  motion_log_cursor?: number;
  motion_log_truncated?: boolean;
  motion_logs?: MotionLogEntry[];
  motion_duration_s?: number;
  recommended_duration_s?: number;
  joint_name?: string;
  joint_position?: number;
  available?: boolean;
  busy?: boolean;
  motion_capture_supported?: boolean;
  capture_result?: { id: string; name: string; path: string; image_stamp: number; joint_stamp: number; thumbnail?: string };
  /** Present on Bridge `hello` replies. */
  bridge_version?: string;
  bridge_build_id?: string;
  ros_distro?: string;
  /** GravityIdentification Bridge ops (stack PR #23). */
  joint_mask?: number;
  pose_set_id?: string[];
  settle_time_s?: number;
  capture_window_s?: number;
  write_yaml?: boolean;
  hot_reload?: boolean;
  output_yaml_path?: string;
  max_effort_nm?: number;
  max_velocity_rad_s?: number;
  command_timeout_ms?: number;
  lock_gripper?: boolean;
  phase?: number;
  motion_phase?: string;
  pose_index?: number;
  pose_count?: number;
  residual_nm?: number[];
  measured_effort_nm?: number[];
  model_effort_nm?: number[];
  rmse_running?: number;
  fault_code?: number;
  success?: boolean;
  gravity_scales?: number[];
  torque_biases_nm?: number[];
  rmse_per_joint?: number[];
  rmse_total?: number;
  yaml_path?: string;
  status?: string;
  accepted?: boolean;
  code?: number;
  /** RGBD binary frame fields (op=rgbd_frame). */
  rgb_topic?: string;
  depth_topic?: string;
  camera_info_topic?: string;
  target_frame?: string;
  source_frame?: string;
  stamp_diff_ns?: number;
  tf_ok?: boolean;
  tf_error?: string;
  /** Non-TF RGBD failure (resolution/encoding); prefer over tf_error when set. */
  error?: string;
  rgb?: unknown;
  depth?: unknown;
  camera_info?: unknown;
  pose?: unknown;
  rgbd_payload?: Uint8Array;
  max_width?: number;
  max_height?: number;
  max_fps?: number;
};



export type HardwareStatus = {
  last_command_sequence?: number;
  mode?: number;
  mode_name?: string;
  active_joint_mask?: number;
  active_joints?: number[];
  fault_code?: number;
};

export const defaultProfile: ConnectionProfile = {
  id: crypto.randomUUID(),
  name: "jetson",
  host: "jetson",
  sshPort: 22,
  username: "",
  identityFile: "",
  localPort: 18765,
  remotePort: 8765,
  rosDomainId: 0,
  rosSetupScript: "Project/rebotarm-ros2-stack/install/setup.bash",
  urdfTopic: "/robot_description",
  jointStateTopic: "/stm32/joint_states",
  commandTopic: "/stm32/joint_commands",
  statusTopic: "/stm32/status",
  tcpLink: "",
  rgbdRgbTopic: "/cameras/left_arm/wrist/color/image_raw",
  rgbdDepthTopic: "/cameras/left_arm/wrist/aligned_depth_to_color/image_raw",
  rgbdCameraInfoTopic: "/cameras/left_arm/wrist/color/camera_info",
  rgbdTargetFrame: "base_link",
  rgbdMaxWidth: 320,
  rgbdMaxHeight: 240,
  rgbdMaxFps: 12,
  rgbdEnabled: true,
};

export type UsbProbeStatus = {
  mcuPresent: boolean;
  mcuVidPid: string;
  serialPath?: string;
  realsensePresent: boolean;
  realsenseLines: string[];
  rawLsusb: string;
  error?: string;
};

export type ArmModeKind = "teleop" | "trajectory" | "teaching" | "realsense" | "idle" | "unknown";

export type ArmModeStatus = {
  mode: ArmModeKind;
  teleopRunning: boolean;
  trajectoryRunning: boolean;
  teachingRunning?: boolean;
  teachingPid?: number;
  realsenseRunning: boolean;
  teleopPid: number;
  trajectoryPid: number;
  realsensePid: number;
  /** True when Desk teleop pid owns ros2_control (child launch or log). Null = unknown while running. */
  teleopOwnsRos2Control: boolean | null;
  /** True when Desk trajectory pid owns ros2_control. Null = unknown while running. */
  trajectoryOwnsRos2Control: boolean | null;
  message: string;
};

export type RemoteActionResult = {
  ok: boolean;
  exitCode: number;
  message: string;
  detail: string;
};

export type ControlLogSource = "teaching" | "teleop" | "trajectory" | "vla" | "moveit" | "controller" | "realsense";
export type ControlLogSnapshot = {
  source: ControlLogSource;
  path: string;
  exists: boolean;
  content: string;
  truncated: boolean;
  sizeBytes: number;
  revision: string;
};

/** Bridge audit entries use wall-clock milliseconds and per-process monotonic IDs. */
export type MotionLogEntry = {
  seq: number; timestamp_ms: number; command_id: string; phase: string;
  level: "info" | "warn" | "error"; message: string;
};
