import type { ReactNode } from "react";

export function ViewerHeadsUp({ error, children }: { error: string; children: ReactNode }) {
  return (
    <div className="viewer-heads-up">
      {error && <div className="viewer-error" role="alert">{error}</div>}
      <div className="viewer-overlay" aria-live="polite">{children}</div>
    </div>
  );
}
