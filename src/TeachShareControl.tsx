import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ModalShell } from "./ModalShell";

type ShareInfo = { url: string; port: number; lanIp: string; bridgeConnected: boolean };

export function TeachShareControl({ profileKey, bridgeConnected }: { profileKey: string; bridgeConnected: boolean }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void invoke<ShareInfo | null>("teach_share_status").then((current) => {
      if (!cancelled && current?.url) setInfo(current);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  async function start() {
    setBusy(true);
    setError("");
    try {
      const started = await invoke<ShareInfo>("teach_share_start", { profileKey });
      setInfo(started);
      setCopied(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await invoke("teach_share_stop");
      setInfo(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.url);
      setCopied(true);
    } catch {
      setError("无法复制，请手动选择链接");
    }
  }

  return <>
    <button type="button" className={bridgeConnected ? "toolbar-action" : "ghost"} onClick={() => setOpen(true)}>分享到手机</button>
    {open && <ModalShell title="分享到手机" onClose={() => setOpen(false)} actions={info ? <>
      <button type="button" onClick={() => void stop()} disabled={busy}>停止分享</button>
      <button type="button" className="primary" onClick={() => void copy()}>复制链接</button>
    </> : <button type="button" className="primary" onClick={() => void start()} disabled={busy}>开始分享</button>}>
      <p>开启后，这台电脑会在局域网提供姿态页面。手机只访问下面的地址；关节反馈和保存都由当前桌面 Bridge 会话转发，手机不连接 Jetson。</p>
      <p>{bridgeConnected ? "Bridge 已连接，手机可以保存当前姿态。" : "Bridge 尚未连接。手机可以打开页面，但保存会失败，直到这台电脑连上 Jetson。"}</p>
      {info && <label>手机链接<input aria-label="手机链接" readOnly value={info.url} /></label>}
      {copied && <p role="status">已复制</p>}
      {error && <p role="alert">{error}</p>}
    </ModalShell>}
  </>;
}
