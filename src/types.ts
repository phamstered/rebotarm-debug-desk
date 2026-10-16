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
  /** TCP（夹爪）link 名称；留空时按命名特征和运动链深度自动挑选。 */
  tcpLink: string;
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
  /** Present on Bridge `hello` replies. */
  bridge_version?: string;
  bridge_build_id?: string;
  ros_distro?: string;
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
  rosSetupScript: "leader_follower/install/setup.bash",
  urdfTopic: "/robot_description",
  jointStateTopic: "/stm32/joint_states",
  commandTopic: "/stm32/joint_commands",
  statusTopic: "/stm32/status",
  tcpLink: "",
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
  message: string;
};

export type RemoteActionResult = {
  ok: boolean;
  exitCode: number;
  message: string;
  detail: string;
};
