import { useEffect, useState } from "react";
import { ActionButton } from "./ActionButton";
import type { MotorControlCapabilities } from "./types";

export function recoveryAvailable(c: MotorControlCapabilities | null): boolean {
  return !!c?.supported && c.fresh && c.protocol_version === 3 && c.fault_code === 7
    && c.mode === 3 && c.enabled_joint_mask === 0 && c.lease_id === 0 && !c.switching;
}

export function MotorFaultRecovery({ capabilities: c, blocked, pending, onRecover }: {
  capabilities: MotorControlCapabilities | null; blocked: boolean; pending: boolean;
  onRecover(mask: number): void;
}) {
  const [open, setOpen] = useState(false), [mask, setMask] = useState(0), [confirmed, setConfirmed] = useState(false);
  useEffect(() => { setConfirmed(false); setOpen(false); setMask(0); }, [c?.boot_id, c?.control_epoch]);
  useEffect(() => { if (!c?.fresh || blocked) setConfirmed(false); }, [c?.fresh, blocked]);
  if (c?.fault_code !== 7 && !pending) return null;
  const unavailable = !recoveryAvailable(c) || blocked || pending;
  return <div className="motor-fault-recovery">
    <ActionButton disabled={unavailable} onClick={() => { setOpen(!open); setConfirmed(false); }}>清除驱动故障…</ActionButton>
    {c?.protocol_version !== 3 && <span>需升级配套 Bridge 与固件以支持故障恢复</span>}
    {pending && <span role="status">正在清故障并核验失能，不会恢复运动</span>}
    {open && <div className="motor-mode-confirmation">
      <strong>选择要清除故障的轴</strong>
      <div className="control-actions">{Array.from({ length: 7 }, (_, i) => <label key={i} className="arm-check"><input type="checkbox" aria-label={`恢复 joint${i + 1}`} disabled={unavailable} checked={!!(mask & (1 << i))} onChange={() => { setMask(mask ^ (1 << i)); setConfirmed(false); }} />joint{i + 1}</label>)}</div>
      <p>先停止、支撑机械臂，排除阻碍并确认电机冷却。只清故障，成功后仍失能；旧目标不会自动执行。</p>
      <label className="arm-check"><input type="checkbox" aria-label="故障恢复现场确认" checked={confirmed} disabled={unavailable || !mask} onChange={e => setConfirmed(e.target.checked)} />已支撑机械臂、排除阻碍并确认冷却</label>
      <ActionButton disabled={unavailable || !mask || !confirmed} onClick={() => { setConfirmed(false); onRecover(mask); }}>确认清故障并保持失能</ActionButton>
      <ActionButton disabled={pending} onClick={() => setOpen(false)}>取消</ActionButton>
    </div>}
  </div>;
}
