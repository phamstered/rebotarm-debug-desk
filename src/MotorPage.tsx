import { NativePageActions } from "./NativePageActions";
import type { BridgeClient } from "./bridge";
import { MotorControl } from "./MotorControl";
import type { HardwareStatus } from "./types";

type JointState = { name?: string[]; position?: number[]; velocity?: number[]; effort?: number[] };

export function MotorPage({
  bridge,
  jointState,
  urdfXml = "",
  status,
  commandTopic,
  statusTopic,
  onStreamingChange,
  controlLocked = false,
  active = true,
  controlLockedReason = "",
}: {
  bridge: BridgeClient;
  jointState: JointState | null;
  urdfXml?: string;
  status: HardwareStatus | null;
  commandTopic: string;
  statusTopic?: string;
  onStreamingChange(streaming: boolean): void;
  controlLocked?: boolean;
  active?: boolean;
  controlLockedReason?: string;
}) {
  return (
    <main className="motor-page">
      <header className="motor-page-header native-window-header">
        <div>
          <h1>Motor Control</h1>
          <span>MIT / POS_VEL 逐轴控制</span>
        </div>
        <div className="motor-page-topic">
          <span>COMMAND TOPIC</span>
          <strong>{commandTopic}</strong>
        </div>
        <NativePageActions />
      </header>
      <div className="motor-page-safety" role="note">
        <strong>发送前确认现场安全</strong>
        <span>核对所选关节与现场支撑；停止或离开页面会请求关闭输出，结果以新鲜固件反馈为准。</span>
      </div>
      {controlLocked && controlLockedReason && (
        <div className="motor-page-safety motor-page-locked" role="status">
          <strong>控制已锁定</strong>
          <span>{controlLockedReason}</span>
        </div>
      )}
      <MotorControl
        bridge={bridge}
        jointState={jointState}
        urdfXml={urdfXml}
        status={status}
        statusTopic={statusTopic}
        commandTopic={commandTopic}
        onStreamingChange={onStreamingChange}
        controlLocked={controlLocked}
        active={active}
      />
    </main>
  );
}
