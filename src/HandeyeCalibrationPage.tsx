import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { BridgeClient } from "./bridge";
import type { ConnectionProfile } from "./types";
import { RosImagePreview } from "./RosImagePreview";
import {
  DEFAULT_BOARD,
  defaultHandeyeContext,
  handeyeConfigError,
  handeyeExport,
  handeyeSource,
  parseHandeyeDataset,
  sampleConflict,
  solverRequest,
} from "./handeyeLogic";
import type {
  HandeyeBoard,
  HandeyeCapture,
  HandeyeContext,
  HandeyeDataset,
  HandeyeDetection,
  HandeyeResult,
  HandeyeSample,
} from "./handeyeLogic";
import "./handeye.css";

export function useHandeyeSession(profile: ConnectionProfile) {
  const [board, setBoard] = useState<HandeyeBoard>({ ...DEFAULT_BOARD });
  const [context, setContext] = useState<HandeyeContext>(() =>
    defaultHandeyeContext(profile),
  );
  const [samples, setSamples] = useState<HandeyeSample[]>([]);
  const [sourceKey, setSourceKey] = useState("");
  const [method, setMethod] = useState("PARK");
  const [result, setResult] = useState<HandeyeResult | null>(null);
  const [boardConfirmed, setBoardConfirmed] = useState(false);
  return {
    board,
    setBoard,
    context,
    setContext,
    samples,
    setSamples,
    sourceKey,
    setSourceKey,
    method,
    setMethod,
    result,
    setResult,
    boardConfirmed,
    setBoardConfirmed,
  };
}
type Props = {
  session?: ReturnType<typeof useHandeyeSession>;
  profile: ConnectionProfile;
  bridge: BridgeClient;
  connected: boolean;
  active: boolean;
  onMotion(): void;
};
const explain = (e: unknown) => (e instanceof Error ? e.message : String(e));
export function HandeyeCalibrationPage({
  profile,
  bridge,
  connected,
  active,
  onMotion,
  session,
}: Props) {
  const [tab, setTab] = useState<"target" | "context" | "calibrate">("target");
  const internal = useHandeyeSession(profile);
  const {
    board,
    setBoard,
    context,
    setContext,
    samples,
    setSamples,
    sourceKey,
    setSourceKey,
    method,
    setMethod,
    result,
    setResult,
    boardConfirmed,
    setBoardConfirmed,
  } = session || internal;
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [boardImage, setBoardImage] = useState("");
  const [preview, setPreview] = useState("");
  const [quality, setQuality] = useState<HandeyeDetection | null>(null);
  const [frames, setFrames] = useState<string[]>([]);
  const [role, setRole] = useState<"training" | "validation">("training");
  const [selected, setSelected] = useState("");
  const [image, setImage] = useState<unknown>(null);
  const [live, setLive] = useState(true);
  const generation = useRef(0),
    inflight = useRef(false),
    mounted = useRef(true);
  const currentSource = handeyeSource(profile);
  useEffect(() => {
    generation.current++;
    setImage(null);
    setFrames([]);
    setError("");
  }, [currentSource, connected, active]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (!active || !connected || !live) return;
    let alive = true;
    let last = 0;
    const stop = bridge.onMessage((m) => {
      if (
        alive &&
        m.op === "topic_message" &&
        m.topic === context.image_topic
      ) {
        last = Date.now();
        setImage(m.data);
      }
      if (m.op === "disconnected") {
        alive = false;
        setImage(null);
      }
    });
    void bridge
      .request({
        op: "subscribe",
        topic: context.image_topic,
        type: "sensor_msgs/msg/Image",
      })
      .catch((e) => {
        if (alive) setError(explain(e));
      });
    const timer = window.setInterval(() => {
      if (last && Date.now() - last > 1000) setImage(null);
    }, 500);
    return () => {
      stop();
      window.clearInterval(timer);
      if (alive)
        void bridge
          .request({ op: "unsubscribe", topic: context.image_topic })
          .catch(() => {});
      alive = false;
      setImage(null);
    };
  }, [bridge, active, connected, live, context.image_topic, currentSource]);
  const dataset: HandeyeDataset = {
    version: 1,
    board,
    context,
    source_key: sourceKey,
    samples,
  };
  const configError = handeyeConfigError(board, context);
  const training = samples.filter((s) => s.role === "training").length,
    validation = samples.filter((s) => s.role === "validation").length;
  const locked = samples.length > 0 || Boolean(busy);
  const canCapture =
    connected &&
    active &&
    !busy &&
    !configError &&
    boardConfirmed &&
    (!sourceKey || sourceKey === currentSource) &&
    samples.length < 200;
  const datasetRef = useRef(dataset);
  datasetRef.current = dataset;
  async function run(
    label: string,
    work: (valid: () => boolean) => Promise<void>,
  ) {
    if (inflight.current) return;
    inflight.current = true;
    const epoch = generation.current;
    setBusy(label);
    setError("");
    setNotice("");
    const valid = () => mounted.current && generation.current === epoch;
    try {
      await work(valid);
    } catch (e) {
      if (valid()) setError(explain(e));
    } finally {
      inflight.current = false;
      if (mounted.current) setBusy("");
    }
  }
  function editBoard<K extends keyof HandeyeBoard>(
    key: K,
    value: HandeyeBoard[K],
  ) {
    setBoard((b) => ({ ...b, [key]: value }));
    setBoardImage("");
    setBoardConfirmed(false);
    setResult(null);
    setQuality(null);
    setPreview("");
  }
  function editContext<K extends keyof HandeyeContext>(
    key: K,
    value: HandeyeContext[K],
  ) {
    setContext((c) => ({ ...c, [key]: value }));
    setResult(null);
    setQuality(null);
    setPreview("");
  }
  async function saveFile(filename: string, content: string, ext: string) {
    const path = await save({
      defaultPath: filename,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (path) await invoke("handeye_save", { path, content });
  }
  function capture(record: boolean) {
    void run(
      record ? "采样中（等待停稳与同步帧）" : "检测标定板",
      async (valid) => {
        const capture = await invoke<HandeyeCapture>("handeye_capture", {
          profile,
          config: { ...context, mode: record ? "capture" : "preview" },
        });
        if (!valid()) return;
        setPreview(capture.image_png);
        setQuality(null);
        const detection = await invoke<HandeyeDetection>("handeye_local", {
          request: {
            op: "detect",
            board,
            image_png: capture.image_png,
            k: capture.k,
            d: capture.d,
            distortion_model: capture.distortion_model,
          },
        });
        if (!valid()) return;
        setPreview(detection.annotated_png);
        setQuality(detection);
        if (record) {
          const conflict = sampleConflict(datasetRef.current.samples, capture);
          if (conflict) throw new Error(conflict);
          const total =
            datasetRef.current.samples.reduce(
              (n, s) =>
                n +
                s.capture.image_png.length +
                s.detection.annotated_png.length,
              0,
            ) +
            capture.image_png.length +
            detection.annotated_png.length;
          if (total > 120 * 1024 * 1024)
            throw new Error("数据集已达到 120 MiB，请保存后新建数据集");
          const sample: HandeyeSample = {
            id: crypto.randomUUID(),
            role,
            capture,
            detection,
          };
          setSamples((s) => [...s, sample]);
          setSelected(sample.id);
          setSourceKey(currentSource);
          setResult(null);
          setNotice(
            `${role === "training" ? "训练" : "独立复验"}样本已保存；未发送运动指令`,
          );
        }
      },
    );
  }
  function solve() {
    void run("Mac 本地求解", async (valid) => {
      const next = await invoke<HandeyeResult>("handeye_local", {
        request: solverRequest(dataset, method),
      });
      if (valid()) {
        setResult(next);
        setNotice(
          next.validated
            ? "独立复验满足当前误差门槛；生产配置尚未应用"
            : "已求解；请查看误差并补充至少 3 个新的复验姿态",
        );
      }
    });
  }
  const shown = samples.find((s) => s.id === selected);
  return (
    <section className="handeye-page" aria-label="手眼标定">
      <header className="handeye-header">
        <div>
          <h1>手眼标定</h1>
          <p>配置标定板 → 选择坐标系 → 采样与求解 · Mac 本地计算</p>
        </div>
        <button onClick={onMotion}>前往 Motion 调整姿态</button>
      </header>
      <div className="handeye-tabs" role="tablist" aria-label="标定步骤">
        {(
          [
            ["target", "Target · 标定板"],
            ["context", "Context · 坐标系"],
            ["calibrate", "Calibrate · 采样求解"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {busy && <p role="status">{busy}…</p>}
      {error && (
        <p role="alert" className="handeye-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="handeye-notice">
          {notice}
        </p>
      )}
      {!connected && (
        <p className="handeye-warning">
          未连接 Jetson。仍可配置标定板、载入样本、求解和导出。
        </p>
      )}
      {configError && <p className="handeye-warning">{configError}</p>}
      {sourceKey && sourceKey !== currentSource && (
        <p className="handeye-warning">
          样本来自另一个连接配置，仅允许离线操作；新建数据集后再采样。
        </p>
      )}
      <div className="handeye-workspace">
        <div className="handeye-controls">
          {tab === "target" && (
            <div role="tabpanel" aria-label="Target">
              <h2>Calibration target</h2>
              <fieldset disabled={locked}>
                <label>
                  Target type
                  <select
                    value={board.kind}
                    onChange={(e) =>
                      editBoard("kind", e.target.value as HandeyeBoard["kind"])
                    }
                  >
                    <option value="charuco">ChArUco</option>
                    <option value="aruco">ArUco Grid</option>
                  </select>
                </label>
                <label>
                  ArUco dictionary
                  <select
                    value={board.dictionary}
                    onChange={(e) => editBoard("dictionary", e.target.value)}
                  >
                    {["DICT_4X4_50", "DICT_5X5_250", "DICT_6X6_250"].map(
                      (v) => (
                        <option key={v}>{v}</option>
                      ),
                    )}
                  </select>
                </label>
                <div className="handeye-fields">
                  {(["squares_x", "squares_y"] as const).map((key, i) => (
                    <label key={key}>
                      {i ? "Squares, Y" : "Squares, X"}
                      <input
                        type="number"
                        min="3"
                        max="30"
                        value={board[key]}
                        onChange={(e) => editBoard(key, Number(e.target.value))}
                      />
                    </label>
                  ))}
                </div>
                <label>
                  {board.kind === "charuco" ? "Square length" : "Marker pitch"}{" "}
                  · 实测 mm
                  <input
                    type="number"
                    step="0.1"
                    value={board.square_m * 1000}
                    onChange={(e) =>
                      editBoard("square_m", Number(e.target.value) / 1000)
                    }
                  />
                </label>
                <label>
                  Marker length · 实测 mm
                  <input
                    type="number"
                    step="0.01"
                    value={board.marker_m * 1000}
                    onChange={(e) =>
                      editBoard("marker_m", Number(e.target.value) / 1000)
                    }
                  />
                </label>
                <label className="handeye-check">
                  <input
                    type="checkbox"
                    checked={board.legacy_pattern}
                    onChange={(e) =>
                      editBoard("legacy_pattern", e.target.checked)
                    }
                  />
                  兼容旧版 RViz / OpenCV 标定板排列
                </label>
              </fieldset>
              <p>
                尺寸填写黑白格或标记本体的实测边长，不包含打印纸白边。更换布局后需要重新打印标定板。
              </p>
              <div className="handeye-actions">
                <button
                  disabled={Boolean(busy) || Boolean(configError)}
                  onClick={() =>
                    void run("生成标定板", async (valid) => {
                      const r = await invoke<{ image_png: string }>(
                        "handeye_local",
                        { request: { op: "board", board } },
                      );
                      if (valid()) setBoardImage(r.image_png);
                    })
                  }
                >
                  Create target · 预览
                </button>
                <button
                  disabled={!boardImage || Boolean(busy)}
                  onClick={() =>
                    void run("保存标定板", async () =>
                      saveFile("handeye-board.png", boardImage, "png"),
                    )
                  }
                >
                  Save target
                </button>
              </div>
              <label className="handeye-check">
                <input
                  type="checkbox"
                  disabled={locked}
                  checked={boardConfirmed}
                  onChange={(e) => setBoardConfirmed(e.target.checked)}
                />
                已核对实体标定板布局及实测尺寸
              </label>
              {samples.length > 0 && (
                <p>
                  已有样本，Target / Context 已锁定。修改前请保存并清空样本。
                </p>
              )}
            </div>
          )}
          {tab === "context" && (
            <div role="tabpanel" aria-label="Context">
              <h2>General settings / Frames selection</h2>
              <fieldset disabled={locked}>
                <label>
                  Sensor configuration
                  <select
                    value={context.mode}
                    onChange={(e) =>
                      editContext(
                        "mode",
                        e.target.value as HandeyeContext["mode"],
                      )
                    }
                  >
                    <option value="eye_in_hand">Eye-in-hand · 腕部相机</option>
                    <option value="eye_to_hand">Eye-to-hand · 固定相机</option>
                  </select>
                </label>
                <p>
                  {context.mode === "eye_in_hand"
                    ? "标定板固定在桌面，移动腕部相机；整个采集过程不要挪动标定板。"
                    : "相机固定，标定板刚性固定在末端；整个采集过程不要挪动相机或标定板安装位置。"}
                </p>
                {(
                  [
                    ["image_topic", "Image topic"],
                    ["camera_info_topic", "CameraInfo topic"],
                    ["joint_topic", "Measured joint topic"],
                    ["sensor_frame", "Sensor frame（光学帧）"],
                    ["eef_frame", "End-effector frame"],
                    ["base_frame", "Robot base frame"],
                    ["camera_body_frame", "Camera body frame（导出用）"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      list={
                        key.endsWith("frame") ? "handeye-frames" : undefined
                      }
                      value={context[key]}
                      onChange={(e) => editContext(key, e.target.value)}
                    />
                  </label>
                ))}
                <label>
                  Object frame
                  <input readOnly value="handeye_target（由标定板检测生成）" />
                </label>
              </fieldset>
              <datalist id="handeye-frames">
                {frames.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
              <button
                disabled={!connected || Boolean(busy) || Boolean(configError)}
                onClick={() =>
                  void run("读取 TF Frames", async (valid) => {
                    const r = await invoke<{ frames: string[] }>(
                      "handeye_capture",
                      { profile, config: { ...context, mode: "frames" } },
                    );
                    if (valid()) {
                      setFrames(r.frames);
                      setNotice(
                        `发现 ${r.frames.length} 个 Frame，可在输入框下拉选择`,
                      );
                    }
                  })
                }
              >
                刷新 Frames
              </button>
              <p>
                无需 RViz 或 MoveGroup。采样按原始 RGB 时间读取基座到末端
                TF，不使用已有相机外参反推末端位置。
              </p>
            </div>
          )}
          {tab === "calibrate" && (
            <div role="tabpanel" aria-label="Calibrate">
              <h2>Pose samples</h2>
              <div className="handeye-metrics">
                <strong>
                  {training}
                  <small>训练样本 / 至少 8</small>
                </strong>
                <strong>
                  {validation}
                  <small>独立复验 / 至少 3</small>
                </strong>
                <strong>
                  {samples.length}
                  <small>总样本</small>
                </strong>
              </div>
              <p>
                建议采集 12–20
                个不同姿态，绕至少两个不同方向旋转。每次停稳后点击 Take
                sample。训练后再采集新的复验姿态。
              </p>
              <label>
                下一样本用途
                <select
                  disabled={Boolean(busy)}
                  value={role}
                  onChange={(e) => setRole(e.target.value as typeof role)}
                >
                  <option value="training">训练 · 用于求解</option>
                  <option value="validation">独立复验 · 不参与求解</option>
                </select>
              </label>
              <div className="handeye-actions">
                <button
                  className="primary"
                  disabled={!canCapture}
                  onClick={() => capture(true)}
                >
                  Take sample · 采样
                </button>
                <button
                  disabled={!samples.length || Boolean(busy)}
                  onClick={() => {
                    setSamples((s) => s.slice(0, -1));
                    setResult(null);
                    setSelected("");
                  }}
                >
                  Delete latest sample
                </button>
              </div>
              {!boardConfirmed && (
                <p className="handeye-warning">
                  请先在 Target 核对实体标定板尺寸。
                </p>
              )}
              <div className="handeye-actions">
                <button
                  disabled={Boolean(busy)}
                  onClick={() => {
                    setSamples([]);
                    setSourceKey("");
                    setResult(null);
                    setSelected("");
                    setPreview("");
                    setQuality(null);
                  }}
                >
                  Clear all samples
                </button>
                <button
                  disabled={!samples.length || Boolean(busy)}
                  onClick={() =>
                    void run("保存样本", async () =>
                      saveFile(
                        "handeye-samples.json",
                        JSON.stringify(dataset, null, 2),
                        "json",
                      ),
                    )
                  }
                >
                  Save samples
                </button>
                <label className="handeye-file">
                  Load samples
                  <input
                    aria-label="Load samples"
                    type="file"
                    accept=".json"
                    disabled={Boolean(busy)}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      void run("载入样本", async (valid) => {
                        if (file.size > 128 * 1024 * 1024)
                          throw new Error("样本文件超过 128 MiB");
                        const data = parseHandeyeDataset(await file.text());
                        if (valid()) {
                          setBoard(data.board);
                          setContext(data.context);
                          setSamples(data.samples);
                          setSourceKey(data.source_key);
                          setResult(null);
                          setSelected("");
                          setBoardConfirmed(true);
                          setNotice(
                            "样本已载入；请重新求解，旧求解结果不会被信任",
                          );
                        }
                      });
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
              <label>
                Solver
                <select
                  disabled={Boolean(busy)}
                  value={method}
                  onChange={(e) => {
                    setMethod(e.target.value);
                    setResult(null);
                  }}
                >
                  {["PARK", "TSAI", "HORAUD", "ANDREFF", "DANIILIDIS"].map(
                    (m) => (
                      <option key={m}>{m}</option>
                    ),
                  )}
                </select>
              </label>
              <button
                className="primary"
                disabled={training < 8 || Boolean(busy)}
                onClick={solve}
              >
                Solve · 求解 / 复验
              </button>
              {result && (
                <div className="handeye-result">
                  <h3>
                    {result.validated
                      ? "独立复验通过"
                      : "已求解 · 尚未通过独立复验"}
                  </h3>
                  <p>
                    训练最大偏差{" "}
                    {(result.training.translation_max_m * 1000).toFixed(2)} mm /{" "}
                    {result.training.rotation_max_deg.toFixed(2)}°
                  </p>
                  <p>
                    复验最大偏差{" "}
                    {validation
                      ? `${(result.validation.translation_max_m * 1000).toFixed(2)} mm / ${result.validation.rotation_max_deg.toFixed(2)}°`
                      : "未采集"}
                  </p>
                  <p>参考门槛：最大偏差 ≤ 5 mm / 2°，至少 3 个独立复验姿态。</p>
                  <p>
                    {context.mode === "eye_in_hand"
                      ? context.eef_frame
                      : context.base_frame}{" "}
                    ← {context.sensor_frame}
                  </p>
                  <pre>
                    {[0, 1, 2, 3]
                      .map((r) =>
                        result.transform
                          .slice(r * 4, r * 4 + 4)
                          .map((n) => n.toFixed(6))
                          .join("  "),
                      )
                      .join("\n")}
                  </pre>
                  <button
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void run("导出外参", async () =>
                        saveFile(
                          "handeye-camera-pose.json",
                          JSON.stringify(
                            handeyeExport(dataset, result),
                            null,
                            2,
                          ),
                          "json",
                        ),
                      )
                    }
                  >
                    Save camera pose · 导出外参
                  </button>
                  <p>
                    导出包含光学帧及 camera body
                    换算。未写入生产配置，也不代表桌面/顶面几何已核验。
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="handeye-view">
          <div className="handeye-actions">
            <label className="handeye-check">
              <input
                type="checkbox"
                checked={live}
                onChange={(e) => setLive(e.target.checked)}
              />
              实时 RGB
            </label>
            <button
              disabled={!connected || Boolean(busy) || Boolean(configError)}
              onClick={() => capture(false)}
            >
              检测标定板
            </button>
          </div>
          {live && <RosImagePreview data={image} />}
          {tab === "target" && boardImage && (
            <figure>
              <img
                src={`data:image/png;base64,${boardImage}`}
                alt="生成的标定板"
              />
              <figcaption>打印后按实测格子尺寸核对比例</figcaption>
            </figure>
          )}
          {(shown?.detection.annotated_png || preview) && (
            <figure>
              <img
                src={`data:image/png;base64,${shown?.detection.annotated_png || preview}`}
                alt="标定板角点与坐标轴"
              />
              <figcaption>
                {shown ? "所选样本" : "最近一次检测"} · 图像不是实时检测结果
              </figcaption>
            </figure>
          )}
          {(shown?.detection || quality) && (
            <p>
              {(shown?.detection || quality)!.corners} 个角点 · 重投影 RMS{" "}
              {(shown?.detection || quality)!.rms_px.toFixed(3)} px · 覆盖率{" "}
              {((shown?.detection || quality)!.coverage * 100).toFixed(1)}%
            </p>
          )}
          {!samples.length && !preview && !boardImage && (
            <div className="handeye-empty">
              先配置标定板与坐标系，再检测目标。调整机械臂姿态后，停稳采集。
            </div>
          )}
          {samples.length > 0 && (
            <div className="handeye-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Sample</th>
                    <th>用途</th>
                    <th>角点 / RMS</th>
                    <th>源时间戳</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {samples.map((s, i) => (
                    <tr
                      key={s.id}
                      className={s.id === selected ? "selected" : ""}
                    >
                      <td>
                        <button onClick={() => setSelected(s.id)}>
                          #{i + 1}
                        </button>
                      </td>
                      <td>
                        <select
                          aria-label={`样本 ${i + 1} 用途`}
                          disabled={Boolean(busy)}
                          value={s.role}
                          onChange={(e) => {
                            setSamples((ss) =>
                              ss.map((x) =>
                                x.id === s.id
                                  ? {
                                      ...x,
                                      role: e.target
                                        .value as HandeyeSample["role"],
                                    }
                                  : x,
                              ),
                            );
                            setResult(null);
                          }}
                        >
                          <option value="training">训练</option>
                          <option value="validation">复验</option>
                          <option value="excluded">排除</option>
                        </select>
                      </td>
                      <td>
                        {s.detection.corners} / {s.detection.rms_px.toFixed(3)}{" "}
                        px
                      </td>
                      <td>
                        <small>{s.capture.stamp_ns}</small>
                      </td>
                      <td>
                        <button
                          disabled={Boolean(busy)}
                          aria-label={`删除样本 ${i + 1}`}
                          onClick={() => {
                            setSamples((ss) => ss.filter((x) => x.id !== s.id));
                            setResult(null);
                          }}
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
