import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { CONTROL_LOG_SOURCES, controlLogLines } from "./controlLogLogic";
import type { ConnectionProfile, ControlLogSnapshot, ControlLogSource } from "./types";

export function ControlLogViewer({ profile, active, connected, preferredSource = "teleop" }: {
  profile: ConnectionProfile;
  active: boolean;
  connected: boolean;
  preferredSource?: ControlLogSource;
}) {
  const [selection, setSelection] = useState<"auto" | ControlLogSource>("auto");
  const source = selection === "auto" ? preferredSource : selection;
  const [search, setSearch] = useState("");
  const [follow, setFollow] = useState(true);
  const [visible, setVisible] = useState(!document.hidden);
  const [result, setResult] = useState<{ key: string; log: ControlLogSnapshot } | null>(null);
  const [error, setError] = useState("");
  const [downloadNotice, setDownloadNotice] = useState("");
  const [downloading, setDownloading] = useState(false);
  const reading = useRef(false);
  const viewport = useRef<HTMLPreElement>(null);
  const userScrollUntil = useRef(0);
  const key = JSON.stringify([profile.host, profile.sshPort, profile.username, profile.identityFile, profile.rosDomainId, source]);
  const context = useRef({ key, connected });
  context.current = { key, connected };
  const snapshot = connected && result?.key === key ? result.log : null;
  const lines = useMemo(() => controlLogLines(snapshot?.content ?? "", search), [snapshot?.content, search]);
  const totalLines = useMemo(() => controlLogLines(snapshot?.content ?? "").length, [snapshot?.content]);

  useEffect(() => {
    const changed = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setError("");
    setDownloadNotice("");
    if (!connected) setResult(null);
    if (!active || !connected || !visible) return;
    const poll = async () => {
      if (disposed) return;
      if (reading.current) { timer = setTimeout(() => void poll(), 250); return; }
      reading.current = true;
      try {
        const log = await invoke<ControlLogSnapshot>("read_control_log", { profile, source });
        if (!disposed) {
          setResult((current) => current?.key === key && current.log.revision === log.revision && current.log.exists === log.exists ? current : { key, log });
          setError("");
        }
      } catch (reason) {
        if (!disposed) setError(`日志读取失败：${String(reason)}`);
      } finally {
        reading.current = false;
        if (!disposed) timer = setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
    // The serialized key captures SSH context; status polling must not restart this effect.
  }, [key, active, connected, visible]);

  useEffect(() => {
    if (follow && active && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [lines, follow, active]);

  async function download() {
    if (downloading || !connected || !snapshot?.exists) return;
    const startedKey = key;
    setDownloading(true);
    setDownloadNotice("");
    try {
      const localPath = await save({ title: "下载控制模式日志", defaultPath: `robot-console-${source}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`, filters: [{ name: "Log", extensions: ["log"] }] });
      if (!localPath || context.current.key !== startedKey || !context.current.connected) return;
      await invoke("download_control_log", { profile, source, localPath });
      if (context.current.key === startedKey && context.current.connected) setDownloadNotice("完整日志已下载（不受搜索过滤影响）");
    } catch (reason) {
      if (context.current.key === startedKey && context.current.connected) setDownloadNotice(`日志下载失败：${String(reason)}`);
    } finally { setDownloading(false); }
  }

  return <section className="control-log-viewer" aria-label="控制模式日志">
    <header className="control-log-header"><h2>实时日志</h2><span>{connected && active && visible ? "每秒刷新" : "刷新已暂停"}</span></header>
    <div className="control-log-tools">
      <label>日志来源<select value={selection} onChange={(event) => setSelection(event.target.value as typeof selection)}>
        <option value="auto">当前模式（{CONTROL_LOG_SOURCES.find((item) => item.id === preferredSource)?.label}）</option>
        {CONTROL_LOG_SOURCES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      <label className="control-log-search">搜索日志<input type="search" placeholder="输入关键词，不区分大小写" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <label className="control-log-follow"><input type="checkbox" checked={follow} onChange={(event) => { userScrollUntil.current = 0; setFollow(event.target.checked); }} />跟随最新</label>
      <button type="button" disabled={!connected || !snapshot?.exists || downloading} onClick={() => void download()}>{downloading ? "下载中…" : "下载完整日志"}</button>
    </div>
    <div className="control-log-meta"><span title={snapshot?.path}>{snapshot?.path || "只读获取 Jetson 日志"}</span><span>{lines.length} / {totalLines} 行</span></div>
    <p className="control-log-note">仅显示本次应用会话的新日志；重启应用后重新开始，Jetson 原始日志保留。</p>
    {source === "controller" && <p className="control-log-note">手动查看最新 ros2_control_node 日志文件。</p>}
    {source === "vla" && <p className="control-log-note">VLA 输出跟随本次 Trajectory+gravity 启动的控制器宿主日志。</p>}
    {snapshot?.truncated && <p className="control-log-note">窗口展示末尾 128 KiB / 2000 行；下载包含完整文件（上限 32 MiB）。</p>}
    {error && <p className="control-log-error" role="alert">{error}</p>}
    {downloadNotice && <output className="control-log-notice">{downloadNotice}</output>}
    <pre ref={viewport} className="control-log-output" tabIndex={0} aria-label="日志输出"
      onWheel={() => { userScrollUntil.current = Date.now() + 1000; }}
      onPointerDown={() => { userScrollUntil.current = Date.now() + 1000; }}
      onPointerMove={(event) => { if (event.buttons) userScrollUntil.current = Date.now() + 1000; }}
      onTouchMove={() => { userScrollUntil.current = Date.now() + 1000; }}
      onKeyDown={(event) => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) userScrollUntil.current = Date.now() + 1000; }}
      onScroll={() => {
      const node = viewport.current;
      if (node && follow && Date.now() < userScrollUntil.current && node.scrollHeight - node.scrollTop - node.clientHeight > 24) setFollow(false);
    }}>{!connected ? "SSH 未连接" : !snapshot ? "正在获取日志…" : !snapshot.exists ? "日志尚未生成，启动对应模式后自动更新" : !totalLines ? "日志为空，等待新输出…" : !lines.length ? "没有匹配的日志" : lines.map((line, index) => <span key={index} className={/\b(error|fatal)\b/i.test(line) ? "log-error" : /\bwarn(ing)?\b/i.test(line) ? "log-warn" : undefined}>{line}{"\n"}</span>)}</pre>
  </section>;
}
