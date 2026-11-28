import { useEffect, useRef } from "react";
import { ActionButton } from "./ActionButton";
import { jointLabel, type MotorRowInput } from "./motorLogic";
import { motorRangeFor, type parseMotorUrdfRanges } from "./motorRangeLogic";

type Props = {
  motors: MotorRowInput[];
  jointState: { name?: string[]; position?: number[] } | null;
  ranges: ReturnType<typeof parseMotorUrdfRanges>;
  posVel: boolean;
  hold: boolean;
  selectionLocked: boolean;
  targetLocked: boolean;
  selectionChanged: boolean;
  velocityLimits: string[];
  batchVelocity: string;
  onSelectAll(selected: boolean): void;
  onRestoreSelection(): void;
  onUseCurrent(): void;
  onBatchVelocity(value: string): void;
  onFillVelocity(): void;
  onSelect(index: number, selected: boolean): void;
  onPosition(index: number, value: string): void;
  onVelocity(index: number, value: string): void;
};

export function MotorJointTable(props: Props) {
  const { motors, jointState, ranges, posVel, hold, selectionLocked, targetLocked, velocityLimits } = props;
  const selected = motors.filter(row => row.enabled).length;
  const all = selected === motors.length && selected > 0;
  const partial = selected > 0 && !all;
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = partial; }, [partial]);
  return <section className="motor-axis-panel" aria-label="关节目标">
    <div className="motor-axis-heading"><strong>关节目标</strong><span>已选 {selected}/{motors.length}</span></div>
    <div className="motor-axis-batch">
      <label className="motor-select-all"><input ref={selectAllRef} type="checkbox" aria-label="全选轴" aria-checked={partial ? "mixed" : all} checked={all} disabled={selectionLocked} onChange={event => props.onSelectAll(event.target.checked)} />全选</label>
      <ActionButton disabled={targetLocked || hold || selected === 0} onClick={props.onUseCurrent}>使用当前位置</ActionButton>
      {posVel && <><label className="motor-batch-input">统一速度<input aria-label="统一速度上限 · rad/s" type="text" inputMode="decimal" value={props.batchVelocity} disabled={targetLocked} onChange={event => props.onBatchVelocity(event.target.value)} /><span>rad/s</span></label><ActionButton disabled={targetLocked || selected === 0} onClick={props.onFillVelocity}>填写所选轴</ActionButton></>}
      {props.selectionChanged && <ActionButton disabled={selectionLocked} onClick={props.onRestoreSelection}>恢复当前选轴</ActionButton>}
    </div>
    <table className={`motor-axis-table${posVel ? " pos-vel" : ""}`} aria-label="关节控制列表">
      <colgroup><col className="axis-select-col" /><col className="axis-name-col" /><col className="axis-feedback-col" /><col />{posVel && <col className="axis-speed-col" />}<col className="axis-range-col" /></colgroup>
      <thead><tr><th scope="col">选择</th><th scope="col">关节</th><th scope="col">实测位置 <small>rad</small></th><th scope="col">目标位置 <small>rad</small></th>{posVel && <th scope="col">速度上限 <small>rad/s</small></th>}<th scope="col">位置范围 <small>rad</small></th></tr></thead>
      <tbody>{motors.map((motor, index) => {
        const name = jointState?.name?.[index] ?? jointLabel(index), feedback = jointState?.position?.[index];
        const range = motorRangeFor(ranges, name, index), hasRange = range.min !== null && range.max !== null;
        const sliderMin = range.min ?? 0, sliderMax = range.max ?? 1;
        const sliderValue = hasRange ? Math.max(sliderMin, Math.min(sliderMax, Number(motor.position) || 0)) : 0.5;
        return <tr key={name} className={motor.enabled ? "selected" : undefined}>
          <td><input type="checkbox" checked={motor.enabled} disabled={selectionLocked} aria-label={`${name} 选择控制`} onChange={event => props.onSelect(index, event.target.checked)} /></td>
          <th scope="row" title={name}>{name}</th>
          <td className="axis-feedback" aria-label={`${name} 实测位置`}>{Number.isFinite(feedback) ? Number(feedback).toFixed(4) : "—"}</td>
          <td><div className="axis-target"><input type="range" min={sliderMin} max={sliderMax} step="any" disabled={targetLocked || !motor.enabled || hold || !hasRange} value={sliderValue} aria-label={`${name} Position 滑块`} aria-describedby={`motor-range-${index}`} onChange={event => props.onPosition(index, event.target.value)} /><input type="text" inputMode="decimal" disabled={targetLocked || !motor.enabled || hold} value={motor.position} placeholder={posVel ? "请填写" : undefined} aria-label={`${name} Position · rad`} onChange={event => props.onPosition(index, event.target.value)} /></div></td>
          {posVel && <td><input className="axis-speed" type="text" inputMode="decimal" disabled={targetLocked || !motor.enabled} value={velocityLimits[index] ?? ""} placeholder="请填写" aria-label={`${name} 速度上限 · rad/s`} onChange={event => props.onVelocity(index, event.target.value)} /></td>}
          <td><div className="axis-range">{(["min", "max"] as const).map((bound, i) => <span key={bound}>{i > 0 && <span aria-hidden="true">～</span>}<input type="text" readOnly tabIndex={-1} value={range[bound] === null ? "" : String(Number(range[bound]!.toPrecision(8)))} placeholder="—" title={range[bound] === null ? range.reason : String(range[bound])} aria-label={`${name} 行程 ${bound}`} /></span>)}</div><small className="axis-range-source" id={`motor-range-${index}`} title={range.reason}>{range.source}{range.reason ? ` · ${range.reason}` : " · rad"}</small></td>
        </tr>;
      })}</tbody>
    </table>
    <div className="motor-axis-footer">草稿修改不会自动下发；请核对参数后确认执行。</div>
  </section>;
}
