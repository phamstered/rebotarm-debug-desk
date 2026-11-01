import { useEffect, useRef, useState } from "react";
import { DEPLOY_LOG_MAX_LINES } from "./deployLogLogic";

export function DeployProgressLog({ lines }: { lines: string[] }) {
  const viewport = useRef<HTMLPreElement>(null);
  const userScrollUntil = useRef(0);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [lines, follow]);
  const markUserScroll = () => { userScrollUntil.current = Date.now() + 1000; };
  return <section className="deploy-log" aria-label="Bridge 升级日志">
    <div className="deploy-log-tools"><span>升级日志 · {lines.length} 行 · 保留最近 {DEPLOY_LOG_MAX_LINES} 行</span>
      <label><input type="checkbox" checked={follow} onChange={(event) => { userScrollUntil.current = 0; setFollow(event.target.checked); }} />跟随最新</label>
    </div>
    <pre ref={viewport} className="deploy-progress" role="log" aria-label="Bridge 升级日志输出" aria-live="polite" aria-relevant="additions" tabIndex={0}
      onWheel={markUserScroll} onPointerDown={markUserScroll} onTouchMove={markUserScroll}
      onPointerMove={(event) => { if (event.buttons) markUserScroll(); }}
      onKeyDown={(event) => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) markUserScroll(); }}
      onScroll={() => {
        const node = viewport.current;
        if (node && Date.now() < userScrollUntil.current && node.scrollHeight - node.scrollTop - node.clientHeight > 24) setFollow(false);
      }}>{lines.map((line, index) => <span key={index}>{line}{"\n"}</span>)}</pre>
  </section>;
}
