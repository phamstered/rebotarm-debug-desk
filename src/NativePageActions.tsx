import { createContext, useContext, useId, useState } from "react";
import type { ReactNode } from "react";
import type { AppPage } from "./appNavigationLogic";
import type { NativePageState } from "./nativeWorkspaceLogic";
import { WorkspacePopover } from "./WorkspaceMenu";

type WindowCommand = "workspace_detach" | "workspace_dock" | "workspace_show_main" | "workspace_recover";
export type NativePageActionsState = {
  page: AppPage;
  state?: NativePageState;
  connected: boolean;
  profileName?: string;
  busyReason: string;
  onAction(command: WindowCommand, page: AppPage): void | Promise<void>;
};
export const NativePageActionsContext = createContext<NativePageActionsState | null>(null);

type IconName = "detach" | "dock" | "home" | "recover" | "connection" | "lock";
function WindowIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    detach: <><path d="M14 3h7v7m0-7-10 10" /><path d="M10 5H4a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6" /></>,
    dock: <><path d="M21 3 11 13m0-7v7h7" /><path d="M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6" /></>,
    home: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 9v11" /></>,
    recover: <><path d="M4 11a8 8 0 1 1 2 7M4 4v7h7" /></>,
    connection: <><path d="m9 15 6-6m-8 9-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4-3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(2 0) scale(.9 1)" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

/** Window chrome lives in each page's existing header, never in a separate row. */
export function NativePageActions() {
  const context = useContext(NativePageActionsContext);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const hintId = useId();
  if (!context) return null;
  const { page, state, connected, busyReason, profileName, onAction } = context;
  const standalone = state?.detached || state?.recovery_required;
  const blocked = pending ? "正在移动窗口" : busyReason || state?.busy_reason || (!state?.ready ? "页面加载中" : "");
  const label = state?.recovery_required ? "恢复窗口" : state?.detached ? "收回主窗口" : "拆出窗口";
  const command = state?.recovery_required ? "workspace_recover" : state?.detached ? "workspace_dock" : "workspace_detach";
  const hint = blocked ? `${label}不可用：${blocked}` : `${label}，保留当前页面内容`;
  const notice = error || state?.restore_pending || (state?.recovery_required ? "窗口移动未完成，请恢复" : standalone && !connected ? "连接已断开" : "");
  async function move() {
    if (blocked) return;
    setPending(true); setError("");
    try { await onAction(command, page); } catch (reason) { setError(String(reason)); }
    finally { setPending(false); }
  }
  async function showMain() {
    setError("");
    try { await onAction("workspace_show_main", page); } catch (reason) { setError(String(reason)); }
  }
  return <div className="native-page-actions" role="group" aria-label="窗口操作">
    {notice && <span className="native-window-notice" role="status" title={notice}>{notice}</span>}
    {standalone && <>
      <div className={`native-window-connection ${connected ? "is-connected" : "is-disconnected"}`} title="连接详情">
        <WorkspacePopover label="连接详情" active={state?.visible !== false} indicator={<WindowIcon name="connection" />}>
          <div className="native-window-details"><strong>{profileName || "未选择主机"}</strong><p>{connected ? "共享连接已就绪" : "未连接 · 请在主窗口连接机器人"}</p></div>
        </WorkspacePopover>
      </div>
      <button type="button" className="native-window-icon" aria-label="显示主窗口" title="显示主窗口，保留当前独立窗口" onClick={() => void showMain()}><WindowIcon name="home" /></button>
    </>}
    <span className="native-window-action-hint" tabIndex={blocked ? 0 : undefined} aria-label={blocked ? hint : undefined} aria-describedby={hintId}>
      <button type="button" className="native-window-icon" aria-label={label} title={hint} disabled={Boolean(blocked)} aria-describedby={hintId} onClick={() => void move()}>
        <WindowIcon name={state?.recovery_required ? "recover" : state?.detached ? "dock" : "detach"} />
        {blocked && <span className="native-window-lock"><WindowIcon name="lock" /></span>}
      </button>
      <span id={hintId} role="tooltip" className="native-window-tooltip">{hint}</span>
    </span>
  </div>;
}
