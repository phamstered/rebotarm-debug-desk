import { useEffect, useRef } from 'react';

/** Resize the actual panel edge, including when responsive CSS turns it into a drawer. */
export function UrdfPanelDivider({ side, value, active, onChange }: {
  side: 'tree' | 'properties'; value: number; active: boolean; onChange(value: number): void;
}) {
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => { if (!active) cleanup.current?.(); return () => cleanup.current?.(); }, [active]);
  const minimum = side === 'tree' ? 170 : 260;
  const maximum = side === 'tree' ? 360 : 460;
  const defaultWidth = side === 'tree' ? 230 : 320;
  const direction = side === 'tree' ? 1 : -1;
  const label = side === 'tree' ? '调整 URDF 结构树宽度' : '调整 URDF 参数面板宽度';

  function measure(handle: HTMLElement) {
    const panel = handle.parentElement!;
    const host = panel.closest('.urdf-inspector-body');
    const hostWidth = host?.getBoundingClientRect().width ?? 0;
    const other = host?.querySelector<HTMLElement>(side === 'tree' ? '.urdf-properties' : '.urdf-tree');
    const otherWidth = other && getComputedStyle(other).position !== 'absolute' ? other.getBoundingClientRect().width : 0;
    const available = hostWidth > 0
      ? getComputedStyle(panel).position === 'absolute' ? hostWidth * .85 : hostWidth - otherWidth - 200
      : maximum;
    const max = Math.max(0, Math.min(maximum, available));
    const min = Math.min(minimum, max);
    return { current: panel.getBoundingClientRect().width || value, clamp: (width: number) => Math.max(min, Math.min(max, width)) };
  }

  return <div className={`urdf-panel-divider urdf-panel-divider-${side}`} role="separator"
    tabIndex={active ? 0 : -1} aria-label={label} aria-orientation="vertical"
    aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={Math.round(value)}
    title={`${label}；拖动或方向键调整，双击恢复默认`}
    onDoubleClick={event => { if (active) onChange(measure(event.currentTarget).clamp(defaultWidth)); }}
    onKeyDown={event => {
      if (!active || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const { current, clamp } = measure(event.currentTarget);
      const next = event.key === 'Home' ? minimum : event.key === 'End' ? maximum
        : current + (event.key === 'ArrowRight' ? 1 : -1) * direction * (event.shiftKey ? 40 : 10);
      onChange(clamp(next));
    }}
    onPointerDown={event => {
      if (!active || event.button !== 0) return;
      event.preventDefault(); event.currentTarget.focus(); cleanup.current?.();
      const handle = event.currentTarget;
      const startWidth = measure(handle).current, startX = event.clientX, pointerId = event.pointerId;
      const oldCursor = document.body.style.cursor, oldSelection = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
      const move = (pointer: PointerEvent) => {
        if (pointer.pointerId === pointerId) onChange(measure(handle).clamp(startWidth + (pointer.clientX - startX) * direction));
      };
      const stop = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end); window.removeEventListener('blur', stop);
        document.body.style.cursor = oldCursor; document.body.style.userSelect = oldSelection; cleanup.current = null;
      };
      const end = (pointer: PointerEvent) => { if (pointer.pointerId === pointerId) stop(); };
      cleanup.current = stop;
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end); window.addEventListener('blur', stop);
    }}/>;
}
