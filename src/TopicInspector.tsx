import { useEffect, useRef, useState } from "react";
import type { TopicSample } from "./appLogic";
import { imageMetadataJson, isRosImageType } from "./imageTopicLogic";
import { RosImagePreview } from "./RosImagePreview";
import { loadJqExpressions } from "./topicInspectorLogic";

function rawJson(sample: TopicSample | undefined): string {
  return JSON.stringify(sample?.data ?? "等待数据…", null, 2);
}

export function TopicInspector({ selected, topicType = "", sample, subscribeError = "" }: { selected: string; topicType?: string; sample: TopicSample | undefined; subscribeError?: string }) {
  const [expressions, setExpressions] = useState<Record<string, string>>(loadJqExpressions);
  const [output, setOutput] = useState(() => rawJson(sample));
  const [jqError, setJqError] = useState("");
  const expression = selected ? expressions[selected] ?? "" : "";
  const imageTopic = isRosImageType(topicType);
  const latestSampleRef = useRef(sample);
  latestSampleRef.current = sample;

  useEffect(() => {
    localStorage.setItem("robot-console-jq-filters", JSON.stringify(expressions));
  }, [expressions]);

  useEffect(() => {
    if (!selected) {
      setOutput("从左侧或 Topic Graph 选择一个 Topic");
      setJqError("");
      return;
    }
    if (!expression.trim()) {
      setOutput(imageTopic ? imageMetadataJson(sample?.data) : rawJson(sample));
      setJqError("");
      return;
    }
    if (sample?.data === undefined) {
      setOutput("等待数据…");
      setJqError("");
    }
  }, [expression, imageTopic, sample?.data, selected]);

  useEffect(() => {
    const query = expression.trim();
    if (!selected || !query) return;
    let current = true;
    let interval: number | undefined;
    let running = false;
    let lastData: unknown = Symbol("unprocessed");
    const update = async () => {
      const data = latestSampleRef.current?.data;
      if (data === undefined || running || data === lastData) return;
      running = true;
      lastData = data;
      try {
        const { formatJqOutputs, runJqFilter } = await import("./jqFilter");
        const values = await runJqFilter(data, query);
        if (current) {
          setOutput(formatJqOutputs(values));
          setJqError("");
        }
      } catch (reason) {
        if (current) setJqError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        running = false;
      }
    };
    const timer = window.setTimeout(() => {
      void update();
      interval = window.setInterval(() => void update(), 100);
    }, 80);
    return () => {
      current = false;
      window.clearTimeout(timer);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [expression, selected]);

  return (
    <div className="section-content topic-inspector-content">
      {selected && (
        <div className="topic-inspector-filter">
          <label>
            jq 过滤（可选）
            <textarea
              aria-label={`jq 过滤 ${selected}`}
              value={expression}
              spellCheck={false}
              onChange={(event) => setExpressions((current) => ({ ...current, [selected]: event.target.value }))}
              placeholder="留空显示原始数据，例如 .position[0]"
            />
          </label>
          <span className={expression.trim() ? "enabled" : ""}>{expression.trim() ? "jq 已启用" : imageTopic ? "未筛选 · 图像预览 + 元数据" : "未筛选 · 原始 JSON"}</span>
        </div>
      )}
      {subscribeError && <div className="topic-inspector-error">订阅失败：{subscribeError}</div>}
      {jqError && <div className="topic-inspector-error">jq 错误：{jqError}</div>}
      {!expression.trim() && imageTopic && <RosImagePreview data={sample?.data} />}
      <pre>{jqError ? "" : output}</pre>
    </div>
  );
}
