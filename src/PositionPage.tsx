import { useState } from "react";
import { ARM_JOINT_NAMES, homeRow, type CustomPosition, type PositionDraft, type PositionStore } from "./positionLogic";

const blankJoints = () => ["0", "0", "0", "0", "0", "0"];

export function PositionPage({
  profileKey,
  store,
  captureError,
  onCreate,
  onUpdate,
  onDelete,
  onCapture,
  onBack,
}: {
  profileKey: string;
  store: PositionStore;
  captureError: string;
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

  function readCurrent() {
    const captured = onCapture();
    if ("error" in captured) {
      setFormError(captured.error);
      return;
    }
    setJoints(captured.positions.map(String));
    setSource("feedback");
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
      <header className="position-page-bar">
        <h2>位置</h2>
        <div>
          {onBack && <button type="button" onClick={onBack}>返回连接</button>}
          <button type="button" onClick={readCurrent} disabled={Boolean(captureError)} title={captureError || "把六个臂关节写入编辑区"}>读取当前位置</button>
          <button type="button" onClick={openCreate}>新增</button>
        </div>
      </header>
      <table className="position-table">
        <thead>
          <tr><th>名称</th><th>关节</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr aria-label="HOME">
            <td>HOME</td>
            <td>待同步</td>
            <td>锁定</td>
          </tr>
          {positions.map((position) => (
            <PositionRow
              key={position.id}
              position={position}
              confirming={pendingDelete === position.id}
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
        </tbody>
      </table>
      {editorOpen && (
        <form className="position-editor" onSubmit={(event) => { event.preventDefault(); save(); }}>
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
          <button type="submit">保存点位</button>
        </form>
      )}
    </section>
  );
}

function PositionRow({
  position,
  confirming,
  onEdit,
  onAskDelete,
  onConfirmDelete,
}: {
  position: CustomPosition;
  confirming: boolean;
  onEdit(): void;
  onAskDelete(): void;
  onConfirmDelete(): void;
}) {
  return (
    <tr aria-label={position.name}>
      <td>{position.name}</td>
      <td>{position.positions.map((value) => value.toFixed(3)).join(", ")}</td>
      <td>
        <button type="button" onClick={onEdit}>编辑</button>
        {confirming
          ? <button type="button" aria-label={`确认删除 ${position.name}`} onClick={onConfirmDelete}>确认删除</button>
          : <button type="button" aria-label={`删除 ${position.name}`} onClick={onAskDelete}>删除</button>}
      </td>
    </tr>
  );
}
