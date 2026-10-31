import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { MotionLogEntry } from "./types";

export function formatMotionLog(entry: MotionLogEntry) {
  return `${new Date(entry.timestamp_ms).toISOString()} [${entry.level.toUpperCase()}] [${entry.command_id || "system"}] [${entry.phase}] ${entry.message}`;
}
export function MotionTerminal({ logs, active, plannerLog }: { logs: MotionLogEntry[]; active: boolean; plannerLog?: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [source, setSource] = useState("audit");
  const [search, setSearch] = useState("");
  const [follow, setFollow] = useState(true);
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const viewport = useRef<HTMLPreElement>(null);
  const userScroll = useRef(false);
  const lines = useMemo(() => logs.map((entry) => ({ entry, text: formatMotionLog(entry) })), [logs]);
  const visible = lines.filter(({ text }) => text.toLowerCase().includes(search.toLowerCase()));
  useEffect(() => { if (follow && active && !collapsed && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; }, [logs, search, follow, active, collapsed, source]);
  async function download() {
    if (saving) return;
    setSaving(true); setNotice("");
    const content = lines.map(({ text }) => text).join("\n") + "\n";
    try {
      const localPath = await save({ title: "导出规划执行日志", defaultPath: "robot-motion.log", filters: [{ name: "Log", extensions: ["log"] }] });
      if (localPath) { await invoke("save_motion_log", { localPath, content }); setNotice("日志已导出（包含未过滤的保留记录）"); }
    } catch (error) { setNotice(`导出失败：${String(error)}`); }
    finally { setSaving(false); }
  }
  return <section className={`motion-terminal${collapsed ? " collapsed" : ""}`} aria-label="规划执行终端">
    <header><button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>{collapsed ? "▸" : "▾"} 规划执行日志</button>
      <span>{logs.length} 条 · 最近 5000 条 / 当前连接</span>
      {!collapsed && plannerLog && <select aria-label="规划日志来源" value={source} onChange={(event) => setSource(event.target.value)}><option value="audit">规划执行过程</option><option value="moveit">MoveIt 原始输出</option></select>}
    </header>
    {!collapsed && (source === "moveit" && plannerLog ? plannerLog : <>
      <div className="motion-terminal-tools"><input type="search" aria-label="搜索规划日志" placeholder="搜索命令、阶段或错误…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />跟随最新</label>
        <button type="button" disabled={!logs.length || saving} onClick={() => void download()}>导出日志</button>
      </div>
      {notice && <output>{notice}</output>}
      <pre ref={viewport} tabIndex={0} aria-label="规划日志输出"
        onWheel={() => { userScroll.current = true; }} onPointerDown={() => { userScroll.current = true; }}
        onTouchMove={() => { userScroll.current = true; }} onKeyDown={() => { userScroll.current = true; }}
        onScroll={() => { const node = viewport.current; if (node && userScroll.current) { userScroll.current = false; if (node.scrollHeight - node.scrollTop - node.clientHeight > 24) setFollow(false); } }}>
        {!logs.length ? "等待规划执行日志…" : !visible.length ? "没有匹配的日志" : visible.map(({ entry, text }, index) => <span key={index} className={`log-${entry.level}`}>{text}{"\n"}</span>)}
      </pre>
    </>)}
  </section>;
}
