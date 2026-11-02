import type { MotionGroup } from "./motionGroupsLogic";
import type {
  PositionMotionPhase,
  PositionMotionState,
} from "./positionMotionLogic";
import type { MotionArrivalError } from "./types";

export const motionGroupPhaseLabels: Record<PositionMotionPhase, string> = {
  idle: "等待执行",
  validating: "正在校验",
  planning: "正在规划",
  executing: "正在执行",
  verifying: "正在确认停稳",
  waiting: "正在停留",
  paused: "已暂停",
  canceling: "正在取消",
  stopping: "正在停止",
  stop_failed: "停止确认失败",
  succeeded: "执行成功",
  failed: "执行失败",
  canceled: "已取消",
};
const stages = {
  preparing: "首帧准备",
  moving: "运动",
  holding: "停留",
  paused: "段间暂停",
};
function value(number: number) {
  return Number.isFinite(number) ? Number(number.toFixed(6)).toString() : "—";
}
function position(number: number, unit: MotionArrivalError["unit"]) {
  return unit === "m"
    ? `${value(number)} m（${value(number * 1000)} mm）`
    : `${value(number)} rad（${value((number * 180) / Math.PI)}°）`;
}
function velocity(number: number, unit: MotionArrivalError["unit"]) {
  return unit === "m"
    ? `${value(number)} m/s（${value(number * 1000)} mm/s）`
    : `${value(number)} rad/s（${value((number * 180) / Math.PI)}°/s）`;
}
/** A result follows the session's command, independently of whichever group is being edited. */
export function MotionGroupResult({
  state,
  snapshot,
}: {
  state: PositionMotionState;
  snapshot?: MotionGroup | null;
}) {
  if (!state.group || !state.commandId) return null;
  const group = state.group;
  const matching = snapshot?.id === group.id ? snapshot : null;
  const step = group.stepLabel || matching?.steps[group.index]?.positionName;
  const name = matching?.name || state.label || group.id;
  const terminal = ["succeeded", "failed", "canceled"].includes(state.phase);
  const errors = state.arrivalErrors ?? [];
  return (
    <section
      className={`motion-group-result result-${state.phase}`}
      role="status"
      aria-live="polite"
      aria-atomic="false"
      aria-label="最近动作组执行结果"
    >
      <div className="motion-group-result-heading">
        <strong>最近执行的「{name}」动作组</strong>
        <b>{motionGroupPhaseLabels[state.phase]}</b>
      </div>
      <p>
        第 {group.index + 1}/{group.count} 帧
        {step ? ` · ${step}` : " · 点位名称未提供"} · {stages[group.phase]} ·
        实际经过 {value(group.elapsed)} s{terminal ? " · 任务已结束" : ""}
      </p>
      <p className="motion-group-result-reason">
        {state.message || "当前任务未提供详细原因"}
        {state.code === undefined ? "" : `（代码 ${state.code}）`}
      </p>
      {state.phase === "failed" && (
        <p className="motion-group-result-warning">
          动作组已失败，后续关键帧未执行。请检查原始原因后重新发起。
        </p>
      )}
      {state.phase === "canceled" && <p>动作组已取消，后续关键帧不再继续。</p>}
      <p className="motion-group-result-policy">
        {state.positionErrorCheckEnforced === false
          ? "位置误差仅供诊断，不作为完成门槛。"
          : state.positionErrorCheckEnforced === true
            ? "当前 Bridge 声明位置误差参与完成校验。"
            : "当前 Bridge 未声明位置误差完成策略，请以实际任务状态及原始原因为准。"}
        速度停稳阈值仍用于停稳确认。
      </p>
      {!!errors.length && (
        <div
          className="motion-group-arrival-scroll"
          tabIndex={0}
          role="region"
          aria-label="逐关节诊断，可左右滚动"
        >
          <table aria-label="关节到位诊断">
            <caption>可左右滚动查看完整位置与速度诊断。</caption>
            <thead>
              <tr>
                <th>关节</th>
                <th>目标 / 实际位置</th>
                <th>位置误差 / 参考值</th>
                <th>实际速度 / 停稳阈值</th>
              </tr>
            </thead>
            <tbody>
              {errors.map((error, index) => (
                <tr key={`${error.joint_name}-${index}`}>
                  <th scope="row">{error.joint_name}</th>
                  <td>
                    <span>目标 {position(error.target, error.unit)}</span>
                    <span>实际 {position(error.actual, error.unit)}</span>
                  </td>
                  <td>
                    <span>
                      误差 {position(error.position_error, error.unit)}
                    </span>
                    <span>
                      参考 {position(error.position_tolerance, error.unit)}
                    </span>
                  </td>
                  <td>
                    <span>速度 {velocity(error.velocity, error.unit)}</span>
                    <span>
                      停稳阈值 {velocity(error.velocity_tolerance, error.unit)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!errors.length && terminal && (
        <p className="motion-group-result-policy">
          当前任务未提供逐关节诊断明细；原始结果仍已保留。
        </p>
      )}
      <details>
        <summary>任务标识</summary>
        <code>{state.commandId}</code>
      </details>
    </section>
  );
}
