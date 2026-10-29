export type JointError = {
  perJoint: Array<{ name: string; delta: number }>;
  maxAbsRad: number;
};

export function jointExecutionError(targetNames: string[], targetPositions: number[], actualNames: string[], actualPositions: number[]) {
  if (targetNames.length === 0 || targetNames.length !== targetPositions.length || actualNames.length !== actualPositions.length) {
    return { error: "关节反馈不完整" };
  }
  const actual = new Map(actualNames.map((name, index) => [name, actualPositions[index]]));
  const perJoint = targetNames.map((name, index) => {
    const measured = actual.get(name);
    return { name, delta: measured === undefined ? Number.NaN : measured - targetPositions[index] };
  });
  if (perJoint.some((item) => !Number.isFinite(item.delta))) return { error: "关节反馈不完整" };
  return {
    perJoint,
    maxAbsRad: Math.max(...perJoint.map((item) => Math.abs(item.delta))),
  } satisfies JointError;
}

export function tcpExecutionError(
  targetPositionM: [number, number, number],
  targetQuaternion: [number, number, number, number],
  actualPositionM: [number, number, number],
  actualQuaternion: [number, number, number, number],
) {
  const positionMm = Math.hypot(
    actualPositionM[0] - targetPositionM[0],
    actualPositionM[1] - targetPositionM[1],
    actualPositionM[2] - targetPositionM[2],
  ) * 1000;
  const dot = Math.abs(
    targetQuaternion[0] * actualQuaternion[0]
    + targetQuaternion[1] * actualQuaternion[1]
    + targetQuaternion[2] * actualQuaternion[2]
    + targetQuaternion[3] * actualQuaternion[3],
  );
  const orientationDeg = 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI;
  return { positionMm, orientationDeg };
}
