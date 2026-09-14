import { useEffect, useRef, useState } from "react";
import { decodeRosImage } from "./imageTopicLogic";

export function RosImagePreview({ data }: { data: unknown }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latestDataRef = useRef(data);
  const frameRef = useRef<number | null>(null);
  const [status, setStatus] = useState({ width: 0, height: 0, encoding: "", error: "等待图像数据…" });
  latestDataRef.current = data;

  useEffect(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      try {
        const image = decodeRosImage(latestDataRef.current);
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("浏览器不支持 Canvas 2D");
        context.putImageData(new ImageData(image.rgba, image.width, image.height), 0, 0);
        setStatus({ width: image.width, height: image.height, encoding: image.message.encoding, error: "" });
      } catch (reason) {
        setStatus((current) => ({
          ...current,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
      }
    });
  }, [data]);

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
  }, []);

  return (
    <div className="ros-image-preview">
      <canvas ref={canvasRef} aria-label="ROS 图像预览" hidden={Boolean(status.error)} />
      {status.error
        ? <div className="ros-image-placeholder">{status.error}</div>
        : <span>{status.width} × {status.height} · {status.encoding}</span>}
    </div>
  );
}
