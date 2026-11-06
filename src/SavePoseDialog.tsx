import { useState } from "react";
import { ModalShell } from "./ModalShell";
import { ARM_JOINT_NAMES, GRIPPER_JOINT_NAME, type PositionDraft } from "./positionLogic";
import { UrdfPoseThumbnail } from "./UrdfPoseThumbnail";

/** Capture once on opening; later live feedback must not overwrite this draft. */
export function SavePoseDialog({ initial, urdfXml, onSave, onClose }: {
  initial: PositionDraft;
  urdfXml: string;
  onSave(draft: PositionDraft): string | Promise<string>;
  onClose(): void;
}) {
  const [name, setName] = useState(initial.name);
  const [note, setNote] = useState(initial.note);
  const [includeGripper, setIncludeGripper] = useState(initial.gripperPosition !== undefined);
  const [gripper, setGripper] = useState(initial.gripperPosition === undefined ? "" : String(initial.gripperPosition * 1000));
  const [error, setError] = useState("");
  async function save() {
    if (includeGripper && (!gripper.trim() || !Number.isFinite(Number(gripper)))) {
      setError("请输入有效的夹爪行程"); return;
    }
    const failure = await onSave({ ...initial, name, note, gripperPosition: includeGripper ? Number(gripper) / 1000 : undefined });
    if (failure) { setError(failure); return; }
    onClose();
  }
  return <ModalShell title="保存当前姿态" onClose={onClose} actions={<>
    <button type="button" onClick={onClose}>取消</button>
    <button type="submit" form="save-current-pose" className="primary">保存点位</button>
  </>}>
    <form id="save-current-pose" className="save-pose-form" onSubmit={event => { event.preventDefault(); return save(); }}>
      <p>保存点击时的实测姿态；TCP 预览不会写入，也不会执行运动。</p>
      <UrdfPoseThumbnail xml={urdfXml} label="正在保存" jointNames={includeGripper ? [...ARM_JOINT_NAMES, GRIPPER_JOINT_NAME] : [...ARM_JOINT_NAMES]}
        positions={includeGripper ? [...initial.positions, Number(gripper) / 1000] : initial.positions} />
      <label>点位名称<input aria-label="点位名称" autoFocus value={name} onChange={event => setName(event.target.value)} /></label>
      <ul className="position-joint-chips" aria-label="采集的关节角">
        {ARM_JOINT_NAMES.map((joint, i) => <li key={joint}><span>{joint}</span><b>{initial.positions[i].toFixed(4)} rad</b></li>)}
      </ul>
      <label className="save-pose-gripper"><input type="checkbox" aria-label="保存夹爪目标" checked={includeGripper} onChange={event => setIncludeGripper(event.target.checked)} />保存夹爪目标（不选则保持当前）</label>
      {includeGripper && <label>夹爪（joint7）单指行程 mm<input aria-label="夹爪行程 mm" inputMode="decimal" value={gripper} onChange={event => setGripper(event.target.value)} /></label>}
      {initial.gripperPosition === undefined && <p>夹爪反馈不可用，当前仅采集六轴；可手动填写夹爪目标。</p>}
      <label>备注<textarea aria-label="姿态备注" value={note} onChange={event => setNote(event.target.value)} /></label>
      {error && <p role="alert" className="error">{error}</p>}
    </form>
  </ModalShell>;
}
