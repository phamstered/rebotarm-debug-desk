import type { ObjectDetectionFrame } from "./types";
export function ObjectDetectionControls({ supported, enabled, onEnabledChange, frame, labels, dimensions, onLabelsChange, onDimensionsChange }: {
  supported: boolean; enabled: boolean; onEnabledChange?(value: boolean): void;
  frame?: ObjectDetectionFrame; labels: boolean; dimensions: boolean;
  onLabelsChange(value: boolean): void; onDimensionsChange(value: boolean): void;
}) {
  return <div className="object-detection-controls">
    <div className="viewer-overlay-row"><label title={supported ? "识别分离的桌面物体；不驱动机械臂" : "需要支持物体检测的 Bridge，且 RGBD 目标坐标系为 base_link"}>
      <input type="checkbox" checked={enabled} disabled={!supported} onChange={e => onEnabledChange?.(e.target.checked)} /> 物体三维框
    </label>{!supported && <span>当前不可用</span>}</div>
    {enabled && <>
      <div className="viewer-overlay-row">
        <label><input type="checkbox" checked={labels} onChange={e => onLabelsChange(e.target.checked)} /> 编号</label>
        <label><input type="checkbox" checked={dimensions} disabled={!labels} onChange={e => onDimensionsChange(e.target.checked)} /> 可见尺寸</label>
      </div>
      <div className="viewer-overlay-row" aria-live="polite" style={{ overflowWrap: "anywhere" }}>
        {frame ? `${frame.items.length} 个物体 · ${frame.message}` : "等待有效检测帧"}
      </div>
    </>}
  </div>;
}
