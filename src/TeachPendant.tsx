import { useEffect, useState } from "react";
import { SavePoseDialog } from "./SavePoseDialog";
import { nextCapturedPoseName, type CustomPosition, type PositionDraft } from "./positionLogic";
import { positionsFromApi, teachLiveUrl, teachToken } from "./teachPendantLogic";

type Feedback = {
  bridgeConnected?: boolean;
  positions?: number[] | null;
  gripperPosition?: number | null;
  error?: string;
};

type Capture = { captureId: string; positions: number[]; gripperPosition?: number | null };

export function TeachPendant({
  href = window.location.href,
  fetchImpl = globalThis.fetch.bind(globalThis),
  openLive = defaultLiveSocket,
}: {
  href?: string;
  fetchImpl?: typeof fetch;
  openLive?: (url: string, onMessage: (data: string) => void) => () => void;
}) {
  const token = teachToken(new URL(href).search);
  const [feedback, setFeedback] = useState<Feedback>({});
  const [positions, setPositions] = useState<CustomPosition[]>([]);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [error, setError] = useState(token ? "" : "请在电脑上打开 Desk，开启「分享到手机」，再用给出的链接打开本页。");
  const [busy, setBusy] = useState(false);
  const ready = Boolean(token && feedback.bridgeConnected && !feedback.error && feedback.positions?.length === 6);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void loadPoses(fetchImpl, token).then((next) => { if (!cancelled) setPositions(next); }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    const close = openLive(teachLiveUrl(href), (data) => {
      try { setFeedback(JSON.parse(data) as Feedback); }
      catch { /* ignore a partial socket frame */ }
    });
    return () => { cancelled = true; close(); };
  }, [token, href, fetchImpl, openLive]);

  async function beginSave() {
    setError("");
    setBusy(true);
    try {
      const response = await fetchImpl("/api/teach/capture", { method: "POST", headers: { "X-Teach-Token": token, "Content-Type": "application/json" }, body: "{}" });
      const payload = await response.json().catch(() => ({})) as Capture & { error?: string };
      if (!response.ok) {
        setError(payload.error || "无法读取桌面端的当前姿态");
        return;
      }
      setCapture(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function save(draft: PositionDraft) {
    if (!capture) return "请重新点击保存当前姿态";
    const response = await fetchImpl("/api/teach/poses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Teach-Token": token },
      body: JSON.stringify({ name: draft.name, note: draft.note, captureId: capture.captureId, gripperPosition: draft.gripperPosition }),
    });
    const payload = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) return payload.error || "保存失败";
    setPositions(await loadPoses(fetchImpl, token));
    setCapture(null);
    return "";
  }

  return (
    <main className="teach-pendant">
      <header>
        <h1>姿态库</h1>
        <p>手机只连接这台电脑。当前关节来自电脑已经连上的 Jetson Bridge，保存写入电脑上的姿态库，不下发运动。</p>
      </header>
      {error && <p role="alert">{error}</p>}
      <section aria-label="当前关节">
        <h2>当前姿态</h2>
        {ready ? <p>{feedback.positions!.map((value) => value.toFixed(4)).join("  ")}</p> : <p>{feedback.error || (token ? "正在等待电脑转发关节反馈…" : "尚未连接电脑上的 Desk")}</p>}
      </section>
      <button type="button" className="teach-save" style={{ minHeight: 48 }} disabled={!ready || busy} onClick={() => void beginSave()}>保存当前姿态</button>
      <section aria-label="姿态库">
        <article className="teach-pose" aria-label="HOME">
          <div><strong>HOME</strong><span>锁定</span></div>
          <p>builtin:home · 不在手机上执行</p>
        </article>
        {positions.map((position) => (
          <article key={position.id} className="teach-pose" aria-label={position.name}>
            <strong>{position.name}</strong>
            <p>{position.positions.map((value) => value.toFixed(4)).join("  ")}</p>
          </article>
        ))}
        {positions.length === 0 && <p>还没有自定义点位。保存后会出现在这里，也会出现在电脑的姿态库。</p>}
      </section>
      {capture && <SavePoseDialog
        urdfXml=""
        onClose={() => setCapture(null)}
        initial={{
          name: nextCapturedPoseName(positions),
          positions: capture.positions,
          note: "",
          source: "feedback",
          gripperPosition: typeof capture.gripperPosition === "number" ? capture.gripperPosition : undefined,
        }}
        onSave={save}
      />}
    </main>
  );
}

async function loadPoses(fetchImpl: typeof fetch, token: string) {
  const response = await fetchImpl("/api/teach/poses", { headers: { "X-Teach-Token": token } });
  const payload = await response.json().catch(() => ({})) as { positions?: unknown; error?: string };
  if (!response.ok) throw new Error(payload.error || "无法读取桌面姿态库");
  return positionsFromApi(payload.positions);
}

function defaultLiveSocket(url: string, onMessage: (data: string) => void) {
  const socket = new WebSocket(url);
  socket.onmessage = (event) => { if (typeof event.data === "string") onMessage(event.data); };
  return () => socket.close();
}
