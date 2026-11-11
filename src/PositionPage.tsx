import { useEffect, useRef, useState } from "react";
import { positionFingerprint } from "./positionStore";
import { useWorkspaceMenu } from "./WorkspaceMenu";
import { MotionDivider, useMotionLayout } from "./MotionLayout";
import { positionMotionBusy, type PositionMotionControls } from "./positionMotionLogic";
import { UrdfPoseThumbnail } from "./UrdfPoseThumbnail";
import { ARM_JOINT_NAMES, GRIPPER_JOINT_NAME, homeRow, type CustomPosition, type PositionDraft, type PositionStore } from "./positionLogic";

const blankJoints = () => ["0", "0", "0", "0", "0", "0"];

export function PositionPage({
  profileKey,
  store,
  urdfXml,
  onUpdate,
  onDelete,
  onBack,
  motion,
  editRequest,
  ready = true, saving = false, error = "",
}: {
  editRequest?: {id:string;intent?:"edit"|"delete"};
  profileKey: string;
  store: PositionStore;
  urdfXml: string;
  onUpdate(id: string, draft: PositionDraft, expected: string): string | Promise<string>;
  onDelete(id: string, expected: string): void | string | Promise<string>;
  ready?: boolean; saving?: boolean; error?: string;
  onBack?: () => void;
  motion?: PositionMotionControls;
}) {
  const [name, setName] = useState("");
  const [joints, setJoints] = useState<string[]>(blankJoints);
  const [gripper, setGripper] = useState("");
  const [includeGripper, setIncludeGripper] = useState(false);
  const [note, setNote] = useState("");
  const [source, setSource] = useState<"manual" | "feedback">("manual");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [pendingDelete, setPendingDelete] = useState("");
  const baseline = useRef(""), deleteBaseline = useRef("");
  const busy = useRef(false), mounted = useRef(true), profile = useRef(profileKey);
  profile.current = profileKey;
  const [pending, setPending] = useState(false);
  const working = saving || pending;
  const editingDisabled = working || !ready;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setEditorOpen(false); setEditingId(null); setPendingDelete(""); setFormError(""); }, [profileKey]);
  const home = homeRow();
  const positions = store.profiles[profileKey]?.positions ?? [];
  const moveReason = motion?.reason || (!motion?.armed ? "请先确认工作区安全并解锁点位执行" : "");
  const disabled = !motion || Boolean(moveReason) || motion.busy;
  const homeReady = motion?.homePositions.length === 6;

  const compact=useMotionLayout()?.compact ?? false;
  const [selectedId,setSelectedId]=useState("");
  const [menuId,setMenuId]=useState("");
  const target=positions.find(p=>p.id===(menuId||selectedId));
  function beginEdit(position: CustomPosition) {
    if (busy.current || saving || !ready) return;
    baseline.current = positionFingerprint(position);
    setSelectedId(position.id);setEditingId(position.id);setName(position.name);setJoints(position.positions.map(String));
    setIncludeGripper(position.gripperPosition!==undefined);setGripper(position.gripperPosition===undefined?"":String(position.gripperPosition*1000));
    setNote(position.note);setSource(position.source);setEditorOpen(true);setFormError("");
  }
  function askDelete(position: CustomPosition) {
    if (busy.current || saving || !ready) return;
    deleteBaseline.current = positionFingerprint(position); setPendingDelete(position.id); setFormError("");
  }
  useEffect(()=>{const p=positions.find(p=>p.id===editRequest?.id);if(p){setSelectedId(p.id);if(editRequest?.intent==='delete')askDelete(p);else beginEdit(p);}},[editRequest]);
  const contextMenu=useWorkspaceMenu(target?[
    {label:"编辑姿态",disabled:motion?.busy || editingDisabled,run:()=>beginEdit(target)},
    {label:"删除姿态",danger:true,disabled:motion?.busy || editingDisabled,run:()=>{setSelectedId(target.id);askDelete(target);}}
  ]:[],"姿态操作");
  const showEditor=!compact||editorOpen;
  async function write(action: () => void | string | Promise<string>, after: () => void) {
    if (busy.current || saving || !ready) return;
    busy.current = true; setPending(true); setFormError("");
    try {
      const failure = await action();
      if (!mounted.current || profile.current !== profileKey) return;
      if (failure) setFormError(failure); else after();
    } catch (reason) { if (mounted.current && profile.current === profileKey) setFormError(String(reason)); }
    finally { busy.current = false; if (mounted.current) setPending(false); }
  }
  function save() {
    if (includeGripper && (!gripper.trim() || !Number.isFinite(Number(gripper)))) { setFormError("请输入有效的夹爪行程"); return; }
    const draft = { gripperPosition: includeGripper ? Number(gripper) / 1000 : undefined, name, positions: joints.map(Number), note, source };
    if (!editingId) return;
    void write(() => onUpdate(editingId, draft, baseline.current), () => {
      setEditorOpen(false); setEditingId(null);
    });
  }

  return (
    <section className={`position-page${compact ? " compact-position-page" : ""}`} aria-label="姿态库">
      {contextMenu.menu}
      {(error || formError) && <p className="position-error" role="alert">{error || formError}</p>}
      {!ready && !error && <p role="status">正在读取姿态库…</p>}
      <div className="position-toolbar">
        <div>
          <h2>姿态库</h2>
          <p>{compact ? "双击 3D 缩略图移动；右键或 ⋯ 编辑、删除姿态。" : "保存六个关节角和可选夹爪行程；解锁后点击位置卡片，由 MoveIt2 检查碰撞并规划执行到目标。"}</p>
        </div>
        <div className="position-toolbar-actions">
          {onBack && <button type="button" disabled={working} className="position-quiet" onClick={onBack}>返回连接</button>}

        </div>
      </div>
      <section className="position-motion" aria-label="点位执行">
        <label><input type="checkbox" checked={motion?.armed ?? false} disabled={!motion || motion.busy}
          onChange={(event) => motion?.setArmed(event.target.checked)} />我已确认工作区安全，允许点位运动</label>
        {moveReason && <p>{moveReason}</p>}
        {motion?.busy && !positionMotionBusy(motion.state.phase) && <p>其他会话的点位运动尚未结束</p>}
        {motion && motion.state.phase !== "idle" && <div role="status" aria-live="polite">
          <strong>{motion.state.label}</strong> · {motion.state.message}
        </div>}
        {motion?.busy && positionMotionBusy(motion.state.phase) && <button type="button" className="position-danger" onClick={() => void motion.cancel()}>取消运动</button>}
      </section>
      <div className={`position-workspace${showEditor ? "" : " position-editor-closed"}`}>
        <div className="position-list" aria-label="点位列表">
          <article className="position-card position-card-home" aria-label="HOME" onClick={(event) => {
            if (!compact && !disabled && homeReady && !(event.target as HTMLElement).closest("button")) void motion?.execute("home");
          }}>
            <button type="button" className="position-target" aria-label="移动到 HOME"
              disabled={disabled || !homeReady} title={homeReady ? moveReason || (compact ? "双击移动到 HOME；键盘 Enter / 空格执行" : "移动到 HOME") : "HOME 尚未从 MoveIt SRDF 同步"}
              onClick={event => { if (!compact || event.detail === 0) void motion?.execute("home"); }}
              onDoubleClick={compact ? () => { if (!disabled && homeReady) void motion?.execute("home"); } : undefined}>
              <UrdfPoseThumbnail xml={urdfXml} label="HOME" jointNames={[...ARM_JOINT_NAMES]} positions={homeReady ? motion?.homePositions : undefined} />
              <span>{compact ? "双击移动" : "HOME"}</span>
            </button>
            <div className="position-card-body">
              <div className="position-card-head">
                <strong>HOME</strong>
                <span className="position-lock">锁定</span>
              </div>
              <p>夹爪：保持当前</p>
              <p className="position-sync">{homeReady ? "SRDF arm/home" : home.sync === "pending" ? "待同步" : ""}</p>
            </div>
          </article>
          {positions.map((position) => (
            <PositionCard
              key={position.id}
              compact={compact}
              selected={selectedId===position.id}
              onSelect={()=>{if(working)return;setSelectedId(position.id);setMenuId("");setEditorOpen(false);}}
              onContextMenu={e=>{setMenuId(position.id);contextMenu.onContextMenu(e);}}
              onContextKey={e=>{setMenuId(position.id);contextMenu.onKeyDown(e);}}
              position={position}
              confirming={pendingDelete === position.id}
              editingDisabled={editingDisabled || !!motion?.busy}
              moveDisabled={disabled || working || (position.gripperPosition !== undefined && !motion?.gripper?.available) || (editorOpen && editingId === position.id)}
              moveReason={position.gripperPosition !== undefined && !motion?.gripper?.available ? motion?.gripper?.message || "当前 Bridge 不支持夹爪" : editorOpen && editingId === position.id ? "正在编辑，请先保存或取消后再执行" : motion?.busy ? "已有点位运动正在执行" : moveReason}
              onMove={() => void motion?.execute(position)}
              urdfXml={urdfXml}
              previewPositions={editorOpen && editingId === position.id ? joints.map(Number) : undefined}
              onEdit={() => beginEdit(position)}
              onAskDelete={() => askDelete(position)}
              onConfirmDelete={() => {
                void write(() => onDelete(position.id, deleteBaseline.current), () => {
                setPendingDelete("");setMenuId("");
                if(selectedId===position.id)setSelectedId("");
                if(editingId===position.id){setEditorOpen(false);setEditingId(null);}
                });
              }}
            />
          ))}
          {positions.length === 0 && <p className="position-empty">还没有自定义点位。</p>}
        </div>
        {showEditor && <MotionDivider size="editorWidth" label="调整点位编辑区宽度" axis="x" edge="end" panel=".position-editor-pane" container=".position-workspace" maxFraction={.6} className="position-editor-width-divider" />}
        {showEditor && <MotionDivider size="editorHeight" label="调整点位编辑区高度" axis="y" edge="end" panel=".position-editor-pane" container=".position-workspace" maxFraction={.65} className="position-editor-height-divider" />}
        <aside className="position-editor-pane" aria-label="点位编辑" hidden={!showEditor}>
          {editorOpen ? (
            <form className="position-editor" onSubmit={(event) => { event.preventDefault(); save(); }}>
              <h3>{editingId ? "编辑点位" : "新建点位"}</h3>
              <UrdfPoseThumbnail xml={urdfXml} label="正在保存" jointNames={includeGripper ? [...ARM_JOINT_NAMES, GRIPPER_JOINT_NAME] : [...ARM_JOINT_NAMES]} positions={includeGripper ? [...joints.map(Number), Number(gripper) / 1000] : joints.map(Number)} />
              <label>点位名称<input disabled={working} aria-label="点位名称" value={name} onChange={(event) => setName(event.target.value)} /></label>
              <div className="position-joints">
                {ARM_JOINT_NAMES.map((jointName, index) => (
                  <label key={jointName}>{jointName}
                    <input disabled={working}
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
              <label><input disabled={working} type="checkbox" aria-label="保存夹爪目标" checked={includeGripper} onChange={(event) => setIncludeGripper(event.target.checked)} />保存夹爪目标（不选则保持当前）</label>
              {includeGripper && <label>夹爪（joint7）单指行程 mm<input disabled={working} aria-label="夹爪行程 mm" inputMode="decimal" value={gripper} onChange={(event) => setGripper(event.target.value)} /></label>}
              {!motion?.gripper?.fresh && source === "feedback" && <p>夹爪反馈不可用，当前仅采集六轴；可手动填写夹爪目标。</p>}
              <div className="position-editor-actions">
                <button type="button" disabled={working} className="position-quiet" onClick={() => { setEditorOpen(false); setFormError(""); }}>取消</button>
                <button type="submit" disabled={editingDisabled} className="position-primary">{working ? "保存中…" : "保存点位"}</button>
              </div>
            </form>
          ) : (
            <p className="position-editor-hint">选一个点位进行编辑；新姿态请在 Robot View 的 TCP 操作区保存。</p>
          )}
        </aside>
      </div>
    </section>
  );
}

function PositionCard({
  compact, selected, onSelect, onContextMenu, onContextKey,
  position,
  confirming,
  editingDisabled,
  urdfXml,
  previewPositions,
  onEdit,
  onMove,
  moveDisabled,
  moveReason,
  onAskDelete,
  onConfirmDelete,
}: {
  compact?: boolean; selected?: boolean; onSelect(): void;
  onContextMenu(event: import("react").MouseEvent<HTMLElement>): void;
  onContextKey(event: import("react").KeyboardEvent<HTMLElement>): void;
  position: CustomPosition;
  confirming: boolean;
  editingDisabled: boolean;
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
    <article className={`position-card${selected ? " selected" : ""}`} aria-label={position.name} tabIndex={compact ? 0 : undefined}
      onContextMenu={onContextMenu} onKeyDown={onContextKey} onClick={(event) => {
      if (!(event.target as HTMLElement).closest("button")) { if(compact)onSelect();else if(!moveDisabled)onMove(); }
    }}>
      <button type="button" className="position-target" aria-label={`移动到 ${position.name}`} disabled={moveDisabled}
        title={moveReason || (compact ? `双击移动到 ${position.name}；键盘 Enter / 空格执行` : `由 MoveIt2 规划并移动到 ${position.name}`)}
        onClick={event => { if (!compact || event.detail === 0) onMove(); else onSelect(); }}
        onDoubleClick={compact ? () => { if (!moveDisabled) onMove(); } : undefined}>
        <UrdfPoseThumbnail xml={urdfXml} label={position.name} jointNames={position.gripperPosition === undefined ? position.jointNames : [...position.jointNames, GRIPPER_JOINT_NAME]} positions={position.gripperPosition === undefined ? positions : [...positions, position.gripperPosition]} />
        <span>{compact ? "双击移动" : "移动"}</span>
      </button>
      <div className="position-card-body">
        <div className="position-card-head">
          <strong>{position.name}</strong>
          <div className="position-card-actions">
            {compact ? <button type="button" disabled={editingDisabled} className="workspace-more" aria-label={`${position.name}更多操作`} onClick={onContextMenu}>⋯</button> : <button type="button" disabled={editingDisabled} className="position-quiet" onClick={onEdit}>编辑</button>}
            {confirming
              ? <button type="button" disabled={editingDisabled} className="position-danger" aria-label={`确认删除 ${position.name}`} onClick={onConfirmDelete}>确认删除</button>
              : !compact && <button type="button" disabled={editingDisabled} className="position-quiet" aria-label={`删除 ${position.name}`} onClick={onAskDelete}>删除</button>}
          </div>
        </div>
        <p>夹爪（joint7）：{position.gripperPosition === undefined ? "保持当前" : `${(position.gripperPosition * 1000).toFixed(2)} mm`}</p>
        <ul className="position-joint-chips" aria-label={`${position.name} 关节`}>
          {position.jointNames.map((jointName, index) => (
            <li key={jointName}><span>{jointName}</span><b>{positions[index]?.toFixed(3)}</b></li>
          ))}
        </ul>
      </div>
    </article>
  );
}
