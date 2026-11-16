import type { ComponentProps, ReactNode } from "react";

const paths = {
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.5-2L20 8M4 16l2.4 3A7 7 0 0 0 17.9 17" /></>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
  upload: <><path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5" /></>,
  save: <><path d="M20 21H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h13l4 4v13a1 1 0 0 1-1 1Z" /><path d="M7 3v6h9V3M7 21v-8h10v8" /></>,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></>,
  clear: <><path d="m15 3 6 6-11 11H4l-3-3L15 3ZM8 10l6 6M10 20h11" /></>,
  edit: <><path d="m15 4 5 5M3 21l5-1L21 7l-5-5L3 15v6Z" /></>,
  plus: <path d="M12 4v16M4 12h16" />,
  minus: <path d="M4 12h16" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  fit: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" /><rect x="7" y="7" width="10" height="10" rx="1" /></>,
  expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
  restore: <path d="M3 8h5V3m8 0v5h5M3 16h5v5m8 0v-5h5" />,
  reset: <><path d="M3 4v6h6" /><path d="M3 10a9 9 0 1 1 2 8" /></>,
  settings: <><path d="M4 3v18M12 3v18M20 3v18" /><path d="M1 8h6M9 16h6M17 8h6" /></>,
  link: <><path d="m10 13 4-4m-5 8-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2-2 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" /></>,
  pause: <><path d="M8 4v16M16 4v16" /></>,
  play: <path d="m7 3 14 9-14 9V3Z" />,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  unlock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8-1" /></>,
  focus: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" /><circle cx="12" cy="12" r="3" /></>,
  layout: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 9v12" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  undo: <><path d="M9 4 3 10l6 6M3 10h10a7 7 0 0 1 7 7v3" /></>,
  redo: <><path d="m15 4 6 6-6 6m6-6H11a7 7 0 0 0-7 7v3" /></>,
  up: <path d="m5 12 7-7 7 7M12 5v15" />,
  down: <path d="m5 12 7 7 7-7M12 19V4" />,
} satisfies Record<string, ReactNode>;

export type ActionIconName = keyof typeof paths;
export function ActionIcon({ name }: { name: ActionIconName }) {
  return <svg className="action-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

type ButtonProps = ComponentProps<"button">;
/** Keeps native button semantics, handlers, form behaviour and safety gates intact. */
export function ActionButton({ className = "", type, ...props }: ButtonProps) {
  return <button type={type} className={`ui-button ${className}`} {...props} />;
}

type IconButtonProps = Omit<ButtonProps, "children" | "aria-label"> & {
  icon: ActionIconName;
  label: string;
  busy?: boolean;
  size?: "default" | "compact";
};
export function IconButton({ icon, label, busy = false, size = "default", disabled, title, type = "button", className = "", ...props }: IconButtonProps) {
  const hint = title ? (title.startsWith(label) ? title : `${label} · ${title}`) : label;
  const pending = busy || props["aria-busy"] === true || props["aria-busy"] === "true";
  return <ActionButton {...props} type={type} className={`ui-icon-button ${size === "compact" ? "ui-button-compact" : ""} ${icon === "trash" ? "danger" : ""} ${className}`} aria-label={label} title={pending ? `${hint}（处理中…）` : hint} aria-busy={pending} disabled={disabled || busy}>
    <ActionIcon name={pending ? "refresh" : icon} />
  </ActionButton>;
}
