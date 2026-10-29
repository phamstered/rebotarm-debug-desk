import { useState } from "react";
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
          <p>重力补偿下把手臂拖到目标位置后，保存当前六个关节角。只记录姿态，不会让手臂运动。</p>
        </div>
        <div className="position-toolbar-actions">
          {onBack && <button type="button" className="position-quiet" onClick={onBack}>返回连接</button>}
          <button type="button" className="position-primary" onClick={saveCurrentPose} disabled={Boolean(captureError)} title={captureError || "把当前关节角写入新点位"}>保存当前姿态</button>
          <button type="button" className="position-quiet" onClick={openCreate}>手动新增</button>
        </div>
      </div>
      <div className="position-workspace">
        <div className="position-list" aria-label="点位列表">
          <article className="position-card position-card-home" aria-label="HOME">
            <UrdfPoseThumbnail xml={urdfXml} label="HOME" />
            <div className="position-card-body">
              <div className="position-card-head">
                <strong>HOME</strong>
                <span className="position-lock">锁定</span>
              </div>
              <p className="position-sync">{home.sync === "pending" ? "待同步" : ""}</p>
            </div>
          </article>
          {positions.map((position) => (
            <PositionCard
              key={position.id}
              position={position}
              confirming={pendingDelete === position.id}
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
  onAskDelete,
  onConfirmDelete,
}: {
  position: CustomPosition;
  confirming: boolean;
  urdfXml: string;
  previewPositions?: number[];
  onEdit(): void;
  onAskDelete(): void;
  onConfirmDelete(): void;
}) {
  const positions = previewPositions ?? position.positions;
  return (
    <article className="position-card" aria-label={position.name}>
      <UrdfPoseThumbnail xml={urdfXml} label={position.name} jointNames={position.jointNames} positions={positions} />
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
