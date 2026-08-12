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
};

export type TopicInfo = {
  name: string;
  types: string[];
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

export type BridgeEnvelope = {
  op: string;
  request_id?: string;
  topic?: string;
  type?: string;
  data?: unknown;
  topics?: TopicInfo[];
  message?: string;
  uri?: string;
  mime?: string;
  base64?: string;
  mode?: number;
  position?: number;
  velocity?: number;
  kp?: number;
  kd?: number;
  effort?: number;
  confirmation?: string;
  sequence?: number;
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
  name: "damiao",
  host: "damiao",
  sshPort: 22,
  username: "",
  identityFile: "",
  localPort: 18765,
  remotePort: 8765,
  rosDomainId: 0,
  rosSetupScript: "/home/jialiang/Project/leader_follower/install/setup.bash",
  urdfTopic: "/robot_description",
  jointStateTopic: "/stm32/joint_states",
  commandTopic: "/stm32/joint_commands",
  statusTopic: "/stm32/status",
};
