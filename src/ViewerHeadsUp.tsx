import type { ReactNode } from "react";

export function ViewerHeadsUp({ error, leading, children }: { error: string; leading?: ReactNode; children: ReactNode }) {
  return (
    <div className="viewer-heads-up">
      {leading}
      {error && <div className="viewer-error" role="alert">{error}</div>}
      <div className="viewer-overlay" aria-live="polite">{children}</div>
    </div>
  );
}
