import "./workspace.css";
import { createPortal } from "react-dom";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type MouseEvent,
  type KeyboardEvent,
} from "react";

export type WorkspaceAction = {
  label: string;
  run(): void;
  disabled?: boolean;
  danger?: boolean;
};
export function isEditingTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"]',
    )
  );
}

/** Shared pointer/keyboard menu. Callbacks come from the current render, never a stale selection. */
export function useWorkspaceMenu(
  actions: WorkspaceAction[],
  label: string,
  active = true,
) {
  const [anchor, setAnchor] = useState<{
    x: number;
    y: number;
    source: HTMLElement | null;
  } | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const close = (restore = false) => {
    if (restore && anchor?.source?.isConnected) anchor.source.focus();
    setAnchor(null);
  };
  const open = (
    event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
  ) => {
    if (!active || isEditingTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    const source =
      event.target instanceof HTMLElement ? event.target : event.currentTarget;
    const rect = source.getBoundingClientRect();
    const pointer =
      "clientX" in event && (event.clientX !== 0 || event.clientY !== 0);
    setAnchor({
      x: pointer ? event.clientX : rect.left,
      y: pointer ? event.clientY : rect.bottom,
      source,
    });
  };
  useEffect(() => {
    if (!active) setAnchor(null);
  }, [active]);
  useEffect(() => {
    if (!anchor) return;
    const outside = (e: Event) => {
      if (!host.current?.contains(e.target as Node)) setAnchor(null);
    };
    const resize = () => setAnchor(null);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", resize);
    window.addEventListener("blur", resize);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", resize);
      window.removeEventListener("blur", resize);
    };
  }, [anchor]);
  useLayoutEffect(() => {
    if (!anchor || !host.current) return;
    const el = host.current,
      r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(anchor.x, innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(anchor.y, innerHeight - r.height - 8))}px`;
    (el.querySelector<HTMLElement>("button:not(:disabled)") ?? el).focus();
  }, [anchor]);
  const menu =
    anchor && active
      ? createPortal(
          <div
            ref={host}
            className="workspace-menu"
            role="menu"
            aria-label={label}
            tabIndex={-1}
            style={{ left: anchor.x, top: anchor.y }}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={(event) => {
              const items = Array.from(
                host.current?.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ) ?? [],
              );
              const index = items.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              if (event.key === "Escape" || event.key === "Tab") {
                event.preventDefault();
                event.stopPropagation();
                close(true);
              }
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                event.stopPropagation();
                const at =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : (index +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          items.length) %
                        items.length;
                items[at]?.focus();
              }
            }}
          >
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                role="menuitem"
                disabled={action.disabled}
                className={action.danger ? "danger" : ""}
                onClick={() => {
                  close(true);
                  action.run();
                }}
              >
                {action.label}
              </button>
            ))}
          </div>,
          document.body,
        )
      : null;
  return {
    menu,
    onContextMenu: open,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (
        event.key === "ContextMenu" ||
        (event.key === "F10" && event.shiftKey)
      )
        open(event);
    },
    trigger: (
      <button
        type="button"
        className="workspace-more"
        aria-label={`${label}菜单`}
        title={label}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        disabled={!active}
        onClick={open}
      >
        ⋯
      </button>
    ),
  };
}

export function WorkspacePopover({
  label,
  children,
  indicator,
  active = true,
}: {
  active?: boolean;
  label: string;
  children: ReactNode;
  indicator?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  useLayoutEffect(() => {
    if (!open || !active || !root.current || !content.current) return;
    const trigger = root.current
        .querySelector("button")!
        .getBoundingClientRect(),
      panel = content.current.getBoundingClientRect();
    content.current.style.left = `${Math.max(8, Math.min(trigger.right - panel.width, innerWidth - panel.width - 8))}px`;
    content.current.style.top = `${Math.max(8, Math.min(trigger.bottom + 7 + panel.height > innerHeight - 8 ? trigger.top - panel.height - 7 : trigger.bottom + 7, innerHeight - panel.height - 8))}px`;
  }, [open, active]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      if (
        !root.current?.contains(e.target as Node) &&
        !content.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    const resize = () => setOpen(false);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", resize);
    };
  }, [open]);
  return (
    <div
      ref={root}
      className="workspace-popover"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          setOpen(false);
          root.current?.querySelector("button")?.focus();
        }
      }}
    >
      <button
        type="button"
        className="workspace-popover-toggle"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {indicator ?? label}
      </button>
      {open &&
        active &&
        createPortal(
          <div
            ref={content}
            style={{ position: "fixed", right: "auto", top: 0, left: 0 }}
            className="workspace-popover-content"
            role="region"
            aria-label={label}
          >
            {children}
          </div>,
          document.body,
        )}
    </div>
  );
}
