import { useState } from "react";
import { MotionGroupDialog } from "./MotionGroupDialog";
import {
  groupTracks,
  type MotionGroup,
  type MotionSyncPoint,
} from "./motionGroupsLogic";

export function MotionSyncEditor({
  group,
  point,
  onSave,
  onDelete,
  onClose,
}: {
  group: MotionGroup;
  point?: MotionSyncPoint;
  onSave(point: MotionSyncPoint): void;
  onDelete?(): void;
  onClose(): void;
}) {
  const [name, setName] = useState(point?.name ?? "同步点");
  const [selected, setSelected] = useState<string[]>(point?.afterStepIds ?? []);
  const tracks = groupTracks(group);
  return (
    <MotionGroupDialog
      title={point ? "编辑同步点" : "添加同步点"}
      onClose={onClose}
    >
      <p>
        同步点用于编排等待多个机械臂 Pose 完成；当前 Bridge 不支持多臂同步执行。
      </p>
      <label>
        同步点名称
        <input
          value={name}
          maxLength={128}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <p>每个机械臂选择一个参与 Pose，至少两个机械臂。</p>
      <div className="motion-sync-choices">
        {group.steps.map((step, index) => (
          <label className="motion-safety-check" key={step.id}>
            <input
              type="checkbox"
              checked={selected.includes(step.id)}
              onChange={(e) =>
                setSelected((ids) =>
                  e.target.checked
                    ? [
                        ...ids.filter(
                          (id) =>
                            (group.steps.find((s) => s.id === id)?.trackId ??
                              "arm") !== (step.trackId ?? "arm"),
                        ),
                        step.id,
                      ]
                    : ids.filter((id) => id !== step.id),
                )
              }
            />
            {tracks.find((t) => t.id === (step.trackId ?? "arm"))?.name} · Pose{" "}
            {index + 1} · {step.positionName}
          </label>
        ))}
      </div>
      <footer>
        {onDelete && <button onClick={onDelete}>删除同步点</button>}
        <button onClick={onClose}>取消</button>
        <button
          className="motion-primary"
          disabled={!name.trim() || selected.length < 2}
          onClick={() =>
            onSave({
              id: point?.id ?? crypto.randomUUID(),
              name: name.trim(),
              afterStepIds: [...selected],
            })
          }
        >
          保存同步点
        </button>
      </footer>
    </MotionGroupDialog>
  );
}
