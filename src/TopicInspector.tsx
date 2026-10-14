import { useMemo } from "react";
import type { TopicSample } from "./appLogic";
import { imageMetadataJson, isRosImageType } from "./imageTopicLogic";
import { RosImagePreview } from "./RosImagePreview";

function rawJson(sample: TopicSample | undefined): string {
  return JSON.stringify(sample?.data ?? "等待数据…", null, 2);
}

export function TopicInspector({ selected, topicType = "", sample, subscribeError = "" }: { selected: string; topicType?: string; sample: TopicSample | undefined; subscribeError?: string }) {
  const imageTopic = isRosImageType(topicType);
  const output = useMemo(() => {
    if (!selected) return "从左侧或 Topic Graph 选择一个 Topic";
    if (imageTopic) return imageMetadataJson(sample?.data);
    return rawJson(sample);
  }, [imageTopic, sample, selected]);

  return (
    <div className="section-content topic-inspector-content">
      {selected && (
        <div className="topic-inspector-status">
          <span>{imageTopic ? "图像预览 + 元数据" : "原始 JSON"}</span>
        </div>
      )}
      {subscribeError && <div className="topic-inspector-error">订阅失败：{subscribeError}</div>}
      {imageTopic && <RosImagePreview data={sample?.data} />}
      <pre>{output}</pre>
    </div>
  );
}
