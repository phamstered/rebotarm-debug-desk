import { memo, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { RosImagePreview } from "./RosImagePreview";
import { clampImagePan, imageFit, zoomImage } from "./handeyeImageLogic";
import type { ImageSize } from "./handeyeImageLogic";

type Props = {
  sourceKey: string;
  title: string;
  caption: string;
  png?: string;
  liveData?: unknown;
  live?: boolean;
  active: boolean;
  empty: string;
  details?: string;
};

// Source-key remount resets inspection transforms without resetting on every RGB frame.
export const HandeyeImageViewer = memo(function HandeyeImageViewer(
  props: Props,
) {
  return <ImageViewport key={props.sourceKey} {...props} />;
});
function ImageViewport({
  title,
  caption,
  png,
  liveData,
  live,
  active,
  empty,
  details,
}: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [viewport, setViewport] = useState<ImageSize>({
    width: 640,
    height: 360,
  });
  const [natural, setNatural] = useState<ImageSize>({ width: 0, height: 0 });
  const [imageError, setImageError] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    pan: typeof pan;
  } | null>(null);
  const wheel = useRef<(event: WheelEvent) => void>(() => {});
  const message = liveData as Partial<ImageSize> | null;
  const size = live
    ? {
        width: Number(message?.width) || 0,
        height: Number(message?.height) || 0,
      }
    : natural;
  const ready = Boolean(
    live
      ? liveData && size.width > 0 && size.height > 0
      : png && natural.width > 0 && !imageError,
  );
  const scale = zoom ?? imageFit(size, viewport);
  const boundedPan = clampImagePan(pan, size, viewport, scale);
  const fit = () => {
    setZoom(null);
    setPan({ x: 0, y: 0 });
  };
  const resizeZoom = (requested: number, anchor = { x: 0, y: 0 }) => {
    if (!ready) return;
    const next = zoomImage(
      scale,
      requested,
      boundedPan,
      anchor,
      size,
      viewport,
    );
    setZoom(next.scale);
    setPan(next.pan);
  };
  wheel.current = (event) => {
    if (!(event.ctrlKey || event.metaKey) || !ready || !stage.current) return;
    event.preventDefault();
    const rect = stage.current.getBoundingClientRect();
    resizeZoom(scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2,
    });
  };
  useEffect(() => {
    setZoom(null);
    setPan({ x: 0, y: 0 });
  }, [size.width, size.height]);
  useEffect(() => {
    if (!active) setExpanded(false);
  }, [active]);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const resize = () => {
      if (element.clientWidth && element.clientHeight)
        setViewport({
          width: element.clientWidth,
          height: element.clientHeight,
        });
    };
    resize();
    const onWheel = (event: WheelEvent) => wheel.current(event);
    element.addEventListener("wheel", onWheel, { passive: false });
    if (typeof ResizeObserver === "undefined")
      return () => element.removeEventListener("wheel", onWheel);
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => {
      observer.disconnect();
      element.removeEventListener("wheel", onWheel);
    };
  }, [expanded]);
  useEffect(() => {
    if (!expanded) return;
    dialog.current?.showModal();
    closeButton.current?.focus();
    return () => {
      dialog.current?.close();
      expandButton.current?.focus();
    };
  }, [expanded]);
  function keyboard(event: KeyboardEvent) {
    if (event.target !== stage.current || !ready) return;
    if (event.key === "+" || event.key === "=") resizeZoom(scale * 1.25);
    else if (event.key === "-") resizeZoom(scale / 1.25);
    else if (event.key === "0" || event.key.toLowerCase() === "f") fit();
    else if (event.key === "1") resizeZoom(1);
    else if (
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      setPan(
        clampImagePan(
          {
            x:
              boundedPan.x +
              (event.key === "ArrowLeft"
                ? 40
                : event.key === "ArrowRight"
                  ? -40
                  : 0),
            y:
              boundedPan.y +
              (event.key === "ArrowUp"
                ? 40
                : event.key === "ArrowDown"
                  ? -40
                  : 0),
          },
          size,
          viewport,
          scale,
        ),
      );
    } else return;
    event.preventDefault();
  }
  const controls = (
    <div
      className="handeye-image-tools"
      role="toolbar"
      aria-label="图片查看工具"
    >
      <button disabled={!ready} onClick={fit}>
        适应窗口
      </button>
      <button disabled={!ready} onClick={() => resizeZoom(1)}>
        原始尺寸
      </button>
      <button
        aria-label="缩小图片"
        disabled={!ready}
        onClick={() => resizeZoom(scale / 1.25)}
      >
        −
      </button>
      <output aria-label="图片缩放比例">
        {ready ? `${Math.round(scale * 100)}%` : "—"}
      </output>
      <button
        aria-label="放大图片"
        disabled={!ready}
        onClick={() => resizeZoom(scale * 1.25)}
      >
        ＋
      </button>
      {expanded ? (
        <button ref={closeButton} onClick={() => setExpanded(false)}>
          关闭大图 · Esc
        </button>
      ) : (
        <button
          ref={expandButton}
          disabled={!ready}
          onClick={() => setExpanded(true)}
        >
          放大查看
        </button>
      )}
    </div>
  );
  const content = (
    <>
      <div className="handeye-image-heading">
        <strong>{title}</strong>
        <span>{ready ? `${size.width} × ${size.height}` : ""}</span>
      </div>
      {controls}
      <div
        ref={stage}
        className={`handeye-image-stage${ready ? " ready" : ""}`}
        tabIndex={0}
        role="group"
        aria-label={`${title}查看区`}
        onKeyDown={keyboard}
        onDoubleClick={fit}
        onPointerDown={(event) => {
          if (!ready || event.button !== 0) return;
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            pan: boundedPan,
          };
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.id !== event.pointerId) return;
          setPan(
            clampImagePan(
              {
                x: start.pan.x + event.clientX - start.x,
                y: start.pan.y + event.clientY - start.y,
              },
              size,
              viewport,
              scale,
            ),
          );
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      >
        <div
          className="handeye-image-media"
          style={{
            width: size.width || 1,
            height: size.height || 1,
            transform: `translate(-50%, -50%) translate(${boundedPan.x}px, ${boundedPan.y}px) scale(${scale})`,
            visibility: ready ? "visible" : "hidden",
          }}
        >
          {live ? (
            <RosImagePreview data={liveData} />
          ) : png ? (
            <img
              src={`data:image/png;base64,${png}`}
              alt={title}
              draggable={false}
              onLoad={(event) => {
                setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                });
                setImageError(false);
              }}
              onError={() => setImageError(true)}
            />
          ) : null}
        </div>
        {!ready && (
          <p className="handeye-image-placeholder">
            {imageError
              ? "图片无法解码，请重新检测或选择其他样本"
              : png
                ? "正在载入图片…"
                : empty}
          </p>
        )}
      </div>
      <p className="handeye-image-caption">{caption}</p>
      {details && <p className="handeye-image-quality">{details}</p>}
      <p className="handeye-image-help">
        拖动平移 · Ctrl/⌘＋滚轮缩放 · 双击适应窗口 · 聚焦图片后可用
        ＋/−、方向键、0/1
      </p>
    </>
  );
  return (
    <div className="handeye-image-viewer">
      {expanded ? (
        <dialog
          ref={dialog}
          className="handeye-image-dialog"
          aria-label={`${title}大图`}
          onCancel={() => setExpanded(false)}
          onClose={() => setExpanded(false)}
        >
          {content}
        </dialog>
      ) : (
        content
      )}
    </div>
  );
}
