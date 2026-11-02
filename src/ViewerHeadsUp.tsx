import type { ReactNode } from "react";
import { MotionDivider, useMotionLayout } from "./MotionLayout";

export function ViewerHeadsUp({ error, leading, children, rgbd }: { error: string; leading?: ReactNode; children: ReactNode; rgbd?: ReactNode }) {
  const layout = useMotionLayout();
  if (layout) return <div className="viewer-heads-up motion-viewer-panels">
    <section className="motion-viewer-status" aria-label="运动状态面板">
      <div className="motion-state-details">{leading}{error && <div className="viewer-error" role="alert">{error}</div>}</div>
      {rgbd && <><MotionDivider size="rgbdHeight" label="调整 RGBD 面板高度" axis="y" edge="end" panel=".motion-rgbd-panel" container=".motion-viewer-status" maxFraction={.7} />
        <div className="motion-rgbd-panel" aria-label="RGBD 面板">{rgbd}</div></>}
    </section>
    <MotionDivider size="statusWidth" label="调整运动状态宽度" axis="x" panel=".motion-viewer-status" container=".viewer-layout" maxFraction={.4} className="motion-status-divider" />
    <MotionDivider size="controlsWidth" label="调整 Robot View 操作区宽度" axis="x" edge="end" panel=".motion-viewer-controls" container=".viewer-layout" maxFraction={.4} className="motion-controls-divider" />
    <MotionDivider size="toolsHeight" label="调整 Robot View 下方面板高度" axis="y" edge="end" panel=".motion-viewer-controls" container=".viewer-layout" maxFraction={.65} className="motion-tools-divider" />
    <section className="motion-viewer-controls" aria-label="Robot View 操作面板">
      <div className="viewer-overlay" aria-live="polite">{children}</div>
    </section>
  </div>;
  return <div className="viewer-heads-up">
    {leading}
    {error && <div className="viewer-error" role="alert">{error}</div>}
    <div className="viewer-overlay" aria-live="polite">{children}{rgbd}</div>
  </div>;
}
