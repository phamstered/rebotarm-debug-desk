import { createPortal } from "react-dom";
import { useEffect, useId, useRef, type ReactNode } from "react";

type ModalShellProps = {
  title: string;
  onClose(): void;
  children: ReactNode;
  actions: ReactNode;
};

/** Shared modal surface with keyboard focus kept inside until dismissal. */
export function ModalShell({ title, onClose, children, actions }: ModalShellProps) {
  const dialog = useRef<HTMLElement>(null);
  const previousFocus = useRef(typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const close = useRef(onClose);
  close.current = onClose;
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previous = previousFocus.current;
    const focusable = () => Array.from(element.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [tabindex]',
    )).filter(node => !node.matches(':disabled') && node.tabIndex >= 0 && !node.closest('[hidden], [inert]')
      && getComputedStyle(node).display !== "none" && getComputedStyle(node).visibility !== "hidden");
    const focusInside = () => (focusable()[0] ?? element).focus();
    if (!element.contains(document.activeElement)) focusInside();
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !element.contains(event.target)) focusInside();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      } else if (event.key === "Tab") {
        const items = focusable();
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (!items.length || (event.shiftKey ? index <= 0 : index === items.length - 1 || index < 0)) {
          event.preventDefault();
          (event.shiftKey ? items.at(-1) ?? element : items[0] ?? element).focus();
        }
      }
    };
    document.addEventListener("focusin", onFocus);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("keydown", onKey, true);
      if (previous?.isConnected && !previous.closest("[hidden], [inert]")) previous.focus();
    };
  }, []);

  return createPortal(<div className="modal-backdrop">
    <section ref={dialog} className="toolbar-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <div className="toolbar-modal-title"><strong id={titleId}>{title}</strong><button type="button" aria-label={`关闭${title}`} onClick={onClose}>×</button></div>
      <div className="toolbar-modal-content">{children}</div>
      <div className="toolbar-modal-actions">{actions}</div>
    </section>
  </div>, document.body);
}
