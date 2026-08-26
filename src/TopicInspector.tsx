import { useEffect, useState } from "react";
import type { TopicSample } from "./appLogic";
import { loadJqExpressions } from "./topicInspectorLogic";

function rawJson(sample: TopicSample | undefined): string {
  return JSON.stringify(sample?.data ?? "等待数据…", null, 2);
}

export function TopicInspector({ selected, sample, subscribeError = "" }: { selected: string; sample: TopicSample | undefined; subscribeError?: string }) {
  const [expressions, setExpressions] = useState<Record<string, string>>(loadJqExpressions);
  const [output, setOutput] = useState(() => rawJson(sample));
  const [jqError, setJqError] = useState("");
  const expression = selected ? expressions[selected] ?? "" : "";

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
      setOutput(rawJson(sample));
      setJqError("");
      return;
    }
    if (sample?.data === undefined) {
      setOutput("等待数据…");
      setJqError("");
      return;
    }
    let current = true;
    const timer = window.setTimeout(() => {
      void import("./jqFilter").then(async ({ formatJqOutputs, runJqFilter }) => {
        const values = await runJqFilter(sample.data, expression);
        if (current) {
          setOutput(formatJqOutputs(values));
          setJqError("");
        }
      }).catch((reason) => {
        if (current) setJqError(reason instanceof Error ? reason.message : String(reason));
      });
    }, 80);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [expression, sample?.data, selected]);

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
              placeholder="留空显示原始 JSON，例如 .position[0]"
            />
          </label>
          <span className={expression.trim() ? "enabled" : ""}>{expression.trim() ? "jq 已启用" : "未筛选 · 原始 JSON"}</span>
        </div>
      )}
      {subscribeError && <div className="topic-inspector-error">订阅失败：{subscribeError}</div>}
      {jqError && <div className="topic-inspector-error">jq 错误：{jqError}</div>}
      <pre>{jqError ? "" : output}</pre>
    </div>
  );
}
