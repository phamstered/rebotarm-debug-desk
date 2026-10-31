import { useEffect, useState } from "react";
import type { KinematicJoint } from "./kinematicsLogic";
import { positionMotionBusy, type PositionMotionControls } from "./positionMotionLogic";
import { ARM_JOINT_NAMES } from "./positionLogic";
import { jointFeedback, radiansToDegrees, rotationInput, type JointRotationPreview } from "./jointRotationLogic";

export function JointRotationPanel({ joints, selected, jointState, active, motion, hasPreview, onSelect, onPreview }: {
  joints: KinematicJoint[];
  selected: string;
  jointState: { name?: string[]; position?: number[] } | null;
  active: boolean;
  motion?: PositionMotionControls;
  hasPreview: boolean;
  onSelect(name: string): void;
  onPreview(value: JointRotationPreview | null): void;
}) {
  const joint = joints.find((item) => item.name === selected);
  const actual = jointFeedback(jointState?.name, jointState?.position, selected);
  const [angle, setAngle] = useState("");
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setDirty(false); onPreview(null); }, [selected, active, onPreview]);
  useEffect(() => {
    if (!dirty) setAngle(actual === null ? "" : radiansToDegrees(actual).toFixed(3));
  }, [actual, dirty, selected]);
  useEffect(() => { if (motion?.busy) { setDirty(false); onPreview(null); } }, [motion?.busy, onPreview]);
  const result = joint ? rotationInput(joint, angle) : { error: "请选择关节" };
  const supported = ARM_JOINT_NAMES.some((name) => name === selected);
  const block = !active ? "Robot View 已隐藏" : !motion ? "请连接 Jetson 并启动轨迹控制与 MoveIt" :
    !supported ? "此关节可预览；真机执行仅支持 arm 的 joint1–joint6" :
    motion.jointRotationReason || (actual === null ? "缺少当前关节反馈" : "") ||
    (motion.busy ? "运动进行中，请等待完成或取消" : "") ||
    (!motion.armed ? "请先确认工作区安全" : "");
  function change(text: string) {
    if (!active || motion?.busy || !joint) return;
    setAngle(text); setDirty(true);
    const parsed = rotationInput(joint, text);
    onPreview(parsed.position === undefined ? null : { jointName: joint.name, position: parsed.position });
  }
  const numericAngle = Number(angle);
  const targetDeg = Number.isFinite(numericAngle) ? numericAngle : 0;
  const min = joint && Number.isFinite(joint.lower) ? radiansToDegrees(joint.lower) : Math.min(-180, targetDeg, actual === null ? 0 : radiansToDegrees(actual));
  const max = joint && Number.isFinite(joint.upper) ? radiansToDegrees(joint.upper) : Math.max(180, targetDeg, actual === null ? 0 : radiansToDegrees(actual));
  return <section className="joint-rotation-panel" aria-label="单关节旋转">
    <label>选择关节<select aria-label="选择旋转关节" value={selected} disabled={!active || motion?.busy || joints.length === 0}
      onChange={(event) => onSelect(event.target.value)}>
      <option value="">点击模型或选择关节</option>
      {joints.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
    </select></label>
    {joint ? <>
      <div className="viewer-overlay-row"><span>实际角度</span><strong>{actual === null ? "无反馈" : `${radiansToDegrees(actual).toFixed(2)}°`}</strong></div>
      <label>目标角度 °<input aria-label="目标关节角度" type="text" inputMode="decimal" value={angle}
        disabled={!active || motion?.busy} onChange={(event) => change(event.target.value)} /></label>
      <input aria-label="关节角度滑块" type="range" min={min} max={max} step="0.1" value={Math.min(max, Math.max(min, targetDeg))}
        disabled={!active || motion?.busy} onChange={(event) => change(Number(event.target.value).toFixed(1))} />
      <p className="joint-rotation-limits">{joint.type === "continuous" ? "连续旋转" : `限位 ${Number.isFinite(joint.lower) ? min.toFixed(1) : "−∞"}° ~ ${Number.isFinite(joint.upper) ? max.toFixed(1) : "+∞"}°`}
        {result.position !== undefined && ` · ${result.position.toFixed(4)} rad`}</p>
      {dirty && result.error && <p role="alert" className="error">{result.error}</p>}
      <p className="joint-preview-state">{hasPreview ? "姿态预览中 · 尚未执行" : "实时姿态"}</p>
      <label className="joint-safety"><input type="checkbox" checked={motion?.armed ?? false} disabled={!motion || motion.busy}
        onChange={(event) => motion?.setArmed(event.target.checked)} />已确认工作区安全，允许运动</label>
      <div className="joint-rotation-actions">
        <button type="button" disabled={!dirty || motion?.busy} onClick={() => { setDirty(false); onPreview(null); }}>恢复实时</button>
        <button type="button" className="joint-execute" disabled={Boolean(block) || Boolean(result.error) || !hasPreview || motion?.busy}
          title={block || "由 MoveIt2 检查碰撞并执行；其余关节添加保持约束"}
          onClick={() => {
            if (block || !hasPreview || result.position === undefined || !joint || motion?.busy) return;
            setDirty(false); onPreview(null);
            void motion?.executeJoint(joint.name, result.position);
          }}>确认执行</button>
      </div>
      {block && <p className="joint-rotation-block">{block}</p>}
    </> : <p>选择关节后调整角度，仅预览；确认后由 MoveIt2 规划执行。</p>}
    {motion?.busy && positionMotionBusy(motion.state.phase) && <button type="button" className="joint-cancel" onClick={() => void motion.cancel()}>取消运动</button>}
  </section>;
}
