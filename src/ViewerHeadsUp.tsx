import type { ReactNode } from "react";
import { useMotionLayout } from "./MotionLayout";
import { ViewerFloatingPanels } from "./ViewerFloatingPanels";

export function ViewerHeadsUp({ error, leading, children, rgbd }: { error: string; leading?: ReactNode; children: ReactNode; rgbd?: ReactNode }) {
  const layout = useMotionLayout();
  if (layout) return <ViewerFloatingPanels error={error} leading={leading} rgbd={rgbd}>{children}</ViewerFloatingPanels>;
  return <div className="viewer-heads-up">
    {leading}
    {error && <div className="viewer-error" role="alert">{error}</div>}
    <div className="viewer-overlay" aria-live="polite">{children}{rgbd}</div>
  </div>;
}
