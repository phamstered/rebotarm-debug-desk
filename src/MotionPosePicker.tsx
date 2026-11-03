import { useState } from "react";
import type { CustomPosition } from "./positionLogic";
import { UrdfPoseThumbnail } from "./UrdfPoseThumbnail";
import { motionPoseThumbnailProps } from "./motionGroupsLogic";
import { MotionGroupDialog } from "./MotionGroupDialog";
export function MotionPosePicker({
  sources,
  xml,
  create,
  single = false,
  onChoose,
  onClose,
  onOpenLibrary,
}: {
  sources: CustomPosition[];
  xml: string;
  create: boolean;
  single?: boolean;
  onChoose(name: string, poses: CustomPosition[]): void;
  onClose(): void;
  onOpenLibrary?(): void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("新动作组");
  const [query, setQuery] = useState("");
  const poses = selected
    .map((id) => sources.find((p) => p.id === id)!)
    .filter(Boolean);
  return (
    <MotionGroupDialog
      title={create ? "从姿态库新建动作组" : single ? "替换姿态" : "从姿态库添加 Pose"}
      onClose={onClose}
    >
      {create && (
        <label>
          动作组名称
          <input
            value={name}
            maxLength={128}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      )}
      <label>
        搜索姿态
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="按姿态名称搜索"
        />
      </label>
      {!sources.length && (
        <p>
          姿态库为空，请先在「姿态库」保存当前姿态。
          {onOpenLibrary && <button onClick={onOpenLibrary}>前往姿态库</button>}
        </p>
      )}
      <div className="motion-pose-choices">
        {sources
          .filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
          .map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={selected.includes(p.id)}
              onClick={() =>
                setSelected((ids) =>
                  single ? [p.id] : ids.includes(p.id)
                    ? ids.filter((id) => id !== p.id)
                    : [...ids, p.id],
                )
              }
            >
              <UrdfPoseThumbnail
                xml={xml}
                label={p.name}
                {...motionPoseThumbnailProps(p.positions, p.gripperPosition)}
              />
              <strong>{p.name}</strong>
              <small>
                {selected.includes(p.id)
                  ? `已选 ${selected.indexOf(p.id) + 1}`
                  : "点击选择"}
              </small>
            </button>
          ))}
      </div>
      <p>选入顺序：{poses.map((p) => p.name).join(" → ") || "尚未选择"}</p>
      <footer>
        <button onClick={onClose}>取消</button>
        <button
          className="motion-primary"
          disabled={!poses.length || !name.trim()}
          onClick={() => onChoose(name.trim(), poses)}
        >
          {create ? "创建动作组" : single ? "替换所选 Pose" : "添加所选 Pose"}
        </button>
      </footer>
    </MotionGroupDialog>
  );
}
