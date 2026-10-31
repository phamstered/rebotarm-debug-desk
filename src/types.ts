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

export type BridgeEnvelope = {
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
  available?: boolean;
  busy?: boolean;
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

export type ArmModeKind = "teleop" | "trajectory" | "realsense" | "idle" | "unknown";

export type ArmModeStatus = {
  mode: ArmModeKind;
  teleopRunning: boolean;
  trajectoryRunning: boolean;
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

export type ControlLogSource = "teleop" | "trajectory" | "vla" | "controller" | "realsense";
export type ControlLogSnapshot = {
  source: ControlLogSource;
  path: string;
  exists: boolean;
  content: string;
  truncated: boolean;
  sizeBytes: number;
  revision: string;
};
