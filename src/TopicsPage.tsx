import type { CSSProperties, ReactNode } from "react";

/** Topics owns its layout; motion scenes live exclusively in MotionPage. */
export function TopicsPage({ active, className = "", style, children }: {
  active: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return <main className={`workspace topics-workspace ${className}`} style={style} hidden={!active} aria-label="Topics">{children}</main>;
}
