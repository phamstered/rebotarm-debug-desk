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
function triggerTime(milliseconds: number) {
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) return `${value(milliseconds)} ms`;
  const pad = (part: number, size = 2) => String(part).padStart(size, "0");
  return `${date.getUTCFullYear()}年${pad(date.getUTCMonth() + 1)}月${pad(date.getUTCDate())}日 ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)} UTC`;
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
function DiagnosticTable({
  samples,
  holding = false,
  reason,
}: {
  samples: MotionArrivalError[];
  holding?: boolean;
  reason?: "position_drift" | "velocity_timeout";
}) {
  return (
    <div
      className="motion-group-arrival-scroll"
      tabIndex={0}
      role="region"
      aria-label={
        holding ? "异常触发诊断，可左右滚动" : "逐关节诊断，可左右滚动"
      }
    >
      <table aria-label={holding ? "异常触发关节诊断" : "关节到位诊断"}>
        <caption>可左右滚动查看完整位置与速度诊断。</caption>
        <thead>
          <tr>
            <th>关节</th>
            <th>
              {holding
                ? "实际保持基准 / 触发时位置"
                : "本帧名义目标 / 核验位置"}
            </th>
            <th>{holding ? "保持偏移 / 阈值" : "位置误差 / 参考值"}</th>
            <th>{holding ? "触发时速度 / 停稳阈值" : "核验速度 / 停稳阈值"}</th>
          </tr>
        </thead>
        <tbody>
          {samples.map((error, index) => {
            const triggered =
              reason === "position_drift"
                ? Math.abs(error.position_error) > error.position_tolerance
                : reason === "velocity_timeout" &&
                  Math.abs(error.velocity) > error.velocity_tolerance;
            return (
              <tr
                key={`${error.joint_name}-${index}`}
                className={triggered ? "motion-group-trigger-axis" : undefined}
              >
                <th scope="row">{error.joint_name}</th>
                <td>
                  <span>
                    {holding ? "保持基准" : "目标"}{" "}
                    {position(error.target, error.unit)}
                  </span>
                  <span>
                    {holding ? "触发时" : "实际"}{" "}
                    {position(error.actual, error.unit)}
                  </span>
                </td>
                <td>
                  <span>
                    {holding ? "偏移" : "误差"}{" "}
                    {position(error.position_error, error.unit)}
                  </span>
                  <span>
                    {holding ? "保持阈值" : "参考"}{" "}
                    {position(error.position_tolerance, error.unit)}
                  </span>
                </td>
                <td>
                  <span>速度 {velocity(error.velocity, error.unit)}</span>
                  <span>
                    停稳阈值 {velocity(error.velocity_tolerance, error.unit)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
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
  const failure = state.holdFailure;
  const triggerAxes =
    failure?.samples
      .filter((sample) =>
        failure.reason === "position_drift"
          ? Math.abs(sample.position_error) > sample.position_tolerance
          : Math.abs(sample.velocity) > sample.velocity_tolerance,
      )
      .map((sample) => sample.joint_name) ?? [];
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
      {failure && (
        <section
          className="motion-group-trigger-snapshot"
          aria-label="异常触发快照"
        >
          <h3>异常触发快照</h3>
          <p className="motion-group-result-warning">
            {failure.reason === "position_drift"
              ? "保持位置偏移超限，触发取消。"
              : "保持速度未持续满足停稳要求，触发取消。"}
          </p>
          <p>
            {failure.phase === "paused" ? "段间暂停" : "停留"} ·
            触发时间（Jetson）{" "}
            <span title={`${value(failure.capturedAtMs)} ms`}>
              {triggerTime(failure.capturedAtMs)}
            </span>{" "}
            · 反馈年龄 {value(failure.feedbackAgeMs)} ms
          </p>
          {failure.reason === "velocity_timeout" &&
            failure.stableForMs !== undefined &&
            failure.requiredStableMs !== undefined && (
              <p>
                连续停稳 {value(failure.stableForMs)} / 要求{" "}
                {value(failure.requiredStableMs)} ms
              </p>
            )}
          <p>
            {triggerAxes.length
              ? `${failure.reason === "position_drift" ? "保持偏移超限关节" : "采样速度超限关节"}：${triggerAxes.join("、")}`
              : failure.reason === "velocity_timeout"
                ? "触发快照中未见单轴速度超限；连续停稳条件未满足。"
                : "触发快照未显示超阈值关节，保留 Bridge 原始原因。"}
          </p>
          <p className="motion-group-result-policy">
            保持基准取进入保持时的实际反馈，并非本帧名义目标。
          </p>
          <DiagnosticTable
            samples={failure.samples}
            holding
            reason={failure.reason}
          />
        </section>
      )}
      {!!errors.length && (
        <section
          className="motion-group-verification-snapshot"
          aria-label="完成/停止核验快照"
        >
          <h3>完成/停止核验快照</h3>
          <p className="motion-group-result-policy">
            目标为本帧名义目标；本快照记录完成或停止核验时的反馈
            {failure ? "，不替代异常触发快照" : ""}。
          </p>
          <DiagnosticTable samples={errors} />
        </section>
      )}
      <p className="motion-group-result-policy">
        {state.positionErrorCheckEnforced === false
          ? "运动完成时，位置误差仅供诊断，不作为完成门槛。"
          : state.positionErrorCheckEnforced === true
            ? "当前 Bridge 声明位置误差参与运动完成校验。"
            : "当前 Bridge 未声明位置误差完成策略，请以实际任务状态及原始原因为准。"}
        速度停稳阈值仍用于停稳确认。
      </p>
      {!errors.length && terminal && (
        <p className="motion-group-result-policy">
          当前任务未提供逐关节完成/停止核验诊断明细；原始结果仍已保留。
        </p>
      )}
      <details>
        <summary>任务标识</summary>
        <code>{state.commandId}</code>
      </details>
    </section>
  );
}
