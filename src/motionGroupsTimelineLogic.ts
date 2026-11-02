import type { MotionGroup, MotionGroupStep } from "./motionGroupsLogic";
export const GROUP_HISTORY_LIMIT = 50;
export function cloneMotionGroup(group: MotionGroup): MotionGroup {
  return {
    ...group,
    steps: group.steps.map((step) => ({
      ...step,
      positions: [...step.positions],
    })),
  };
}
export function editorTimeline(group: MotionGroup) {
  let end = 0;
  return group.steps.map((step, index) => {
    const start = end;
    const arrival =
      start +
      (index > 0 && Number.isFinite(step.duration)
        ? Math.max(0, step.duration)
        : 0);
    end = arrival + (Number.isFinite(step.hold) ? Math.max(0, step.hold) : 0);
    return { step, start, arrival, departure: end };
  });
}
export function reorderGroupStep(
  group: MotionGroup,
  from: number,
  to: number,
): MotionGroup {
  const copy = cloneMotionGroup(group);
  if (
    from < 0 ||
    to < 0 ||
    from >= copy.steps.length ||
    to >= copy.steps.length
  )
    return copy;
  const [step] = copy.steps.splice(from, 1);
  copy.steps.splice(to, 0, step);
  copy.steps = copy.steps.map((s, i) => ({
    ...s,
    duration: i === 0 ? 0 : s.duration > 0 ? s.duration : 5,
  }));
  return copy;
}
export function snappedArrival(
  value: number,
  previousDeparture: number,
  snap: boolean,
): number {
  const target = snap ? Math.round(value * 10) / 10 : value;
  return Math.max(previousDeparture + 0.01, Math.min(604800, target));
}
/** This is a local linear pose illustration, never a planned robot trajectory. */
export function previewGroupPose(
  group: MotionGroup,
  time: number,
): { positions: number[]; gripperPosition?: number; index: number } | null {
  if (!group.steps.length || !Number.isFinite(time)) return null;
  const rows = editorTimeline(group);
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index],
      previous = rows[Math.max(0, index - 1)].step;
    if (time > row.departure && index < rows.length - 1) continue;
    const fraction =
      index === 0 || time >= row.arrival || row.arrival === row.start
        ? 1
        : Math.max(
            0,
            Math.min(1, (time - row.start) / (row.arrival - row.start)),
          );
    const positions = row.step.positions.map(
      (value, i) =>
        previous.positions[i] + (value - previous.positions[i]) * fraction,
    );
    if (!positions.every(Number.isFinite)) return null;
    let gripperPosition = row.step.gripperPosition;
    if (previous.gripperPosition !== undefined && gripperPosition !== undefined)
      gripperPosition =
        previous.gripperPosition +
        (gripperPosition - previous.gripperPosition) * fraction;
    else if (fraction < 1) gripperPosition = previous.gripperPosition;
    return {
      positions,
      ...(gripperPosition === undefined ? {} : { gripperPosition }),
      index,
    };
  }
  return null;
}
export function sourceSnapshotChanged(
  step: MotionGroupStep,
  source: {
    name: string;
    updatedAt: number;
    positions: number[];
    gripperPosition?: number;
  },
): boolean {
  return (
    step.positionName !== source.name ||
    step.positionUpdatedAt !== source.updatedAt ||
    step.gripperPosition !== source.gripperPosition ||
    step.positions.some((value, i) => value !== source.positions[i])
  );
}
