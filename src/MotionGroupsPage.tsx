import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { MotionDivider, useMotionLayout } from "./MotionLayout";
import { UrdfPoseThumbnail } from "./UrdfPoseThumbnail";
import {
  ARM_JOINT_NAMES,
  HOME_POSITION_ID,
  type CustomPosition,
} from "./positionLogic";
import {
  positionMotionBusy,
  type PositionMotionControls,
  type PositionMotionState,
} from "./positionMotionLogic";
import {
  MOTION_GROUP_LIMITS,
  snapshotStep,
  validateMotionGroup,
  groupTracks,
  groupDeviceReason,
  DEFAULT_ARM_TRACK,
  type MotionCaptureAction,
  motionPoseThumbnailProps,
  type MotionGroup,
} from "./motionGroupsLogic";
import {
  cloneMotionGroup,
  editorTimeline,
  GROUP_HISTORY_LIMIT,
  previewGroupPose,
  reorderGroupStep,
  snappedArrival,
  sourceSnapshotChanged,
} from "./motionGroupsTimelineLogic";
import "./motionGroups.css";
import { MotionSyncEditor } from "./MotionSyncEditor";
import { MotionPosePicker } from "./MotionPosePicker";
import { MotionGroupDialog } from "./MotionGroupDialog";
import { useMotionReport } from "./MotionOutput";
import { motionGroupPhaseLabels } from "./MotionGroupResult";

export type MotionGroupsPageProps = {
  profileKey: string;
  active?: boolean;
  groups: MotionGroup[];
  positions: CustomPosition[];
  ready: boolean;
  saving: boolean;
  error: string;
  urdfXml: string;
  homePositions?: number[];
  onSave(group: MotionGroup): Promise<void>;
  onDelete(id: string): Promise<void>;
  onBack?(): void;
  onOpenPoseLibrary?(): void;
  motion: PositionMotionControls;
};
export type GroupEditorHistory = {
  past: MotionGroup[];
  present: MotionGroup | null;
  future: MotionGroup[];
  base: string;
};
type PendingNavigation = { kind: "group"; id: string } | { kind: "back" };
const empty = (): GroupEditorHistory => ({
  past: [],
  present: null,
  future: [],
  base: "",
});
const id = () => crypto.randomUUID();
const seconds = (value: number) =>
  Number.isFinite(value) ? `${Number(value.toFixed(2))} s` : "无效";
const fieldValue = (value: number) => (Number.isFinite(value) ? value : "");
const numberValue = (value: string) =>
  value.trim() === "" ? NaN : Number(value);
function Editor({
  profileKey,
  active = true,
  groups,
  positions,
  ready,
  saving,
  error,
  urdfXml,
  homePositions,
  onSave,
  onDelete,
  onBack,
  onOpenPoseLibrary,
  motion,
  cached,
  remember,
}: MotionGroupsPageProps & {
  cached?: GroupEditorHistory;
  remember(history: GroupEditorHistory): void;
}) {
  const [history, setGroupEditorHistory] = useState<GroupEditorHistory>(
    () =>
      cached ??
      (groups[0]
        ? {
            past: [],
            present: cloneMotionGroup(groups[0]),
            future: [],
            base: JSON.stringify(groups[0]),
          }
        : empty()),
  );
  const [picker, setPicker] = useState<"create" | "insert" | null>(null);
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  const reviewAttempt = useRef(0);
  const closeReview = () => {
    reviewAttempt.current++;
    setReview(false);
  };
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [trackEditor, setTrackEditor] = useState(false);
  const [syncEditor, setSyncEditor] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState(0),
    [playhead, setPlayhead] = useState(0);
  const [zoom, setZoom] = useState(40),
    [snap, setSnap] = useState(true);
  const [notice, setNotice] = useState(""),
    [pending, setPending] = useState<PendingNavigation | null>(null),
    [deleting, setDeleting] = useState(false),
    [working, setWorking] = useState(false);
  const pendingSnapshot = useRef<MotionGroup | null>(null);
  const [lastResult, setLastResult] = useState<{
    state: PositionMotionState;
    snapshot: MotionGroup | null;
  } | null>(null);
  useEffect(() => {
    const state = motion.state;
    if (state.phase === "idle" && !state.commandId) {
      pendingSnapshot.current = null;
      setLastResult(null);
      return;
    }
    if (!state.group || !state.commandId) return;
    const pending = pendingSnapshot.current;
    if (pending && pending.id === state.group.id)
      pendingSnapshot.current = null;
    setLastResult((previous) => ({
      state: {
        ...state,
        group: { ...state.group! },
        arrivalErrors: state.arrivalErrors?.map((error) => ({ ...error })),
        holdFailure: state.holdFailure
          ? {
              ...state.holdFailure,
              samples: state.holdFailure.samples.map((sample) => ({
                ...sample,
              })),
            }
          : undefined,
      },
      snapshot:
        pending?.id === state.group!.id
          ? cloneMotionGroup(pending)
          : previous?.state.commandId === state.commandId
            ? previous.snapshot
            : null,
    }));
  }, [motion.state]);
  const currentGroupState =
    motion.state.group && motion.state.commandId ? motion.state : null;
  const resultState = currentGroupState ?? lastResult?.state;
  const running =
    lastResult?.state.commandId === resultState?.commandId
      ? lastResult?.snapshot
      : null;
  const live = useRef(true),
    locked = useRef(false),
    dragCleanup = useRef<(() => void) | null>(null);
  const openReport = useMotionReport(resultState, running);
  const scroll = useRef<HTMLDivElement>(null),
    layout = useMotionLayout();
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      dragCleanup.current?.();
    };
  }, []);
  useEffect(() => {
    remember(history);
  }, [history, remember]);
  const initialized = useRef(!!cached?.present || !!groups[0]);
  useEffect(() => {
    if (!active || (layout && !layout.active)) dragCleanup.current?.();
  }, [layout?.active, active]);
  useEffect(() => {
    if (!initialized.current && !history.present && groups[0] && ready) {
      initialized.current = true;
      setGroupEditorHistory({
        past: [],
        present: cloneMotionGroup(groups[0]),
        future: [],
        base: JSON.stringify(groups[0]),
      });
    }
  }, [groups, ready, history.present]);
  const draft = history.present,
    dirty = !!draft && JSON.stringify(draft) !== history.base;
  const rows = draft ? editorTimeline(draft) : [],
    total = rows.at(-1)?.departure ?? 0;
  const displayTotal = Number.isFinite(total)
    ? Math.min(total, 604800)
    : 604800;
  const effectiveZoom = Math.min(zoom, 499900 / Math.max(1, displayTotal));
  const selected = draft?.steps[selectedStep];
  const sources: CustomPosition[] = [...positions];
  if (homePositions?.length === 6 && homePositions.every(Number.isFinite))
    sources.unshift({
      id: HOME_POSITION_ID,
      name: "HOME",
      group: "arm",
      jointNames: [...ARM_JOINT_NAMES],
      positions: [...homePositions],
      source: "manual",
      note: "",
      capturedAt: null,
      createdAt: 0,
      updatedAt: 0,
    });
  const selectedAction = draft?.actions?.find((a) => a.id === selectedActionId);
  const tracks = draft ? groupTracks(draft) : [DEFAULT_ARM_TRACK];
  const editingLocked =
    !!draft &&
    motion.busy &&
    motion.state.group?.id === draft.id &&
    positionMotionBusy(motion.state.phase);
  const source =
    selected && sources.find((position) => position.id === selected.positionId);
  const validation = draft ? validateMotionGroup(draft) : "请选择或新建动作组";
  const duplicate =
    !!draft &&
    groups.some((group) => group.id !== draft.id && group.name === draft.name);
  const writeReason = !ready
    ? "动作组尚未加载，无法写入"
    : error || (duplicate ? "动作组名称重复" : validation);
  const capabilityReason =
    !motion.executeGroup || motion.groupReason === undefined
      ? "当前连接不支持动作组执行"
      : motion.groupReason;
  const executeReason = !ready
    ? "动作组尚未加载"
    : error ||
      validation ||
      (draft ? groupDeviceReason(draft) : "") ||
      (draft?.actions?.length && !motion.captureSupported
        ? "当前 Bridge 不支持拍照 Action，请更新 Bridge"
        : "") ||
      capabilityReason ||
      (!motion.armed
        ? "请先确认工作区安全"
        : motion.busy
          ? "已有运动正在执行"
          : "");
  const groupActive =
    !!motion.state.group &&
    !!motion.state.commandId &&
    motion.busy &&
    positionMotionBusy(motion.state.phase);
  function edit(next: MotionGroup | ((group: MotionGroup) => MotionGroup)) {
    if (editingLocked) return;
    setReview(false);
    setGroupEditorHistory((current) => {
      if (!current.present) return current;
      const value =
        typeof next === "function"
          ? next(cloneMotionGroup(current.present))
          : cloneMotionGroup(next);
      return {
        ...current,
        past: [...current.past, cloneMotionGroup(current.present)].slice(
          -GROUP_HISTORY_LIMIT,
        ),
        present: value,
        future: [],
      };
    });
  }
  function choose(nextId: string) {
    if (nextId === "new") {
      setPicker("create");
      setPending(null);
      return;
    }
    const next = groups.find((group) => group.id === nextId);
    const now = Date.now();
    const value = next
      ? cloneMotionGroup(next)
      : {
          id: id(),
          name: "新动作组",
          note: "",
          preparationDuration: 5,
          steps: [],
          createdAt: now,
          updatedAt: now,
        };
    setGroupEditorHistory({
      past: [],
      present: value,
      future: [],
      base: next ? JSON.stringify(next) : "",
    });
    setSelectedStep(0);
    setSelectedActionId(null);
    setPlaying(false);
    setPlayhead(0);
    setPending(null);
    setNotice("");
    setDeleting(false);
  }
  function navigate(next: PendingNavigation, discard = false) {
    if (next.kind === "group") {
      choose(next.id);
      return;
    }
    setPending(null);
    if (discard) {
      const saved = groups.find((group) => group.id === draft?.id);
      setGroupEditorHistory(
        saved
          ? {
              past: [],
              present: cloneMotionGroup(saved),
              future: [],
              base: JSON.stringify(saved),
            }
          : empty(),
      );
    }
    onBack?.();
  }
  function requestNavigate(next: PendingNavigation) {
    if (dirty) setPending(next);
    else navigate(next);
  }
  function requestChoose(nextId: string) {
    requestNavigate({ kind: "group", id: nextId });
  }
  async function save(after?: PendingNavigation) {
    if (!draft || writeReason || saving || locked.current) return;
    locked.current = true;
    setWorking(true);
    setNotice("");
    const copy = cloneMotionGroup({ ...draft, updatedAt: Date.now() });
    try {
      await onSave(copy);
      if (!live.current) return;
      setGroupEditorHistory((current) => ({
        ...current,
        base: JSON.stringify(copy),
        present:
          JSON.stringify(current.present) === JSON.stringify(draft)
            ? copy
            : current.present,
      }));
      setNotice("动作组已保存");
      if (after !== undefined) navigate(after);
    } catch (cause) {
      if (live.current)
        setNotice(
          `保存失败：${cause instanceof Error ? cause.message : String(cause)}`,
        );
    } finally {
      locked.current = false;
      if (live.current) setWorking(false);
    }
  }
  function changeStep(field: "duration" | "hold", value: number) {
    edit((group) => ({
      ...group,
      steps: group.steps.map((step, index) =>
        index === selectedStep ? { ...step, [field]: value } : step,
      ),
    }));
  }
  function moveStep(from: number, to: number) {
    if (!draft) return;
    edit(reorderGroupStep(draft, from, to));
    setSelectedStep(to);
  }
  function startDrag(
    event: ReactPointerEvent<HTMLButtonElement>,
    index: number,
  ) {
    if (!draft || index === 0 || event.button !== 0 || editingLocked) return;
    setSelectedStep(index);
    setSelectedActionId(null);
    setPlaying(false);
    event.preventDefault();
    dragCleanup.current?.();
    const original = cloneMotionGroup(draft),
      start = event.clientX,
      row = rows[index],
      pointerId = event.pointerId;
    let changed: MotionGroup | null = null;
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      const arrival = snappedArrival(
        row.arrival + (pointer.clientX - start) / effectiveZoom,
        row.start,
        snap,
      );
      changed = cloneMotionGroup(original);
      changed.steps[index].duration = arrival - row.start;
      setGroupEditorHistory((current) => ({ ...current, present: changed }));
    };
    const stop = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key);
      setGroupEditorHistory((current) =>
        changed && commit
          ? {
              ...current,
              past: [...current.past, original].slice(-GROUP_HISTORY_LIMIT),
              future: [],
            }
          : { ...current, present: original },
      );
      dragCleanup.current = null;
    };
    const up = (pointer: PointerEvent) => {
        if (pointer.pointerId === pointerId) stop(true);
      },
      cancel = () => stop(false),
      key = (e: KeyboardEvent) => {
        if (e.key === "Escape") stop(false);
      };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key);
    dragCleanup.current = cancel;
  }
  function scrub(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button"))
      return;
    event.preventDefault();
    dragCleanup.current?.();
    const bounds = event.currentTarget.getBoundingClientRect(),
      pointerId = event.pointerId;
    const update = (clientX: number) =>
      setPlayhead(
        Math.max(
          0,
          Math.min(displayTotal, (clientX - bounds.left - 260) / effectiveZoom),
        ),
      );
    update(event.clientX);
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId === pointerId) update(pointer.clientX);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      dragCleanup.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
    dragCleanup.current = stop;
  }
  async function action(callback: (() => Promise<void>) | undefined) {
    if (!callback || locked.current) return;
    locked.current = true;
    setWorking(true);
    try {
      await callback();
    } catch (cause) {
      if (live.current) setNotice(String(cause));
    } finally {
      locked.current = false;
      if (live.current) setWorking(false);
    }
  }
  const stepStatus = source
    ? sourceSnapshotChanged(selected!, source)
      ? "来源已更新；已保存快照保持不变"
      : "来源与快照一致"
    : "来源已删除；快照仍可执行";
  useEffect(() => {
    if (
      !playing ||
      !active ||
      !draft ||
      layout?.active === false ||
      motion.busy
    ) {
      setPlaying(false);
      return;
    }
    let frame = 0,
      last = performance.now();
    const tick = (now: number) => {
      if (document.hidden) {
        setPlaying(false);
        return;
      }
      const delta = ((now - last) / 1000) * speed;
      last = now;
      setPlayhead((previous) => {
        const next = Math.min(displayTotal, previous + delta);
        if (next >= displayTotal) setPlaying(false);
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [
    playing,
    speed,
    displayTotal,
    layout?.active,
    active,
    motion.busy,
    draft?.id,
  ]);
  const timelineWidth = Math.max(
    420,
    Math.min(500000, displayTotal * effectiveZoom + 280),
  );
  const armTrack = tracks.find((t) => t.kind === "arm")!;
  function chooseStep(index: number) {
    setSelectedStep(index);
    setSelectedActionId(null);
    setPlayhead(rows[index].arrival);
    setPlaying(false);
  }
  function insertPoses(name: string, poses: CustomPosition[]) {
    if (picker === "create") {
      const now = Date.now();
      const group: MotionGroup = {
        id: id(),
        name,
        note: "",
        preparationDuration: 5,
        createdAt: now,
        updatedAt: now,
        tracks: [{ ...DEFAULT_ARM_TRACK }],
        steps: poses.map((p, i) => ({
          ...snapshotStep(p, id(), i ? 5 : 0),
          trackId: "arm",
        })),
      };
      setGroupEditorHistory({ past: [], present: group, future: [], base: "" });
      setSelectedStep(0);
      setSelectedActionId(null);
      setPlayhead(0);
    } else if (draft) {
      const offset = selected ? selectedStep + 1 : draft.steps.length;
      const additions = poses.map((p, i) => ({
        ...snapshotStep(p, id(), offset + i ? 5 : 0),
        trackId: selected?.trackId ?? armTrack.id,
      }));
      edit((g) => {
        g.steps.splice(offset, 0, ...additions);
        return g;
      });
      setSelectedStep(offset);
      setSelectedActionId(null);
    }
    setPicker(null);
  }
  function addCapture() {
    if (
      !draft ||
      !selected ||
      editingLocked ||
      (tracks.length >= 16 && !tracks.some((t) => t.kind === "camera")) ||
      (draft.actions?.length ?? 0) >= 100
    )
      return;
    const camera = tracks.find((t) => t.kind === "camera") ?? {
      id: id(),
      name: "标定相机",
      kind: "camera" as const,
      deviceId: "current",
    };
    const capture: MotionCaptureAction = {
      id: id(),
      name: `拍照 ${(draft.actions?.length ?? 0) + 1}`,
      type: "camera_capture",
      trackId: camera.id,
      afterStepId: selected.id,
      topic: "/cameras/left_arm/wrist/color/image_raw",
      timeout: 5,
    };
    edit((g) => ({
      ...g,
      tracks: tracks.some((t) => t.id === camera.id)
        ? tracks
        : [...tracks, camera],
      actions: [...(g.actions ?? []), capture],
    }));
    setSelectedActionId(capture.id);
  }
  function editCapture(values: Partial<MotionCaptureAction>) {
    if (selectedAction)
      edit((g) => ({
        ...g,
        actions: g.actions?.map((a) =>
          a.id === selectedAction.id ? { ...a, ...values } : a,
        ),
      }));
  }
  function removeStep(index: number) {
    edit((g) => ({
      ...g,
      syncPoints: g.syncPoints?.filter(
        (p) => !p.afterStepIds.includes(g.steps[index].id),
      ),
      actions: g.actions?.filter((a) => a.afterStepId !== g.steps[index].id),
      steps: g.steps
        .filter((_, i) => i !== index)
        .map((s, i) => ({ ...s, duration: i ? s.duration || 5 : 0 })),
    }));
    setSelectedStep(Math.max(0, index - 1));
    setSelectedActionId(null);
  }
  async function executeSnapshot(saveFirst: boolean) {
    if (!draft || executeReason || working) return;
    const attempt = reviewAttempt.current;
    const copy = cloneMotionGroup(draft);
    if (saveFirst) {
      if (locked.current || saving) return;
      locked.current = true;
      setWorking(true);
      try {
        await onSave(copy);
        if (!live.current) return;
        setGroupEditorHistory((c) => ({ ...c, base: JSON.stringify(copy) }));
      } catch (e) {
        if (live.current) setNotice(`保存失败：${e}`);
        return;
      } finally {
        locked.current = false;
        if (live.current) setWorking(false);
      }
    }
    if (!live.current || reviewAttempt.current !== attempt) return;
    pendingSnapshot.current = copy;
    setReview(false);
    setPlaying(false);
    void action(() => motion.executeGroup!(copy));
  }
  const captureResult = resultState?.capture;
  return (
    <section
      className="motion-groups-editor"
      aria-label="动作组编辑器"
      data-profile={profileKey}
    >
      {onBack && (
        <div className="motion-offline-back">
          <button
            disabled={working || saving}
            onClick={() => requestNavigate({ kind: "back" })}
          >
            返回连接
          </button>
        </div>
      )}
      {(error || notice) && (
        <p className="motion-editor-notice" role="alert">
          {error || notice}
        </p>
      )}
      {pending && (
        <MotionGroupDialog title="未保存修改" onClose={() => setPending(null)}>
          <p>当前动作组有未保存修改。保存成功后才会切换。</p>
          <footer>
            <button
              disabled={!!writeReason || working || saving}
              onClick={() => void save(pending)}
            >
              保存并切换
            </button>
            <button disabled={working} onClick={() => navigate(pending, true)}>
              放弃并切换
            </button>
            <button onClick={() => setPending(null)}>继续编辑</button>
          </footer>
        </MotionGroupDialog>
      )}
      {picker && (
        <MotionPosePicker
          key={picker}
          create={picker === "create"}
          sources={sources}
          xml={urdfXml}
          onClose={() => setPicker(null)}
          onChoose={insertPoses}
          onOpenLibrary={
            onOpenPoseLibrary
              ? () => {
                  setPicker(null);
                  onOpenPoseLibrary();
                }
              : undefined
          }
        />
      )}
      <div className="motion-groups-layout">
        <aside className="motion-groups-list" aria-label="动作组和姿态库">
          <h3>动作组</h3>
          <button
            aria-label="新建动作组"
            className="motion-primary"
            disabled={
              !ready ||
              !!error ||
              working ||
              groups.length >= MOTION_GROUP_LIMITS.groups
            }
            onClick={() => requestChoose("new")}
          >
            ＋ 新建动作组
          </button>
          <div className="motion-group-library">
            {groups.map((g) => (
              <button
                key={g.id}
                aria-label={`${g.name} · ${g.steps.length} 帧`}
                aria-pressed={draft?.id === g.id}
                disabled={working}
                onClick={() => requestChoose(g.id)}
              >
                {g.name} · {g.steps.length} 帧
                <small>
                  {groupTracks(g).filter((t) => t.kind === "arm").length}{" "}
                  台机械臂 · {g.actions?.length ?? 0} 个 Action
                </small>
              </button>
            ))}
          </div>
          <h3>
            姿态库 <span>Pose</span>
          </h3>
          <p>添加到选中姿态之后；拖入轨道可插入。</p>
          <div className="motion-pose-library">
            {sources.map((p) => (
              <button
                key={p.id}
                draggable
                disabled={!draft || editingLocked || draft.steps.length >= 100}
                onDragStart={(e) =>
                  e.dataTransfer.setData("application/x-robot-position", p.id)
                }
                onClick={() => {
                  setPicker("insert");
                }}
                aria-label={`选择姿态 ${p.name}`}
              >
                <UrdfPoseThumbnail
                  xml={urdfXml}
                  label={p.name}
                  {...motionPoseThumbnailProps(p.positions, p.gripperPosition)}
                />
                <span>{p.name}</span>
              </button>
            ))}
          </div>
        </aside>
        <MotionDivider
          size="groupListWidth"
          label="调整动作组列表宽度"
          axis="x"
          panel=".motion-groups-list"
          container=".motion-groups-layout"
        />
        <main className="motion-group-editor">
          <header className="motion-groups-header">
            <div>
              <strong>{draft?.name || "创建你的第一个动作组"}</strong>
              <span className="motion-save-state">
                {dirty ? "有未保存修改" : "已保存"}
              </span>
            </div>
            <div className="motion-groups-actions">
              <button
                disabled={
                  !draft ||
                  !!writeReason ||
                  saving ||
                  working ||
                  !dirty ||
                  editingLocked
                }
                onClick={() => void save()}
              >
                保存动作组
              </button>
              <button
                disabled={!history.past.length || working || editingLocked}
                onClick={() =>
                  setGroupEditorHistory((c) => ({
                    ...c,
                    past: c.past.slice(0, -1),
                    present: c.past.at(-1)!,
                    future: c.present ? [c.present, ...c.future] : c.future,
                  }))
                }
              >
                撤销
              </button>
              <button
                disabled={!history.future.length || working || editingLocked}
                onClick={() =>
                  setGroupEditorHistory((c) => ({
                    ...c,
                    past: c.present ? [...c.past, c.present] : c.past,
                    present: c.future[0],
                    future: c.future.slice(1),
                  }))
                }
              >
                重做
              </button>
            </div>
          </header>
          <section className="motion-group-preview" aria-label="本地姿态预览">
            <div className="motion-preview-stage">
              <span className="motion-preview-badge">
                本地预览 · 不下发实机
              </span>
              <div className="motion-preview-models">
                {tracks
                  .filter((t) => t.kind === "arm")
                  .map((track, i) => {
                    const pose = draft
                      ? previewGroupPose(draft, playhead, track.id)
                      : null;
                    return (
                      <div className="motion-preview-model" key={track.id}>
                        <UrdfPoseThumbnail
                          xml={urdfXml}
                          label={
                            i
                              ? `动作组本地预览 ${track.name}`
                              : "动作组本地预览"
                          }
                          {...motionPoseThumbnailProps(
                            pose?.positions,
                            pose?.gripperPosition,
                          )}
                        />
                        <span className="motion-preview-caption">
                          {track.name} ·{" "}
                          {pose
                            ? draft?.steps[pose.index]?.positionName
                            : "未添加 Pose"}
                          {tracks.filter((t) => t.kind === "arm").length > 1
                            ? " · 当前模型示意"
                            : ""}
                        </span>
                      </div>
                    );
                  })}
              </div>
            </div>
            <div className="motion-preview-controls">
              <button
                disabled={!draft?.steps.length || motion.busy}
                onClick={() => {
                  if (playhead >= displayTotal) setPlayhead(0);
                  setPlaying(!playing);
                }}
              >
                {playing ? "暂停预览" : "播放预览"}
              </button>
              <button
                onClick={() => {
                  setPlaying(false);
                  setPlayhead(0);
                }}
              >
                回到开始
              </button>
              <strong>本地预览 · {seconds(playhead)}</strong>
              <input
                aria-label="预览播放头"
                type="range"
                min={0}
                max={Math.max(0.01, displayTotal)}
                step=".01"
                value={Math.min(playhead, displayTotal)}
                onChange={(e) => {
                  setPlaying(false);
                  setPlayhead(Number(e.target.value));
                }}
              />
              <select
                aria-label="预览速度"
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
              >
                <option value={0.5}>0.5×</option>
                <option value={1}>1×</option>
                <option value={2}>2×</option>
              </select>
            </div>
            <p>关节线性插值示意，不代表 MoveIt 规划路径。</p>
          </section>
          <MotionDivider
            size="groupPreviewHeight"
            label="调整动作组预览高度"
            axis="y"
            panel=".motion-group-preview"
            container=".motion-group-editor"
          />
          <section className="motion-timeline-panel" aria-label="动作块时间轴">
            <div className="motion-group-zoom">
              <strong>时间轴</strong>
              <button
                disabled={!draft || editingLocked || draft.steps.length >= 100}
                onClick={() => setPicker("insert")}
              >
                ＋ Pose
              </button>
              <button
                disabled={
                  !selected ||
                  editingLocked ||
                  (draft?.actions?.length ?? 0) >= 100 ||
                  (tracks.length >= 16 &&
                    !tracks.some((t) => t.kind === "camera"))
                }
                onClick={addCapture}
              >
                ＋ Action
              </button>
              <button
                disabled={
                  !draft ||
                  editingLocked ||
                  tracks.filter((t) => t.kind === "arm").length < 2
                }
                title="为不同机械臂的 Pose 添加同步等待点"
                onClick={() => setSyncEditor("new")}
              >
                同步点
              </button>
              <button
                disabled={!draft || editingLocked}
                onClick={() => setTrackEditor(true)}
              >
                设备轨道
              </button>
              <button onClick={() => setZoom((v) => Math.max(0.01, v / 1.5))}>
                缩小
              </button>
              <button onClick={() => setZoom((v) => Math.min(240, v * 1.5))}>
                放大
              </button>
              <button
                onClick={() =>
                  setZoom(
                    Math.max(
                      0.01,
                      Math.min(
                        240,
                        ((scroll.current?.clientWidth || 600) - 280) /
                          Math.max(1, displayTotal),
                      ),
                    ),
                  )
                }
              >
                适应时间轴
              </button>
              <label>
                <input
                  type="checkbox"
                  checked={snap}
                  onChange={(e) => setSnap(e.target.checked)}
                />
                0.1 s 吸附
              </label>
            </div>
            <div
              className="motion-group-timeline-scroll"
              ref={scroll}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const p = sources.find(
                  (s) =>
                    s.id ===
                    e.dataTransfer.getData("application/x-robot-position"),
                );
                if (p && draft && !editingLocked && draft.steps.length < 100)
                  insertPoses("", [p]);
              }}
            >
              <div
                className="motion-group-timeline"
                style={{
                  width: timelineWidth,
                  height: 38 + tracks.length * 88,
                }}
                aria-label="关键帧时间轴"
                onPointerDown={scrub}
              >
                <div className="motion-timeline-ruler">
                  {Array.from({ length: 6 }, (_, i) => (
                    <span
                      key={i}
                      style={{
                        left: 260 + (displayTotal * effectiveZoom * i) / 5,
                      }}
                    >
                      {seconds((displayTotal * i) / 5)}
                    </span>
                  ))}
                </div>
                {tracks.map((track, trackIndex) => (
                  <div
                    className="motion-timeline-track"
                    key={track.id}
                    style={{ top: 34 + trackIndex * 88 }}
                  >
                    <button
                      className="motion-track-label"
                      onClick={() => setTrackEditor(true)}
                    >
                      {track.kind === "camera" ? "▣" : "⌁"} {track.name}
                      <small>
                        {track.deviceId === "current"
                          ? "当前连接"
                          : track.deviceId}
                      </small>
                    </button>
                    {track.kind === "arm" &&
                      rows
                        .filter((r) => (r.step.trackId ?? "arm") === track.id)
                        .map((row) => {
                          const index = draft!.steps.indexOf(row.step);
                          return (
                            <div key={row.step.id}>
                              <button
                                className={`motion-pose-block ${groupActive && motion.state.group?.id === draft?.id && motion.state.group?.index === index ? "running" : ""}`}
                                style={{
                                  left:
                                    index === 0
                                      ? 160
                                      : 260 + row.start * effectiveZoom,
                                  width:
                                    index === 0
                                      ? 100 + row.step.hold * effectiveZoom
                                      : Math.max(
                                          30,
                                          (row.poseDeparture - row.start) *
                                            effectiveZoom,
                                        ),
                                }}
                                aria-label={`关键帧 ${index + 1} ${row.step.positionName}`}
                                aria-pressed={
                                  !selectedAction && selectedStep === index
                                }
                                disabled={editingLocked}
                                draggable={!editingLocked}
                                onDragStart={(e) =>
                                  e.dataTransfer.setData(
                                    "application/x-motion-step",
                                    String(index),
                                  )
                                }
                                onDragOver={(e) => e.preventDefault()}
                                onDrop={(e) => {
                                  const from = e.dataTransfer.getData(
                                    "application/x-motion-step",
                                  );
                                  if (/^\d+$/.test(from)) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    moveStep(Number(from), index);
                                  }
                                }}
                                onClick={() => chooseStep(index)}
                                onKeyDown={(e) => {
                                  if (
                                    index &&
                                    ["ArrowLeft", "ArrowRight"].includes(e.key)
                                  ) {
                                    e.preventDefault();
                                    changeStepAt(
                                      index,
                                      snappedArrival(
                                        row.arrival +
                                          (e.key === "ArrowRight" ? 1 : -1) *
                                            (e.shiftKey ? 1 : 0.1),
                                        row.start,
                                        snap,
                                      ) - row.start,
                                    );
                                  }
                                }}
                              >
                                <strong>Pose · {row.step.positionName}</strong>
                                <span>
                                  {index
                                    ? `移动 ${seconds(row.step.duration)}`
                                    : "首姿态"}{" "}
                                  · 停留 {seconds(row.step.hold)}
                                </span>
                                <i
                                  className="motion-pose-hold-fill"
                                  style={{
                                    width: `${Math.min(100, (row.step.hold / Math.max(0.01, row.poseDeparture - row.start)) * 100)}%`,
                                  }}
                                />
                              </button>
                              {index > 0 && (
                                <button
                                  className="motion-duration-handle"
                                  aria-label={`拖动调整关键帧 ${index + 1} 时长`}
                                  disabled={editingLocked}
                                  style={{
                                    left: 260 + row.arrival * effectiveZoom - 5,
                                  }}
                                  onPointerDown={(e) => startDrag(e, index)}
                                />
                              )}
                            </div>
                          );
                        })}
                    {track.kind === "camera" &&
                      rows.flatMap((row) =>
                        row.actions
                          .filter((a) => a.action.trackId === track.id)
                          .map(({ action: a, start, end }) => (
                            <button
                              key={a.id}
                              className="motion-action-block"
                              style={{
                                left: 260 + start * effectiveZoom,
                                width: Math.max(
                                  32,
                                  (end - start) * effectiveZoom,
                                ),
                              }}
                              aria-label={`Action · ${a.name} · 停稳后采集 · ≤ ${a.timeout} s`}
                              title={`Action · ${a.name} · 采集超时 ${a.timeout} s`}
                              aria-pressed={selectedActionId === a.id}
                              onClick={() => {
                                setSelectedActionId(a.id);
                                setSelectedStep(
                                  draft!.steps.findIndex(
                                    (s) => s.id === a.afterStepId,
                                  ),
                                );
                                setPlayhead(start);
                                setPlaying(false);
                              }}
                            >
                              <strong>▣ {a.name}</strong>
                              <span>停稳后采集 · ≤ {a.timeout} s</span>
                            </button>
                          )),
                      )}
                  </div>
                ))}
                {rows.flatMap((row) =>
                  row.actions.map(({ action: a, start }) => {
                    const from = tracks.findIndex(
                      (t) => t.id === (row.step.trackId ?? "arm"),
                    );
                    const to = tracks.findIndex((t) => t.id === a.trackId);
                    return (
                      <div
                        key={`dependency-${a.id}`}
                        className={`motion-action-dependency${to < from ? " reverse" : ""}`}
                        aria-label={`${row.step.positionName} 完成后执行 ${a.name}`}
                        style={{
                          left: 260 + start * effectiveZoom,
                          top: 34 + Math.min(from, to) * 88 + 73,
                          height: Math.max(12, Math.abs(to - from) * 88 - 61),
                        }}
                      />
                    );
                  }),
                )}
                {draft?.syncPoints?.map((point) => {
                  const at = Math.max(
                    0,
                    ...rows
                      .filter((row) => point.afterStepIds.includes(row.step.id))
                      .map((row) => row.poseDeparture),
                  );
                  return (
                    <button
                      key={point.id}
                      className="motion-sync-marker"
                      aria-label={`同步点 ${point.name}`}
                      title={`${point.name} · 等待 ${point.afterStepIds.length} 个机械臂 Pose 完成`}
                      style={{ left: 260 + at * effectiveZoom }}
                      disabled={editingLocked}
                      onClick={() => setSyncEditor(point.id)}
                    >
                      <span>{point.name}</span>
                    </button>
                  );
                })}
                <div
                  className="motion-group-playhead"
                  style={{ left: 260 + playhead * effectiveZoom }}
                />
              </div>
            </div>
            <div className="motion-timeline-summary">
              <span>
                编排 {seconds(total)}
                {draft?.actions?.length ? "（含 Action 超时预算）" : ""} ＋
                首姿态准备 {seconds(draft?.preparationDuration ?? 0)}
              </span>
              <span>实际耗时包含规划与停稳</span>
            </div>
          </section>
        </main>
        <MotionDivider
          size="groupPropertiesWidth"
          label="调整关键帧属性宽度"
          axis="x"
          edge="end"
          panel=".motion-group-properties"
          container=".motion-groups-layout"
          className="motion-group-properties-divider"
        />
        <MotionDivider
          size="groupPropertiesHeight"
          label="调整关键帧属性高度"
          axis="y"
          edge="end"
          panel=".motion-group-properties"
          container=".motion-groups-layout"
          className="motion-group-properties-height-divider"
        />
        <aside className="motion-group-properties" aria-label="动作组属性">
          {draft && (
            <>
              <fieldset disabled={editingLocked}>
                {selectedAction ? (
                  <>
                    <h3>▣ Action · {selectedAction.name}</h3>
                    <p>相机采集 · 完成后继续</p>
                    <label>
                      动作名称
                      <input
                        value={selectedAction.name}
                        onChange={(e) => editCapture({ name: e.target.value })}
                      />
                    </label>
                    <label>
                      执行设备
                      <select
                        value={selectedAction.trackId}
                        onChange={(e) =>
                          editCapture({ trackId: e.target.value })
                        }
                      >
                        {tracks
                          .filter((t) => t.kind === "camera")
                          .map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      图像 Topic
                      <input
                        value={selectedAction.topic}
                        onChange={(e) => editCapture({ topic: e.target.value })}
                      />
                    </label>
                    <label>
                      依赖 Pose
                      <select
                        value={selectedAction.afterStepId}
                        onChange={(e) =>
                          editCapture({ afterStepId: e.target.value })
                        }
                      >
                        {draft.steps.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.positionName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p>
                      触发：Pose 到达、停稳并完成停留
                      <br />
                      完成：有效图像及关联反馈保存成功
                    </p>
                    <label>
                      采集超时 (s)
                      <input
                        type="number"
                        min=".1"
                        max="60"
                        step=".1"
                        value={fieldValue(selectedAction.timeout)}
                        onChange={(e) =>
                          editCapture({ timeout: numberValue(e.target.value) })
                        }
                      />
                    </label>
                    <p>图像保存在 Jetson；超时或失败阻止后续动作。</p>
                    <button
                      onClick={() => {
                        edit((g) => ({
                          ...g,
                          actions: g.actions?.filter(
                            (a) => a.id !== selectedAction.id,
                          ),
                        }));
                        setSelectedActionId(null);
                      }}
                    >
                      删除 Action
                    </button>
                  </>
                ) : selected ? (
                  <>
                    <h3>Pose · {selected.positionName}</h3>
                    <UrdfPoseThumbnail
                      xml={urdfXml}
                      label={selected.positionName}
                      {...motionPoseThumbnailProps(
                        selected.positions,
                        selected.gripperPosition,
                      )}
                    />
                    <label>
                      机械臂轨道
                      <select
                        value={selected.trackId ?? "arm"}
                        onChange={(e) =>
                          edit((g) => {
                            g.steps[selectedStep].trackId = e.target.value;
                            return g;
                          })
                        }
                      >
                        {tracks
                          .filter((t) => t.kind === "arm")
                          .map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      运动时长 (s)
                      <input
                        type="number"
                        min="0"
                        step=".1"
                        disabled={selectedStep === 0}
                        value={fieldValue(selected.duration)}
                        onChange={(e) =>
                          changeStep("duration", numberValue(e.target.value))
                        }
                      />
                    </label>
                    <label>
                      停留时长 (s)
                      <input
                        type="number"
                        min="0"
                        step=".1"
                        value={fieldValue(selected.hold)}
                        onChange={(e) =>
                          changeStep("hold", numberValue(e.target.value))
                        }
                      />
                    </label>
                    <div className="motion-step-actions">
                      <button
                        aria-label={`上移关键帧 ${selectedStep + 1}`}
                        disabled={!selectedStep}
                        onClick={() => moveStep(selectedStep, selectedStep - 1)}
                      >
                        上移
                      </button>
                      <button
                        aria-label={`下移关键帧 ${selectedStep + 1}`}
                        disabled={selectedStep === rows.length - 1}
                        onClick={() => moveStep(selectedStep, selectedStep + 1)}
                      >
                        下移
                      </button>
                      <button onClick={() => removeStep(selectedStep)}>
                        删除 Pose
                      </button>
                    </div>
                    <details open>
                      <summary>姿态快照</summary>
                      <p>{stepStatus}</p>
                      <button
                        disabled={
                          !source || !sourceSnapshotChanged(selected, source)
                        }
                        onClick={() =>
                          source &&
                          edit((g) => {
                            g.steps[selectedStep] = {
                              ...snapshotStep(
                                source,
                                selected.id,
                                selected.duration,
                              ),
                              hold: selected.hold,
                              ...(selected.trackId
                                ? { trackId: selected.trackId }
                                : {}),
                            };
                            return g;
                          })
                        }
                      >
                        刷新来源快照
                      </button>
                      <p>
                        关节快照：
                        {selected.positions.map((v) => v.toFixed(3)).join(", ")}
                      </p>
                      <p>
                        夹爪：
                        {selected.gripperPosition === undefined
                          ? "未指定，保持现有目标"
                          : selected.gripperPosition.toFixed(4)}
                      </p>
                    </details>
                  </>
                ) : (
                  <p>选择 Pose 或 Action 查看属性。</p>
                )}
                <details className="motion-group-settings" open>
                  <summary>动作组设置</summary>
                  <label>
                    动作组名称
                    <input
                      value={draft.name}
                      onChange={(e) =>
                        edit((g) => ({ ...g, name: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    备注
                    <textarea
                      value={draft.note}
                      maxLength={4000}
                      onChange={(e) =>
                        edit((g) => ({ ...g, note: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    首帧准备时长 (s)
                    <input
                      type="number"
                      min=".01"
                      step=".1"
                      value={fieldValue(draft.preparationDuration)}
                      onChange={(e) =>
                        edit((g) => ({
                          ...g,
                          preparationDuration: numberValue(e.target.value),
                        }))
                      }
                    />
                  </label>
                  <p>从实机当前位置移动到首姿态，独立于编排时间轴。</p>
                  <button
                    disabled={working}
                    onClick={() => {
                      const now = Date.now();
                      const copy = cloneMotionGroup({
                        ...draft,
                        id: id(),
                        name: `${draft.name} 副本`,
                        createdAt: now,
                        updatedAt: now,
                      });
                      setGroupEditorHistory({
                        past: [],
                        present: copy,
                        future: [],
                        base: "",
                      });
                    }}
                  >
                    复制动作组
                  </button>
                  <button
                    disabled={
                      !ready ||
                      !!error ||
                      working ||
                      saving ||
                      !groups.some((g) => g.id === draft.id)
                    }
                    onClick={() => setDeleting(true)}
                  >
                    删除动作组
                  </button>
                </details>
              </fieldset>
              {(validation || duplicate) && (
                <p role="status">{duplicate ? "动作组名称重复" : validation}</p>
              )}
              {editingLocked && (
                <p role="status">正在执行固定快照，本动作组暂时锁定编辑。</p>
              )}
            </>
          )}
          {captureResult && (
            <section className="motion-capture-result">
              <h3>最近采集 · {captureResult.name}</h3>
              {captureResult.thumbnail && (
                <img
                  src={`data:image/png;base64,${captureResult.thumbnail}`}
                  alt="最近采集图像"
                />
              )}
              <p>{captureResult.path}</p>
              <small>
                图像时间：{captureResult.imageStamp} · 关联反馈：
                {captureResult.jointStamp}
              </small>
            </section>
          )}
        </aside>
      </div>
      {deleting && draft && (
        <MotionGroupDialog
          title="删除动作组"
          onClose={() => setDeleting(false)}
        >
          <p>确认删除 {draft.name}？</p>
          <footer>
            <button
              disabled={working}
              onClick={() =>
                void action(async () => {
                  await onDelete(draft.id);
                  if (live.current) {
                    setGroupEditorHistory(empty());
                    setDeleting(false);
                    setNotice("动作组已删除");
                  }
                })
              }
            >
              确认删除动作组
            </button>
            <button onClick={() => setDeleting(false)}>保留动作组</button>
          </footer>
        </MotionGroupDialog>
      )}
      {trackEditor && draft && (
        <MotionGroupDialog
          title="设备轨道"
          onClose={() => setTrackEditor(false)}
        >
          <p>
            当前 Bridge
            执行绑定当前连接。多机械臂轨道可编排，协同执行需要后续调度支持。
          </p>
          {tracks.map((t) => (
            <fieldset key={t.id} disabled={editingLocked}>
              <label>
                轨道名称
                <input
                  value={t.name}
                  onChange={(e) =>
                    edit((g) => ({
                      ...g,
                      tracks: tracks.map((x) =>
                        x.id === t.id ? { ...x, name: e.target.value } : x,
                      ),
                    }))
                  }
                />
              </label>
              <label>
                设备绑定
                <input
                  value={t.deviceId}
                  onChange={(e) =>
                    edit((g) => ({
                      ...g,
                      tracks: tracks.map((x) =>
                        x.id === t.id ? { ...x, deviceId: e.target.value } : x,
                      ),
                    }))
                  }
                />
              </label>
              <small>
                {t.kind === "arm" ? "机械臂" : "相机"} · current 表示当前连接
              </small>
              <button
                disabled={
                  draft.steps.some((s) => (s.trackId ?? "arm") === t.id) ||
                  draft.actions?.some((a) => a.trackId === t.id) ||
                  (t.kind === "arm" &&
                    tracks.filter((x) => x.kind === "arm").length <= 1)
                }
                onClick={() =>
                  edit((g) => ({
                    ...g,
                    tracks: tracks.filter((x) => x.id !== t.id),
                  }))
                }
              >
                删除空轨道
              </button>
            </fieldset>
          ))}
          <footer>
            <button
              disabled={editingLocked || tracks.length >= 16}
              onClick={() =>
                edit((g) => ({
                  ...g,
                  tracks: [
                    ...tracks,
                    {
                      id: id(),
                      kind: "arm",
                      name: `机械臂 ${tracks.filter((t) => t.kind === "arm").length + 1}`,
                      deviceId: "unbound",
                    },
                  ],
                }))
              }
            >
              添加机械臂轨道
            </button>
            <button onClick={() => setTrackEditor(false)}>完成</button>
          </footer>
        </MotionGroupDialog>
      )}
      {syncEditor && draft && (
        <MotionSyncEditor
          key={syncEditor}
          group={draft}
          point={draft.syncPoints?.find((p) => p.id === syncEditor)}
          onClose={() => setSyncEditor(null)}
          onSave={(point) => {
            edit((g) => ({
              ...g,
              syncPoints: [
                ...(g.syncPoints ?? []).filter((p) => p.id !== point.id),
                point,
              ],
            }));
            setSyncEditor(null);
          }}
          onDelete={
            syncEditor === "new"
              ? undefined
              : () => {
                  edit((g) => ({
                    ...g,
                    syncPoints: g.syncPoints?.filter(
                      (p) => p.id !== syncEditor,
                    ),
                  }));
                  setSyncEditor(null);
                }
          }
        />
      )}
      {review && draft && (
        <MotionGroupDialog title="执行前检查" onClose={closeReview}>
          <h3>{draft.name}</h3>
          <p>
            {draft.steps.length} 个 Pose · {draft.actions?.length ?? 0} 个
            Action · 准备 {seconds(draft.preparationDuration)}
          </p>
          <p>
            {dirty
              ? "当前编辑稿尚未保存；执行使用点击时的独立快照。"
              : "执行当前已保存动作组的独立快照。"}
          </p>
          <p>
            先准备到首姿态，再逐段规划、执行、停稳和采集。实际耗时包含规划与停稳。
          </p>
          <p role="status">{executeReason || "执行条件已就绪"}</p>
          <label className="motion-safety-check">
            <input
              type="checkbox"
              checked={motion.armed}
              onChange={(e) => motion.setArmed(e.target.checked)}
            />
            已确认工作区安全，允许机械臂及夹爪运动
          </label>
          <footer>
            <button onClick={closeReview}>返回编辑</button>
            {dirty && (
              <button
                disabled={!!executeReason || !!writeReason || working || saving}
                onClick={() => void executeSnapshot(true)}
              >
                保存并执行
              </button>
            )}
            <button
              className="motion-primary"
              disabled={!!executeReason || working}
              onClick={() => void executeSnapshot(false)}
            >
              {dirty ? "执行当前未保存快照" : "确认并执行"}
            </button>
          </footer>
        </MotionGroupDialog>
      )}
      <footer className="motion-group-execution">
        {resultState && (
          <div className={`motion-group-result-summary result-${resultState.phase}`}>
            <strong title={running?.name || resultState.label || resultState.group?.id}>
              最近执行：{running?.name || resultState.label || resultState.group?.id} · {motionGroupPhaseLabels[resultState.phase]}
            </strong>
            {openReport && <button type="button" onClick={openReport}>查看执行报告</button>}
          </div>
        )}
        <label className="motion-safety-check">
          <input
            type="checkbox"
            checked={motion.armed}
            disabled={motion.busy}
            onChange={(e) => motion.setArmed(e.target.checked)}
          />
          已确认工作区安全，允许机械臂及夹爪运动
        </label>
        <button
          className="motion-primary"
          disabled={
            !draft ||
            !!validation ||
            !!error ||
            !ready ||
            working ||
            motion.busy ||
            motion.groupActionBusy
          }
          onClick={() => setReview(true)}
        >
          执行前检查
        </button>
        {executeReason && (
          <span className="motion-execute-reason">{executeReason}</span>
        )}
        {groupActive && (
          <>
            <button
              disabled={
                !motion.pauseGroup ||
                motion.state.phase === "paused" ||
                motion.groupActionBusy ||
                working
              }
              onClick={() => void action(motion.pauseGroup)}
            >
              预约段间暂停
            </button>
            <button
              disabled={
                !motion.resumeGroup ||
                motion.state.phase !== "paused" ||
                motion.groupActionBusy ||
                working
              }
              onClick={() => void action(motion.resumeGroup)}
            >
              恢复执行
            </button>
            <button
              className="motion-stop"
              onClick={() =>
                void motion.cancel().catch((c) => setNotice(String(c)))
              }
            >
              停止动作组
            </button>
          </>
        )}
      </footer>
    </section>
  );
  function changeStepAt(index: number, duration: number) {
    edit((g) => {
      g.steps[index].duration = duration;
      return g;
    });
  }
}
/** Keep each profile's unsaved draft separate and fence late save responses on profile changes. */
export function MotionGroupsPage(props: MotionGroupsPageProps) {
  const drafts = useRef(new Map<string, GroupEditorHistory>());
  const remember = (history: GroupEditorHistory) => {
    drafts.current.set(props.profileKey, history);
  };
  return (
    <Editor
      key={props.profileKey}
      {...props}
      cached={drafts.current.get(props.profileKey)}
      remember={remember}
    />
  );
}
