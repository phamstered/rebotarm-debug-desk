import { useState } from "react";
import { ArmModeWorkflow } from "./ArmModeWorkflow";
import type { ArmWorkflow } from "./armModeWorkflowLogic";
import { positionMotionBusy, type PositionMotionControls } from "./positionMotionLogic";
import { UrdfPoseThumbnail } from "./UrdfPoseThumbnail";
import { ARM_JOINT_NAMES, homeRow, nextCapturedPoseName, type CustomPosition, type PositionDraft, type PositionStore } from "./positionLogic";

const blankJoints = () => ["0", "0", "0", "0", "0", "0"];

export function PositionPage({
  profileKey,
  store,
  captureError,
  urdfXml,
  onCreate,
  onUpdate,
  onDelete,
  onCapture,
  onBack,
  motion,
  planner,
}: {
  profileKey: string;
  store: PositionStore;
  captureError: string;
  urdfXml: string;
  onCreate(draft: PositionDraft): string;
  onUpdate(id: string, draft: PositionDraft): string;
  onDelete(id: string): void;
  onCapture(): { positions: number[] } | { error: string };
  onBack?: () => void;
  motion?: PositionMotionControls;
  planner?: { busy: boolean; disabledReason: string; notice: string; workflow: ArmWorkflow | null; start(): void };
}) {
  const [name, setName] = useState("");
  const [joints, setJoints] = useState<string[]>(blankJoints);
  const [note, setNote] = useState("");
  const [source, setSource] = useState<"manual" | "feedback">("manual");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [pendingDelete, setPendingDelete] = useState("");
  const home = homeRow();
  const positions = store.profiles[profileKey]?.positions ?? [];
  const moveReason = motion?.reason || (!motion?.armed ? "请先确认工作区安全并解锁点位执行" : "");
  const disabled = !motion || Boolean(moveReason) || motion.busy;
  const homeReady = motion?.homePositions.length === 6;

  function openCreate() {
    setEditingId(null);
    setName("");
    setJoints(blankJoints());
    setNote("");
    setSource("manual");
    setEditorOpen(true);
    setFormError("");
  }

  function saveCurrentPose() {
    const captured = onCapture();
    if ("error" in captured) {
      setFormError(captured.error);
      return;
    }
    setEditingId(null);
    setName(nextCapturedPoseName(positions));
    setJoints(captured.positions.map((value) => String(value)));
    setSource("feedback");
    setNote("");
    setEditorOpen(true);
    setFormError("");
  }

  function save() {
    const draft = { name, positions: joints.map(Number), note, source };
    const error = editingId ? onUpdate(editingId, draft) : onCreate(draft);
    if (error) {
      setFormError(error);
      return;
    }
    setEditorOpen(false);
    setEditingId(null);
    setFormError("");
  }

  return (
    <section className="position-page" aria-label="位置">
      <div className="position-toolbar">
        <div>
          <h2>位置</h2>
          <p>保存六个关节角；解锁后点击位置卡片，由 MoveIt2 检查碰撞并规划执行到目标。</p>
        </div>
        <div className="position-toolbar-actions">
          {onBack && <button type="button" className="position-quiet" onClick={onBack}>返回连接</button>}
          <button type="button" className="position-primary" onClick={saveCurrentPose} disabled={Boolean(captureError)} title={captureError || "把当前关节角写入新点位"}>保存当前姿态</button>
          <button type="button" className="position-quiet" onClick={openCreate}>手动新增</button>
        </div>
      </div>
      <section className="position-motion" aria-label="点位执行">
        <label><input type="checkbox" checked={motion?.armed ?? false} disabled={!motion || motion.busy}
          onChange={(event) => motion?.setArmed(event.target.checked)} />我已确认工作区安全，允许点位运动</label>
        {moveReason && <p>{moveReason}</p>}
        {planner && <button type="button" className="position-quiet" disabled={planner.busy || Boolean(planner.disabledReason)}
          title={planner.disabledReason || "启动或复用 MoveIt 规划器，不执行点位运动"}
          onClick={planner.start}>{planner.busy ? "MoveIt 启动中…" : "启动 MoveIt"}</button>}
        {planner?.disabledReason && planner.disabledReason !== moveReason && <p>{planner.disabledReason}</p>}
        {planner?.notice && <output role="status">{planner.notice}</output>}
        {planner && <ArmModeWorkflow workflow={planner.workflow} />}
        {motion?.busy && !positionMotionBusy(motion.state.phase) && <p>其他会话的点位运动尚未结束</p>}
        {motion && motion.state.phase !== "idle" && <div role="status" aria-live="polite">
          <strong>{motion.state.label}</strong> · {motion.state.message}
        </div>}
        {motion?.busy && positionMotionBusy(motion.state.phase) && <button type="button" className="position-danger" onClick={() => void motion.cancel()}>取消运动</button>}
      </section>
      <div className="position-workspace">
        <div className="position-list" aria-label="点位列表">
          <article className="position-card position-card-home" aria-label="HOME" onClick={(event) => {
            if (!disabled && homeReady && !(event.target as HTMLElement).closest("button")) void motion?.execute("home");
          }}>
            <button type="button" className="position-target" aria-label="移动到 HOME"
              disabled={disabled || !homeReady} title={homeReady ? moveReason : "HOME 尚未从 MoveIt SRDF 同步"}
              onClick={() => void motion?.execute("home")}>
              <UrdfPoseThumbnail xml={urdfXml} label="HOME" jointNames={[...ARM_JOINT_NAMES]} positions={homeReady ? motion?.homePositions : undefined} />
              <span>HOME</span>
            </button>
            <div className="position-card-body">
              <div className="position-card-head">
                <strong>HOME</strong>
                <span className="position-lock">锁定</span>
              </div>
              <p className="position-sync">{homeReady ? "SRDF arm/home" : home.sync === "pending" ? "待同步" : ""}</p>
            </div>
          </article>
          {positions.map((position) => (
            <PositionCard
              key={position.id}
              position={position}
              confirming={pendingDelete === position.id}
              moveDisabled={disabled || (editorOpen && editingId === position.id)}
              moveReason={editorOpen && editingId === position.id ? "正在编辑，请先保存或取消后再执行" : motion?.busy ? "已有点位运动正在执行" : moveReason}
              onMove={() => void motion?.execute(position)}
              urdfXml={urdfXml}
              previewPositions={editorOpen && editingId === position.id ? joints.map(Number) : undefined}
              onEdit={() => {
                setEditingId(position.id);
                setName(position.name);
                setJoints(position.positions.map(String));
                setNote(position.note);
                setSource(position.source);
                setEditorOpen(true);
                setFormError("");
              }}
              onAskDelete={() => setPendingDelete(position.id)}
              onConfirmDelete={() => {
                onDelete(position.id);
                setPendingDelete("");
              }}
            />
          ))}
          {positions.length === 0 && <p className="position-empty">还没有自定义点位。</p>}
        </div>
        <aside className="position-editor-pane" aria-label="点位编辑">
          {editorOpen ? (
            <form className="position-editor" onSubmit={(event) => { event.preventDefault(); save(); }}>
              <h3>{editingId ? "编辑点位" : "新建点位"}</h3>
              <UrdfPoseThumbnail xml={urdfXml} label="正在保存" jointNames={[...ARM_JOINT_NAMES]} positions={joints.map(Number)} />
              <label>点位名称<input aria-label="点位名称" value={name} onChange={(event) => setName(event.target.value)} /></label>
              <div className="position-joints">
                {ARM_JOINT_NAMES.map((jointName, index) => (
                  <label key={jointName}>{jointName}
                    <input
                      aria-label={jointName}
                      value={joints[index] ?? ""}
                      onChange={(event) => {
                        const next = [...joints];
                        next[index] = event.target.value;
                        setJoints(next);
                      }}
                    />
                  </label>
                ))}
              </div>
              {formError && <p className="position-error" role="alert">{formError}</p>}
              <div className="position-editor-actions">
                <button type="button" className="position-quiet" onClick={() => { setEditorOpen(false); setFormError(""); }}>取消</button>
                <button type="submit" className="position-primary">保存点位</button>
              </div>
            </form>
          ) : (
            <p className="position-editor-hint">选一个点位进行编辑，或新增一个。</p>
          )}
        </aside>
      </div>
    </section>
  );
}

function PositionCard({
  position,
  confirming,
  urdfXml,
  previewPositions,
  onEdit,
  onMove,
  moveDisabled,
  moveReason,
  onAskDelete,
  onConfirmDelete,
}: {
  position: CustomPosition;
  confirming: boolean;
  urdfXml: string;
  previewPositions?: number[];
  onEdit(): void;
  onMove(): void;
  moveDisabled: boolean;
  moveReason: string;
  onAskDelete(): void;
  onConfirmDelete(): void;
}) {
  const positions = previewPositions ?? position.positions;
  return (
    <article className="position-card" aria-label={position.name} onClick={(event) => {
      if (!moveDisabled && !(event.target as HTMLElement).closest("button")) onMove();
    }}>
      <button type="button" className="position-target" aria-label={`移动到 ${position.name}`} disabled={moveDisabled}
        title={moveReason || `由 MoveIt2 规划并移动到 ${position.name}`} onClick={onMove}>
        <UrdfPoseThumbnail xml={urdfXml} label={position.name} jointNames={position.jointNames} positions={positions} />
        <span>移动</span>
      </button>
      <div className="position-card-body">
        <div className="position-card-head">
          <strong>{position.name}</strong>
          <div className="position-card-actions">
            <button type="button" className="position-quiet" onClick={onEdit}>编辑</button>
            {confirming
              ? <button type="button" className="position-danger" aria-label={`确认删除 ${position.name}`} onClick={onConfirmDelete}>确认删除</button>
              : <button type="button" className="position-quiet" aria-label={`删除 ${position.name}`} onClick={onAskDelete}>删除</button>}
          </div>
        </div>
        <ul className="position-joint-chips" aria-label={`${position.name} 关节`}>
          {position.jointNames.map((jointName, index) => (
            <li key={jointName}><span>{jointName}</span><b>{positions[index]?.toFixed(3)}</b></li>
          ))}
        </ul>
      </div>
    </article>
  );
}
