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
import { MotionGroupResult, motionGroupPhaseLabels } from "./MotionGroupResult";

export type MotionGroupsPageProps = {
  profileKey: string;
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
        holdFailure: state.holdFailure ? { ...state.holdFailure, samples: state.holdFailure.samples.map((sample) => ({ ...sample })) } : undefined,
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
  const resultAnchor = useRef<HTMLDivElement>(null);
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
    if (layout && !layout.active) dragCleanup.current?.();
  }, [layout?.active]);
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
  const selected = draft?.steps[selectedStep],
    preview = draft ? previewGroupPose(draft, playhead) : null;
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
  function add(position: CustomPosition) {
    if (!draft || draft.steps.length >= MOTION_GROUP_LIMITS.steps) return;
    edit((group) => ({
      ...group,
      steps: [
        ...group.steps,
        snapshotStep(position, id(), group.steps.length ? 5 : 0),
      ],
    }));
    setSelectedStep(draft.steps.length);
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
    if (!draft || index === 0 || event.button !== 0) return;
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
          Math.min(displayTotal, (clientX - bounds.left - 40) / effectiveZoom),
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
  const timelineWidth = Math.max(
    320,
    Math.min(500000, displayTotal * effectiveZoom + 100),
  );
  return (
    <section
      className="motion-groups-editor"
      aria-label="动作组编辑器"
      data-profile={profileKey}
    >
      <header className="motion-groups-header">
        {onBack && (
          <button
            disabled={working || saving}
            onClick={() => requestNavigate({ kind: "back" })}
          >
            返回连接
          </button>
        )}
        <strong>动作组时间轴</strong>
        <span>{dirty ? "有未保存修改" : "已保存"}</span>
        <div className="motion-groups-actions">
          <button
            disabled={
              !ready ||
              !!error ||
              groups.length >= MOTION_GROUP_LIMITS.groups ||
              working
            }
            onClick={() => requestChoose("new")}
          >
            新建动作组
          </button>
          <button
            disabled={!draft || !!writeReason || saving || working || !dirty}
            onClick={() => void save()}
          >
            保存动作组
          </button>
          <button
            disabled={!history.past.length || working}
            onClick={() =>
              setGroupEditorHistory((current) => ({
                ...current,
                past: current.past.slice(0, -1),
                present: current.past.at(-1)!,
                future: current.present
                  ? [current.present, ...current.future]
                  : current.future,
              }))
            }
          >
            撤销
          </button>
          <button
            disabled={!history.future.length || working}
            onClick={() =>
              setGroupEditorHistory((current) => ({
                ...current,
                past: current.present
                  ? [...current.past, current.present]
                  : current.past,
                present: current.future[0],
                future: current.future.slice(1),
              }))
            }
          >
            重做
          </button>
        </div>
      </header>
      {resultState && (
        <div ref={resultAnchor} className="motion-group-result-anchor">
          <MotionGroupResult state={resultState} snapshot={running} />
        </div>
      )}
      {(error || notice) && <p role="alert">{error || notice}</p>}
      {pending !== null && (
        <div
          className="motion-group-confirm"
          role="dialog"
          aria-label="未保存修改"
        >
          <p>当前动作组有未保存修改。保存成功后才会切换。</p>
          <button
            disabled={!!writeReason || working || saving}
            onClick={() => void save(pending)}
          >
            保存并切换
          </button>
          <button disabled={working} onClick={() => navigate(pending, true)}>
            放弃并切换
          </button>
          <button disabled={working} onClick={() => setPending(null)}>
            继续编辑
          </button>
        </div>
      )}
      <div className="motion-groups-layout">
        <aside className="motion-groups-list" aria-label="动作组和位置">
          <h3>动作组</h3>
          {groups.map((group) => (
            <button
              key={group.id}
              aria-pressed={draft?.id === group.id}
              disabled={working}
              onClick={() => requestChoose(group.id)}
            >
              {group.name} · {group.steps.length} 帧
            </button>
          ))}
          <h3>位置快照</h3>
          <p>点击添加，或拖入时间轴；不会跟随来源自动变化。</p>
          {sources.map((position) => (
            <button
              key={position.id}
              draggable
              disabled={
                !draft || draft.steps.length >= MOTION_GROUP_LIMITS.steps
              }
              onDragStart={(event) =>
                event.dataTransfer.setData(
                  "application/x-robot-position",
                  position.id,
                )
              }
              onClick={() => add(position)}
            >
              添加 {position.name}
            </button>
          ))}
        </aside>
        <MotionDivider
          size="groupListWidth"
          label="调整动作组列表宽度"
          axis="x"
          panel=".motion-groups-list"
          container=".motion-groups-layout"
        />
        <main className="motion-group-editor">
          <div className="motion-group-zoom">
            <button
              onClick={() => setZoom((value) => Math.max(0.01, value / 1.5))}
            >
              缩小
            </button>
            <button
              onClick={() => setZoom((value) => Math.min(240, value * 1.5))}
            >
              放大
            </button>
            <button
              onClick={() =>
                setZoom(
                  Math.max(
                    0.0001,
                    Math.min(
                      240,
                      ((scroll.current?.clientWidth || 600) - 100) /
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
                onChange={(event) => setSnap(event.target.checked)}
              />
              0.1 s 吸附
            </label>
            <span>名义 {seconds(total)}</span>
          </div>
          <p>
            首帧 A
            的准备单独配置；时间轴仅计运动和停留，不含准备、规划、停稳及暂停。
          </p>
          <div
            ref={scroll}
            className="motion-group-timeline-scroll"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const position = sources.find(
                (item) =>
                  item.id ===
                  event.dataTransfer.getData("application/x-robot-position"),
              );
              if (position) add(position);
            }}
          >
            <div
              className="motion-group-timeline"
              style={{ width: timelineWidth }}
              aria-label="关键帧时间轴"
              onPointerDown={scrub}
            >
              {Array.from({ length: 11 }, (_, index) => (
                <span
                  className="motion-group-tick"
                  style={{
                    left: 40 + (displayTotal * effectiveZoom * index) / 10,
                  }}
                  key={index}
                >
                  {seconds((displayTotal * index) / 10)}
                </span>
              ))}
              {rows.map((row, index) => (
                <div key={row.step.id}>
                  <div
                    className="motion-group-transition"
                    style={{
                      left: 40 + row.start * effectiveZoom,
                      width: Math.max(
                        1,
                        (row.arrival - row.start) * effectiveZoom,
                      ),
                    }}
                  />
                  <div
                    className="motion-group-hold"
                    style={{
                      left: 40 + row.arrival * effectiveZoom,
                      width: Math.max(1, row.step.hold * effectiveZoom),
                    }}
                  />
                  <button
                    className="motion-group-keyframe"
                    style={{ left: 40 + row.arrival * effectiveZoom }}
                    aria-label={`关键帧 ${index + 1} ${row.step.positionName}`}
                    aria-pressed={selectedStep === index}
                    onClick={() => {
                      setSelectedStep(index);
                      setPlayhead(row.arrival);
                    }}
                    onPointerDown={(event) => startDrag(event, index)}
                    onKeyDown={(event) => {
                      if (
                        index &&
                        ["ArrowLeft", "ArrowRight"].includes(event.key)
                      ) {
                        event.preventDefault();
                        edit((group) => {
                          group.steps[index].duration =
                            snappedArrival(
                              row.arrival +
                                (event.key === "ArrowRight" ? 1 : -1) *
                                  (event.shiftKey ? 1 : 0.1),
                              row.start,
                              snap,
                            ) - row.start;
                          return group;
                        });
                      }
                    }}
                  >
                    <b>{index + 1}</b>
                    <small>{row.step.positionName}</small>
                  </button>
                </div>
              ))}
              <div
                className="motion-group-playhead"
                style={{ left: 40 + playhead * effectiveZoom }}
              />
            </div>
          </div>
          <ol className="motion-group-steps">
            {rows.map((row, index) => (
              <li
                key={row.step.id}
                draggable
                onDragStart={(event) =>
                  event.dataTransfer.setData(
                    "application/x-motion-step",
                    String(index),
                  )
                }
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  const from = event.dataTransfer.getData(
                    "application/x-motion-step",
                  );
                  if (/^\d+$/.test(from)) moveStep(Number(from), index);
                }}
                className={
                  groupActive &&
                  motion.state.group?.id === draft?.id &&
                  motion.state.group?.index === index
                    ? "running"
                    : ""
                }
              >
                <button
                  onClick={() => {
                    setSelectedStep(index);
                    setPlayhead(row.arrival);
                  }}
                >
                  {index + 1}. {row.step.positionName} · 到达{" "}
                  {seconds(row.arrival)} · 离开 {seconds(row.departure)}
                </button>
                <button
                  aria-label={`上移关键帧 ${index + 1}`}
                  disabled={!index}
                  onClick={() => moveStep(index, index - 1)}
                >
                  ↑
                </button>
                <button
                  aria-label={`下移关键帧 ${index + 1}`}
                  disabled={index === rows.length - 1}
                  onClick={() => moveStep(index, index + 1)}
                >
                  ↓
                </button>
                <button
                  aria-label={`删除关键帧 ${index + 1}`}
                  onClick={() => {
                    edit((group) => ({
                      ...group,
                      steps: group.steps
                        .filter((_, i) => i !== index)
                        .map((step, i) => ({
                          ...step,
                          duration: i ? step.duration : 0,
                        })),
                    }));
                    setSelectedStep(Math.max(0, index - 1));
                  }}
                >
                  删除
                </button>
              </li>
            ))}
          </ol>
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
              <label>
                动作组名称
                <input
                  value={draft.name}
                  onChange={(event) =>
                    edit((group) => ({ ...group, name: event.target.value }))
                  }
                />
              </label>
              <label>
                备注
                <textarea
                  value={draft.note}
                  maxLength={4000}
                  onChange={(event) =>
                    edit((group) => ({ ...group, note: event.target.value }))
                  }
                />
              </label>
              <label>
                首帧准备时长 (s)
                <input
                  type="number"
                  min="0.01"
                  step="0.1"
                  value={fieldValue(draft.preparationDuration)}
                  onChange={(event) =>
                    edit((group) => ({
                      ...group,
                      preparationDuration: numberValue(event.target.value),
                    }))
                  }
                />
              </label>
              {selected && (
                <>
                  <h3>
                    关键帧 {selectedStep + 1} · {selected.positionName}
                  </h3>
                  <p>{stepStatus}</p>
                  <button
                    disabled={
                      !source || !sourceSnapshotChanged(selected, source)
                    }
                    onClick={() =>
                      source &&
                      edit((group) => {
                        group.steps[selectedStep] = {
                          ...snapshotStep(
                            source,
                            selected.id,
                            selected.duration,
                          ),
                          hold: selected.hold,
                        };
                        return group;
                      })
                    }
                  >
                    刷新来源快照
                  </button>
                  <label>
                    运动时长 (s)
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      disabled={selectedStep === 0}
                      value={fieldValue(selected.duration)}
                      onChange={(event) =>
                        changeStep("duration", numberValue(event.target.value))
                      }
                    />
                  </label>
                  <label>
                    停留时长 (s)
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={fieldValue(selected.hold)}
                      onChange={(event) =>
                        changeStep("hold", numberValue(event.target.value))
                      }
                    />
                  </label>
                  <p>
                    关节快照：
                    {selected.positions
                      .map((value) => value.toFixed(3))
                      .join(", ")}
                  </p>
                  <p>
                    夹爪：
                    {selected.gripperPosition === undefined
                      ? "未指定，保持现有目标"
                      : selected.gripperPosition.toFixed(4)}
                  </p>
                </>
              )}
              {validation && <p role="status">{validation}</p>}
              <button
                disabled={
                  !ready ||
                  !!error ||
                  working ||
                  saving ||
                  !groups.some((group) => group.id === draft.id) ||
                  (groupActive && motion.state.group?.id === draft.id)
                }
                onClick={() => setDeleting(true)}
              >
                删除动作组
              </button>
              {deleting && (
                <div className="motion-group-confirm">
                  <p>确认删除 {draft.name}？</p>
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
                </div>
              )}
            </>
          )}
        </aside>
      </div>
      <MotionDivider
        size="groupPreviewHeight"
        label="调整动作组预览高度"
        axis="y"
        edge="end"
        panel=".motion-group-preview"
        container=".motion-groups-editor"
      />
      <section className="motion-group-preview" aria-label="本地姿态预览">
        <UrdfPoseThumbnail
          xml={urdfXml}
          label="动作组本地预览"
          jointNames={[...ARM_JOINT_NAMES]}
          positions={preview?.positions}
        />
        <div>
          <strong>本地预览 · {seconds(playhead)}</strong>
          <label>
            预览播放头
            <input
              aria-label="预览播放头"
              type="range"
              min={0}
              max={Math.max(0.01, displayTotal)}
              step="0.01"
              value={Math.min(playhead, displayTotal)}
              onChange={(event) => setPlayhead(Number(event.target.value))}
            />
          </label>
          <p>拖动仅预览关节线性插值，不代表 MoveIt 路径，不发送机器人指令。</p>
          <p>
            {preview?.positions.map((value) => value.toFixed(3)).join(", ")}
          </p>
        </div>
      </section>
      <footer className="motion-group-execution">
        {resultState && (
          <div
            className={`motion-group-result-summary result-${resultState.phase}`}
          >
            <strong>
              最近执行的「
              {running?.name || resultState.label || resultState.group?.id}
              」动作组 · {motionGroupPhaseLabels[resultState.phase]}
            </strong>
            <span>{resultState.message || "当前任务未提供详细原因"}</span>
            <button
              onClick={() =>
                resultAnchor.current?.scrollIntoView?.({
                  block: "start",
                  behavior: "smooth",
                })
              }
            >
              查看详细结果
            </button>
          </div>
        )}
        <label>
          <input
            type="checkbox"
            checked={motion.armed}
            onChange={(event) => motion.setArmed(event.target.checked)}
          />
          已确认工作区安全，允许机械臂及夹爪运动
        </label>
        <button
          disabled={!!executeReason || working || motion.groupActionBusy}
          title={executeReason}
          onClick={() => {
            if (!draft || executeReason) return;
            const copy = cloneMotionGroup(draft);
            pendingSnapshot.current = copy;
            void action(() => motion.executeGroup!(copy));
          }}
        >
          执行{dirty ? "当前未保存快照" : "动作组"}
        </button>
        {executeReason && <span>{executeReason}</span>}
        {groupActive && (
          <>
            <span>
              本会话动作组执行中；名义时长{" "}
              {running
                ? seconds(editorTimeline(running).at(-1)?.departure ?? 0)
                : "未提供"}
            </span>
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
              onClick={() =>
                void motion.cancel().catch((cause) => setNotice(String(cause)))
              }
            >
              停止动作组
            </button>
          </>
        )}
      </footer>
    </section>
  );
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
