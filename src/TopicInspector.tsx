import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TopicSample } from "./appLogic";
import { loadJqExpressions, validatePublishJson } from "./topicInspectorLogic";
import type { ConnectionProfile } from "./types";

type InspectorTab = "data" | "info" | "publish";

function rawJson(sample: TopicSample | undefined): string {
  return JSON.stringify(sample?.data ?? "等待数据…", null, 2);
}

export function TopicInspector({
  selected,
  topicType,
  sample,
  profile,
  subscribeError = "",
}: {
  selected: string;
  topicType: string;
  sample: TopicSample | undefined;
  profile: ConnectionProfile;
  subscribeError?: string;
}) {
  const [tab, setTab] = useState<InspectorTab>("data");
  const [expressions, setExpressions] = useState<Record<string, string>>(loadJqExpressions);
  const [output, setOutput] = useState(() => rawJson(sample));
  const [jqError, setJqError] = useState("");
  const [topicInfo, setTopicInfo] = useState("");
  const [topicInfoLoaded, setTopicInfoLoaded] = useState(false);
  const [topicInfoError, setTopicInfoError] = useState("");
  const [topicInfoLoading, setTopicInfoLoading] = useState(false);
  const [publishJson, setPublishJson] = useState("{}");
  const [publishError, setPublishError] = useState("");
  const [publishResult, setPublishResult] = useState("");
  const [publishing, setPublishing] = useState(false);
  const expression = selected ? expressions[selected] ?? "" : "";
  const commandTopicBlocked = selected === profile.commandTopic;
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
      setOutput(rawJson(sample));
      setJqError("");
      return;
    }
    if (sample?.data === undefined) {
      setOutput("等待数据…");
      setJqError("");
    }
  }, [expression, sample?.data, selected]);

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

  useEffect(() => {
    setTopicInfo("");
    setTopicInfoLoaded(false);
    setTopicInfoError("");
    setPublishJson("{}");
    setPublishError("");
    setPublishResult("");
  }, [selected]);

  const refreshTopicInfo = useCallback(async () => {
    if (!selected || topicInfoLoading) return;
    setTopicInfoLoading(true);
    setTopicInfoError("");
    try {
      setTopicInfo(await invoke<string>("get_topic_info", { profile, topic: selected }));
    } catch (reason) {
      setTopicInfoError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setTopicInfoLoaded(true);
      setTopicInfoLoading(false);
    }
  }, [profile, selected, topicInfoLoading]);

  useEffect(() => {
    if (tab === "info" && selected && !topicInfoLoaded && !topicInfoLoading) void refreshTopicInfo();
  }, [refreshTopicInfo, selected, tab, topicInfoLoaded, topicInfoLoading]);

  const publishOnce = async () => {
    const validationError = validatePublishJson(publishJson);
    if (validationError) {
      setPublishError(validationError);
      return;
    }
    if (!selected || !topicType) {
      setPublishError("Topic 或消息类型不可用");
      return;
    }
    if (commandTopicBlocked) {
      setPublishError("电机命令必须通过 Motor Control 发送");
      return;
    }
    setPublishing(true);
    setPublishError("");
    setPublishResult("");
    try {
      setPublishResult(await invoke<string>("publish_topic_once", {
        profile,
        topic: selected,
        typeName: topicType,
        payloadJson: publishJson,
      }));
    } catch (reason) {
      setPublishError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="section-content topic-inspector-content">
      <div className="inspector-tab-list" role="tablist" aria-label="Topic Inspector 功能">
        <button type="button" role="tab" aria-selected={tab === "data"} className={tab === "data" ? "active" : ""} onClick={() => setTab("data")}>数据</button>
        <button type="button" role="tab" aria-selected={tab === "info"} className={tab === "info" ? "active" : ""} onClick={() => setTab("info")}>Topic Info</button>
        <button type="button" role="tab" aria-selected={tab === "publish"} className={tab === "publish" ? "active" : ""} onClick={() => setTab("publish")}>发送</button>
      </div>

      {tab === "data" && (
        <div className="inspector-tab-content data-tab-content">
          {selected && <div className="topic-inspector-filter"><label>jq 过滤（可选）<textarea aria-label={`jq 过滤 ${selected}`} value={expression} spellCheck={false} onChange={(event) => setExpressions((current) => ({ ...current, [selected]: event.target.value }))} placeholder="留空显示原始 JSON，例如 .position[0]" /></label><span className={expression.trim() ? "enabled" : ""}>{expression.trim() ? "jq 已启用" : "未筛选 · 原始 JSON"}</span></div>}
          {subscribeError && <div className="topic-inspector-error">订阅失败：{subscribeError}</div>}
          {jqError && <div className="topic-inspector-error">jq 错误：{jqError}</div>}
          <pre>{jqError ? "" : output}</pre>
        </div>
      )}

      {tab === "info" && (
        <div className="inspector-tab-content info-tab-content">
          <div className="inspector-action-row"><span>{selected || "请选择 Topic"}</span><button type="button" onClick={() => void refreshTopicInfo()} disabled={!selected || topicInfoLoading}>{topicInfoLoading ? "查询中…" : "刷新 Info"}</button></div>
          {topicInfoError && <div className="topic-inspector-error">Topic Info 失败：{topicInfoError}</div>}
          <pre>{topicInfo || (selected ? "正在读取 Topic Info…" : "请先选择 Topic")}</pre>
        </div>
      )}

      {tab === "publish" && (
        <div className="inspector-tab-content publish-tab-content">
          <div className="publish-topic-meta"><strong>{selected || "未选择 Topic"}</strong><span>{topicType || "未知消息类型"}</span></div>
          <label>单帧消息 JSON<textarea aria-label={`发布 JSON ${selected}`} value={publishJson} spellCheck={false} onChange={(event) => { setPublishJson(event.target.value); setPublishError(""); setPublishResult(""); }} placeholder={'{"data":"hello"}'} /></label>
          {commandTopicBlocked && <div className="topic-inspector-warning">电机命令 Topic 已锁定，请使用 Motor Control。</div>}
          {publishError && <div className="topic-inspector-error">发送失败：{publishError}</div>}
          {publishResult && <div className="topic-inspector-success">{publishResult}</div>}
          <button className="publish-once-button" type="button" disabled={!selected || !topicType || commandTopicBlocked || publishing} onClick={() => void publishOnce()}>{publishing ? "发送中…" : "校验并发送一帧"}</button>
        </div>
      )}
    </div>
  );
}
