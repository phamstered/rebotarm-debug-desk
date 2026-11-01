import { useEffect, useRef, useState } from "react";
import {
  poseFromInputs,
  poseRpyDegrees,
  type TcpHandleFrame,
  type TcpTargetPose,
} from "./tcpPoseInteractionLogic";
export function TcpPosePanel({
  pose,
  frame,
  frameId,
  disabled,
  onFrame,
  onChange,
  onInputError,
}: {
  pose: TcpTargetPose | null;
  frame: TcpHandleFrame;
  frameId: string;
  disabled: boolean;
  onFrame(frame: TcpHandleFrame): void;
  onChange(pose: TcpTargetPose): void;
  onInputError(error: string): void;
}) {
  const [values, setValues] = useState<string[]>(["", "", "", "", "", ""]);
  const ownPose = useRef<TcpTargetPose | null>(null);
  useEffect(() => {
    if (pose === ownPose.current) return;
    setValues(
      pose
        ? [
            ...pose.position.map((v) => (v * 1000).toFixed(2)),
            ...poseRpyDegrees(pose).map((v) => v.toFixed(2)),
          ]
        : ["", "", "", "", "", ""],
    );
    onInputError("");
  }, [pose]);
  return (
    <section className="tcp-pose-panel" aria-label="TCP 位姿目标">
      <label>
        拖拽坐标系
        <select
          aria-label="TCP 拖拽坐标系"
          disabled={disabled}
          value={frame}
          onChange={(event) => onFrame(event.target.value as TcpHandleFrame)}
        >
          <option value="base">基座 XYZ</option>
          <option value="tool">工具 XYZ</option>
        </select>
      </label>
      <p>
        青色球快速拖动位置；红 X · 绿 Y · 蓝 Z 箭头、旋转圆环及 XYZ/RPY 数值用于微调。数值相对 {frameId || "基座"}。
      </p>
      <div className="tcp-pose-values">
        {["X", "Y", "Z", "Roll", "Pitch", "Yaw"].map((label, i) => (
          <label key={label}>
            {label} <small>{i < 3 ? "mm" : "°"}</small>
            <input
              aria-label={`TCP ${label}`}
              type="text"
              inputMode="decimal"
              disabled={disabled || !pose}
              value={values[i]}
              onFocus={() => {
                if (pose) {
                  ownPose.current = pose;
                  onChange(pose);
                }
              }}
              onChange={(event) => {
                const next = [...values];
                next[i] = event.target.value;
                setValues(next);
                const result = poseFromInputs(next);
                onInputError(result.error);
                if (result.pose) {
                  ownPose.current = result.pose;
                  onChange(result.pose);
                }
              }}
            />
          </label>
        ))}
      </div>
      <p>
        RPY：固定轴 XYZ（Rz·Ry·Rx）。接近 Pitch ±90°
        时欧拉角不唯一，圆环仍按四元数旋转。
      </p>
    </section>
  );
}
