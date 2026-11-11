import { useEffect, useRef, useState } from "react";
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
  const [saving, setSaving] = useState(false);
  const busy = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const close = () => { if (!busy.current) onClose(); };
  async function save() {
    if (busy.current) return;
    if (includeGripper && (!gripper.trim() || !Number.isFinite(Number(gripper)))) {
      setError("请输入有效的夹爪行程"); return;
    }
    busy.current = true; setSaving(true); setError("");
    try {
      const failure = await onSave({ ...initial, name, note, gripperPosition: includeGripper ? Number(gripper) / 1000 : undefined });
      if (!mounted.current) return;
      if (failure) setError(failure); else onClose();
    } catch (reason) { if (mounted.current) setError(String(reason)); }
    finally { busy.current = false; if (mounted.current) setSaving(false); }
  }
  return <ModalShell title="保存当前姿态" onClose={close} actions={<>
    <button type="button" disabled={saving} onClick={close}>取消</button>
    <button type="submit" disabled={saving} form="save-current-pose" className="primary">{saving ? "保存中…" : "保存点位"}</button>
  </>}>
    <form id="save-current-pose" className="save-pose-form" onSubmit={event => { event.preventDefault(); save(); }}>
      <p>保存点击时的实测姿态；TCP 预览不会写入，也不会执行运动。</p>
      <UrdfPoseThumbnail xml={urdfXml} label="正在保存" jointNames={includeGripper ? [...ARM_JOINT_NAMES, GRIPPER_JOINT_NAME] : [...ARM_JOINT_NAMES]}
        positions={includeGripper ? [...initial.positions, Number(gripper) / 1000] : initial.positions} />
      <label>点位名称<input disabled={saving} aria-label="点位名称" autoFocus value={name} onChange={event => setName(event.target.value)} /></label>
      <ul className="position-joint-chips" aria-label="采集的关节角">
        {ARM_JOINT_NAMES.map((joint, i) => <li key={joint}><span>{joint}</span><b>{initial.positions[i].toFixed(4)} rad</b></li>)}
      </ul>
      <label className="save-pose-gripper"><input disabled={saving} type="checkbox" aria-label="保存夹爪目标" checked={includeGripper} onChange={event => setIncludeGripper(event.target.checked)} />保存夹爪目标（不选则保持当前）</label>
      {includeGripper && <label>夹爪（joint7）单指行程 mm<input disabled={saving} aria-label="夹爪行程 mm" inputMode="decimal" value={gripper} onChange={event => setGripper(event.target.value)} /></label>}
      {initial.gripperPosition === undefined && <p>夹爪反馈不可用，当前仅采集六轴；可手动填写夹爪目标。</p>}
      <label>备注<textarea disabled={saving} aria-label="姿态备注" value={note} onChange={event => setNote(event.target.value)} /></label>
      {error && <p role="alert" className="error">{error}</p>}
    </form>
  </ModalShell>;
}
