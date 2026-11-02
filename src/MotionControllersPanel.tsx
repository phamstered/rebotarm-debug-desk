import { useEffect, useState } from "react";
import { controllerStatusFresh } from "./controllersInfoLogic";
import { ControllerList } from "./ControllerList";
import { ModalShell } from "./ModalShell";
import type { ControllerInfo, RosControlStatus } from "./types";
export type ControllerSwitchAction = "activate" | "deactivate";
export type ControllerAction = { name: string; action: ControllerSwitchAction };
export type MotionControllersPanelProps = {
  status: RosControlStatus | null;
  refreshing: boolean;
  onRefresh(): void;
  onSwitch(
    controller: ControllerInfo,
    action: ControllerSwitchAction,
  ): void | Promise<void>;
  action: ControllerAction | null;
  message: string;
  error: string;
  disabledReason: string;
  focusController?: string;
  onInspect?(name: string): void;
  active?: boolean;
};
export function MotionControllersPanel({
  status,
  refreshing,
  onRefresh,
  onSwitch,
  action,
  message,
  error,
  disabledReason,
  focusController,
  onInspect,
  active = true,
}: MotionControllersPanelProps) {
  const [pending, setPending] = useState<{
    controller: ControllerInfo;
    action: ControllerSwitchAction;
  } | null>(null);
  useEffect(() => {
    if (!active) setPending(null);
  }, [active]);
  const block =
    disabledReason ||
    (action ? "控制器操作进行中" : refreshing ? "正在刷新控制器状态" : "");
  const selected =
    pending &&
    status?.controllers.find(
      (c) =>
        c.name === pending.controller.name &&
        c.typeName === pending.controller.typeName,
    );
  const confirmBlock =
    block ||
    (!controllerStatusFresh(status)
      ? "Controller 状态未确认新鲜"
      : !selected ||
          selected.state !==
            (pending?.action === "activate" ? "inactive" : "active")
        ? "控制器状态已改变，请取消后重新选择"
        : "");
  return (
    <section className="motion-controllers-panel" aria-label="Controller 管理">
      <header>
        <h2>Controller 管理</h2>
        <button
          type="button"
          disabled={Boolean(action) || refreshing || Boolean(disabledReason)}
          onClick={onRefresh}
        >
          {refreshing ? "刷新中…" : "刷新 Controllers"}
        </button>
      </header>
      {disabledReason && (
        <p className="controller-disabled-reason">{disabledReason}</p>
      )}
      {error && (
        <p className="controller-action-feedback error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="controller-action-feedback success" role="status">
          {message}
        </p>
      )}
      <ControllerList
        status={status}
        focusController={focusController}
        onInspect={(name) => onInspect?.(name)}
        renderActions={(controller) => {
          const allowed =
            controller.state === "active" || controller.state === "inactive";
          const kind =
            controller.state === "active" ? "deactivate" : "activate";
          const why =
            block ||
            (!controllerStatusFresh(status)
              ? "Controller 状态未确认新鲜"
              : !allowed
                ? "仅 active/inactive 状态允许切换"
                : "");
          return (
            <button
              type="button"
              disabled={Boolean(why)}
              title={why || undefined}
              onClick={() => setPending({ controller, action: kind })}
              aria-label={`${kind === "activate" ? "激活" : "停用"} ${controller.name}`}
            >
              {action?.name === controller.name
                ? "处理中…"
                : !allowed
                  ? "不可切换"
                  : kind === "activate"
                    ? "Activate"
                    : "Deactivate"}
            </button>
          );
        }}
      />
      {pending && active && (
        <ModalShell
          title={`${pending.action === "activate" ? "激活" : "停用"} Controller`}
          onClose={() => setPending(null)}
          actions={
            <>
              <button type="button" autoFocus onClick={() => setPending(null)}>
                取消
              </button>
              <button
                type="button"
                disabled={Boolean(confirmBlock)}
                onClick={() => {
                  const chosen = pending;
                  setPending(null);
                  void onSwitch(chosen.controller, chosen.action);
                }}
              >
                {pending.action === "activate" ? "确认激活" : "确认停用"}
              </button>
            </>
          }
        >
          <div className="controller-confirmation">
            <p>{pending.controller.name}</p>
            <p>此操作会改变控制器输出与接口占用。确认现场允许切换后继续。</p>
            {confirmBlock && <p>{confirmBlock}</p>}
          </div>
        </ModalShell>
      )}
    </section>
  );
}
