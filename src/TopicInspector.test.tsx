import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopicInspector } from "./TopicInspector";

const sample = { data: { position: [0.2, 0.6], name: ["joint1"], effort: [1, 2, 3] }, count: 4, firstAt: 1, lastAt: 2, hz: 20 };

describe("TopicInspector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows raw JSON for selected topics", () => {
    render(<TopicInspector selected="/joint_states" sample={sample} />);
    expect(screen.getByText("原始 JSON")).toBeVisible();
    expect(screen.getByText(/"position": \[/)).toBeVisible();
    expect(screen.queryByLabelText(/jq 过滤/)).not.toBeInTheDocument();
  });

  it("prompts to select a topic when none is selected", () => {
    render(<TopicInspector selected="" sample={undefined} />);
    expect(screen.getByText("从左侧或 Topic Graph 选择一个 Topic")).toBeVisible();
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

    expect(screen.getByText("图像预览 + 元数据")).toBeVisible();
    expect(screen.getByText(/"data_length": 6/)).toBeVisible();
    expect(screen.queryByText(imageData)).not.toBeInTheDocument();
    await waitFor(() => expect(putImageData).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("ROS 图像预览")).toBeVisible();
    expect(screen.getByText("2 × 1 · rgb8")).toBeVisible();
  });

  it("shows subscribe errors without hiding raw output", () => {
    render(<TopicInspector selected="/joint_states" sample={sample} subscribeError="unsupported type" />);
    expect(screen.getByText("订阅失败：unsupported type")).toBeVisible();
    expect(screen.getByText(/"position": \[/)).toBeVisible();
  });

  it("lists numeric fields and invokes Add to Monitor", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<TopicInspector selected="/joint_states" sample={sample} onAddToDataGraph={onAdd} />);
    expect(screen.getByLabelText("可加入 Monitor 的字段")).toBeVisible();
    expect(screen.getByText("effort")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "加入 Monitor：effort" }));
    expect(onAdd).toHaveBeenCalledWith("effort");
  });
});

  it("shows waiting placeholder until sample data arrives", () => {
    render(<TopicInspector selected="/joint_states" sample={undefined} />);
    expect(screen.getByText(/等待数据/)).toBeVisible();
    expect(screen.queryByLabelText("可加入 Monitor 的字段")).not.toBeInTheDocument();
  });

  it("hides add-to-monitor without a callback", () => {
    render(<TopicInspector selected="/joint_states" sample={sample} />);
    expect(screen.queryByLabelText("可加入 Monitor 的字段")).not.toBeInTheDocument();
  });

  it("does not list Monitor fields for image topics even with a callback", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      putImageData: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    render(
      <TopicInspector
        selected="/camera"
        topicType="sensor_msgs/msg/Image"
        sample={{ ...sample, data: { width: 1, height: 1, encoding: "rgb8", step: 3, data_length: 3, data_base64: "AAA" } }}
        onAddToDataGraph={() => undefined}
      />,
    );
    expect(screen.queryByLabelText("可加入 Monitor 的字段")).not.toBeInTheDocument();
  });

  it("labels scalar and array numeric fields for Monitor", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(
      <TopicInspector
        selected="/js"
        sample={{ data: { count: 4, effort: [1, 2] }, count: 1, firstAt: 1, lastAt: 1, hz: 1 }}
        onAddToDataGraph={onAdd}
      />,
    );
    expect(screen.getByText("scalar")).toBeVisible();
    expect(screen.getByText("array[2]")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "加入 Monitor：count" }));
    expect(onAdd).toHaveBeenCalledWith("count");
  });
