export type MotionControlInfo =
  | { state: "idle" }
  | {
    state: "settled";
    label: string;
    outcome: "done" | "failed";
    maxAbsJointRad: number;
    tcpPositionMm: number;
    tcpOrientationDeg: number;
    perJoint: Array<{ name: string; deltaRad: number }>;
  };

export function MotionControlPanel({ info }: { info: MotionControlInfo }) {
  return (
    <section className="motion-control-panel" aria-label="运动控制">
      <strong>运动控制</strong>
      {info.state === "idle" ? <p>无运动</p> : (
        <>
          <p>{info.label}</p>
          <p>{info.outcome === "done" ? "完成" : "失败"}</p>
          <p>{info.maxAbsJointRad.toFixed(3)} rad</p>
          <p>{info.tcpPositionMm.toFixed(1)} mm</p>
          <p>{info.tcpOrientationDeg.toFixed(1)}°</p>
        </>
      )}
    </section>
  );
}
