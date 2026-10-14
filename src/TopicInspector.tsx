import { useMemo } from "react";
import type { TopicSample } from "./appLogic";
import { listNumericFields } from "./dataGraphLogic";
import type { NumericFieldInfo } from "./dataGraphLogic";
import { imageMetadataJson, isRosImageType } from "./imageTopicLogic";
import { RosImagePreview } from "./RosImagePreview";

function rawJson(sample: TopicSample | undefined): string {
  return JSON.stringify(sample?.data ?? "等待数据…", null, 2);
}

export function TopicInspector({
  selected,
  topicType = "",
  sample,
  subscribeError = "",
  onAddToDataGraph,
}: {
  selected: string;
  topicType?: string;
  sample: TopicSample | undefined;
  subscribeError?: string;
  onAddToDataGraph?(fieldPath: string): void;
}) {
  const imageTopic = isRosImageType(topicType);
  const output = useMemo(() => {
    if (!selected) return "从左侧或 Topic Graph 选择一个 Topic";
    if (imageTopic) return imageMetadataJson(sample?.data);
    return rawJson(sample);
  }, [imageTopic, sample, selected]);

  const numericFields = useMemo(
    () => (selected && sample && !imageTopic ? listNumericFields(sample.data) : []),
    [imageTopic, sample, selected],
  );

  return (
    <div className="section-content topic-inspector-content">
      {selected && (
        <div className="topic-inspector-status">
          <span>{imageTopic ? "图像预览 + 元数据" : "原始 JSON"}</span>
        </div>
      )}
      {subscribeError && <div className="topic-inspector-error">订阅失败：{subscribeError}</div>}
      {imageTopic && <RosImagePreview data={sample?.data} />}
      {numericFields.length > 0 && onAddToDataGraph && (
        <div className="topic-inspector-fields" aria-label="可加入 Monitor 的字段">
          <div className="topic-inspector-fields-title">数值字段 → Monitor</div>
          <ul>
            {numericFields.map((field) => (
              <NumericFieldRow key={field.path} field={field} onAdd={() => onAddToDataGraph(field.path)} />
            ))}
          </ul>
        </div>
      )}
      <pre>{output}</pre>
    </div>
  );
}

function NumericFieldRow({ field, onAdd }: { field: NumericFieldInfo; onAdd(): void }) {
  const detail = field.kind === "array" ? `array[${field.length ?? 0}]` : "scalar";
  return (
    <li>
      <code title={field.path}>{field.path}</code>
      <small>{detail}</small>
      <button type="button" onClick={onAdd} aria-label={`加入 Monitor：${field.path}`}>
        加入 DataGraph
      </button>
    </li>
  );
}
