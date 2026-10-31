import { useEffect, useState } from "react";
import type { KinematicJoint } from "./kinematicsLogic";
import { positionMotionBusy, type PositionMotionControls } from "./positionMotionLogic";
import { ARM_JOINT_NAMES } from "./positionLogic";
import { jointFeedback, radiansToDegrees, rotationInput, type JointRotationPreview } from "./jointRotationLogic";

export function JointRotationPanel({ joints, selected, jointState, active, motion, hasPreview, resetKey = 0, onSelect, onPreview }: {
  joints: KinematicJoint[];
  selected: string;
  jointState: { name?: string[]; position?: number[] } | null;
  active: boolean;
  motion?: PositionMotionControls;
  hasPreview: boolean;
  resetKey?: number;
  onSelect(name: string): void;
  onPreview(value: JointRotationPreview | null): void;
}) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [duration, setDuration] = useState("5");
  useEffect(() => { setEdits({}); onPreview(null); }, [joints, active, resetKey, onPreview]);
  useEffect(() => { if (motion?.busy) { setEdits({}); onPreview(null); } }, [motion?.busy, onPreview]);
  const targets: Record<string, number> = {};
  let inputError = "";
  for (const [name, text] of Object.entries(edits)) {
    const joint = joints.find((item) => item.name === name);
    const result = joint ? rotationInput(joint, text) : { error: "关节已变化，请恢复实时" };
    if (result.position !== undefined) targets[name] = result.position;
    else inputError ||= `${name}：${result.error}`;
  }
  const seconds = duration.trim() ? Number(duration) : NaN;
  const durationError = !Number.isFinite(seconds) || seconds < .1 || seconds > 120 ? "运动时长须为 0.1–120 秒" : "";
  const unsupported = Object.keys(edits).some((name) => !ARM_JOINT_NAMES.some((axis) => axis === name));
  const block = !active ? "Robot View 已隐藏" : !motion ? "请连接 Jetson 并启动轨迹控制与 MoveIt" :
    unsupported ? "此关节可预览；真机执行仅支持 arm 的 joint1–joint6" :
    motion.jointTargetsReason || (ARM_JOINT_NAMES.some((name) => jointFeedback(jointState?.name, jointState?.position, name) === null) ? "缺少六轴实时反馈" : "") || (motion.busy ? "运动进行中，请等待完成或取消" : "") ||
    (!motion.armed ? "请先确认工作区安全" : "");
  function change(joint: KinematicJoint, text: string) {
    if (!active || motion?.busy) return;
    const next = { ...edits, [joint.name]: text };
    setEdits(next);
    const preview: JointRotationPreview = {};
    for (const [name, value] of Object.entries(next)) {
      const axis = joints.find((item) => item.name === name);
      const parsed = axis ? rotationInput(axis, value) : { position: undefined };
      if (parsed.position === undefined) { onPreview(null); return; }
      preview[name] = parsed.position;
    }
    onPreview(preview);
  }
  const joint = joints.find((item) => item.name === selected);
  const actual = jointFeedback(jointState?.name, jointState?.position, selected);
  const text = edits[selected] ?? (actual === null ? "" : radiansToDegrees(actual).toFixed(3));
  const targetDeg = Number.isFinite(Number(text)) ? Number(text) : 0;
  const min = joint && Number.isFinite(joint.lower) ? radiansToDegrees(joint.lower) : Math.min(-180, targetDeg, actual === null ? 0 : radiansToDegrees(actual));
  const max = joint && Number.isFinite(joint.upper) ? radiansToDegrees(joint.upper) : Math.max(180, targetDeg, actual === null ? 0 : radiansToDegrees(actual));
  return <section className="joint-rotation-panel" aria-label="关节联合调整">
    <p>可同时调整六轴，确认后作为一条 MoveIt 轨迹执行。</p>
    <label>选择关节<select aria-label="选择旋转关节" value={selected} disabled={!active || motion?.busy || joints.length === 0}
      onChange={(event) => onSelect(event.target.value)}>
      <option value="">点击模型或选择关节</option>
      {joints.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
    </select></label>
    <div className="joint-target-rows">
      {joints.map((axis) => {
        const value = jointFeedback(jointState?.name, jointState?.position, axis.name);
        return <label className={`joint-target-row${selected === axis.name ? " selected" : ""}`} key={axis.name}>
          <span>{axis.name}<small>实际 {value === null ? "无反馈" : `${radiansToDegrees(value).toFixed(2)}°`}</small></span>
          <input aria-label={`${axis.name} 目标角度`} type="text" inputMode="decimal"
            value={edits[axis.name] ?? (value === null ? "" : radiansToDegrees(value).toFixed(3))}
            disabled={!active || motion?.busy} onFocus={() => onSelect(axis.name)} onChange={(event) => change(axis, event.target.value)} />
          <span>°{axis.name in edits ? " *" : ""}</span>
        </label>;
      })}
    </div>
    {joint && <>
      <input aria-label="关节角度滑块" type="range" min={min} max={max} step="0.1" value={Math.min(max, Math.max(min, targetDeg))}
        disabled={!active || motion?.busy} onChange={(event) => change(joint, Number(event.target.value).toFixed(1))} />
      <p className="joint-rotation-limits">{selected} · {joint.type === "continuous" ? "连续旋转" : `限位 ${Number.isFinite(joint.lower) ? min.toFixed(1) : "−∞"}° ~ ${Number.isFinite(joint.upper) ? max.toFixed(1) : "+∞"}°`}</p>
    </>}
    <label>运动时长（秒）<input aria-label="运动时长（秒）" type="text" inputMode="decimal" value={duration}
      disabled={!active || motion?.busy} onChange={(event) => setDuration(event.target.value)} /></label>
    <p>不含规划耗时；短于安全规划时长会提示增加时间。</p>
    {(inputError || durationError) && <p role="alert" className="error">{inputError || durationError}</p>}
    <p className="joint-preview-state">{hasPreview ? `${Object.keys(targets).length} 轴姿态预览中 · 尚未执行` : "实时姿态"}</p>
    <label className="joint-safety"><input type="checkbox" checked={motion?.armed ?? false} disabled={!motion || motion.busy}
      onChange={(event) => motion?.setArmed(event.target.checked)} />已确认工作区安全，允许运动</label>
    <div className="joint-rotation-actions">
      <button type="button" disabled={!Object.keys(edits).length || motion?.busy} onClick={() => { setEdits({}); onPreview(null); }}>恢复实时</button>
      <button type="button" className="joint-execute" disabled={Boolean(block || inputError || durationError) || !hasPreview || motion?.busy}
        title={block || "MoveIt 碰撞规划后按指定时长执行；未编辑轴保持"}
        onClick={() => {
          if (block || inputError || durationError || !hasPreview || !Object.keys(targets).length || motion?.busy) return;
          setEdits({}); onPreview(null); void motion?.executeJoints(targets, seconds);
        }}>确认执行</button>
    </div>
    {block && <p className="joint-rotation-block">{block}</p>}
    {motion?.busy && positionMotionBusy(motion.state.phase) && <button type="button" className="joint-cancel" onClick={() => void motion.cancel()}>取消运动</button>}
  </section>;
}
