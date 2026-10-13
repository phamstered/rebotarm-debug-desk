import type { BridgeClient } from "./bridge";
import { MotorControl } from "./MotorControl";
import type { HardwareStatus } from "./types";

type JointState = { name?: string[]; position?: number[]; velocity?: number[]; effort?: number[] };

export function MotorPage({
  bridge,
  jointState,
  status,
  commandTopic,
  onStreamingChange,
}: {
  bridge: BridgeClient;
  jointState: JointState | null;
  status: HardwareStatus | null;
  commandTopic: string;
  onStreamingChange(streaming: boolean): void;
}) {
  return (
    <main className="motor-page">
      <header className="motor-page-header">
        <div>
          <h1>Motor Control</h1>
          <span>7 轴 MIT 独立控制</span>
        </div>
        <div className="motor-page-topic">
          <span>COMMAND TOPIC</span>
          <strong>{commandTopic}</strong>
        </div>
      </header>
      <div className="motor-page-safety" role="note">
        <strong>发送前确认现场安全</strong>
        <span>只有已使能且被固件 active_joint_mask 覆盖的关节会写入控制量；离开此页面会停止持续发送并下发 DISABLE。</span>
      </div>
      <MotorControl
        bridge={bridge}
        jointState={jointState}
        status={status}
        onStreamingChange={onStreamingChange}
      />
    </main>
  );
}
