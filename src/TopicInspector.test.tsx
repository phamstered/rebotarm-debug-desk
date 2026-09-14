import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopicInspector } from "./TopicInspector";

const sample = { data: { position: [0.2, 0.6], name: ["joint1"] }, count: 4, firstAt: 1, lastAt: 2, hz: 20 };

describe("TopicInspector jq filtering", () => {
  beforeEach(() => localStorage.clear());

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows raw JSON by default without a jq expression", () => {
    render(<TopicInspector selected="/joint_states" sample={sample} />);
    expect(screen.getByLabelText("jq 过滤 /joint_states")).toHaveValue("");
    expect(screen.getByText("未筛选 · 原始 JSON")).toBeVisible();
    expect(screen.getByText(/"position": \[/)).toBeVisible();
  });

  it("renders sensor_msgs/Image data as a canvas preview with compact metadata", async () => {
    const putImageData = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ putImageData } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal("ImageData", class {
      constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    const imageData = btoa(String.fromCharCode(255, 0, 0, 0, 255, 0));
    render(<TopicInspector
      selected="/camera/color/image_raw"
      topicType="sensor_msgs/msg/Image"
      sample={{ ...sample, data: { width: 2, height: 1, encoding: "rgb8", step: 6, data_length: 6, data_base64: imageData } }}
    />);

    expect(screen.getByText("未筛选 · 图像预览 + 元数据")).toBeVisible();
    expect(screen.getByText(/"data_length": 6/)).toBeVisible();
    expect(screen.queryByText(imageData)).not.toBeInTheDocument();
    await waitFor(() => expect(putImageData).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("ROS 图像预览")).toBeVisible();
    expect(screen.getByText("2 × 1 · rgb8")).toBeVisible();
  });

  it("runs and persists a per-topic jq expression in Topic Inspector", async () => {
    render(<TopicInspector selected="/joint_states" sample={sample} />);
    fireEvent.change(screen.getByLabelText("jq 过滤 /joint_states"), { target: { value: ".position[1]" } });
    await waitFor(() => expect(screen.getByText("0.6")).toBeVisible());
    expect(screen.getByText("jq 已启用")).toBeVisible();
    expect(JSON.parse(localStorage.getItem("robot-console-jq-filters")!)).toEqual({ "/joint_states": ".position[1]" });
  });

  it("keeps filtering when messages arrive faster than the expression debounce", async () => {
    const { container, rerender } = render(<TopicInspector selected="/joint_states" sample={sample} />);
    fireEvent.change(screen.getByLabelText("jq 过滤 /joint_states"), { target: { value: ".position[1]" } });
    let position = 0.6;
    const stream = window.setInterval(() => {
      position += 0.01;
      act(() => rerender(<TopicInspector
        selected="/joint_states"
        sample={{ ...sample, data: { ...sample.data, position: [0.2, position] } }}
      />));
    }, 20);
    try {
      await waitFor(() => expect(container.querySelector(".topic-inspector-content > pre")?.textContent).toMatch(/^0\.\d+$/));
    } finally {
      window.clearInterval(stream);
    }
  });
});
