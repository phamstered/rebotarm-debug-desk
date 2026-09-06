import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultProfile } from "./types";

const doubles = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: doubles.invoke }));
import { TopicInspector } from "./TopicInspector";

const sample = { data: { position: [0.2, 0.6], name: ["joint1"] }, count: 4, firstAt: 1, lastAt: 2, hz: 20 };

describe("TopicInspector jq filtering", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    doubles.invoke.mockImplementation((command: string) => {
      if (command === "get_topic_info") return Promise.resolve("Type: sensor_msgs/msg/JointState\nPublisher count: 1");
      if (command === "publish_topic_once") return Promise.resolve("publishing #1");
      return Promise.resolve("");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows raw JSON by default without a jq expression", () => {
    render(<TopicInspector selected="/joint_states" topicType="sensor_msgs/msg/JointState" sample={sample} profile={defaultProfile} />);
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
      profile={defaultProfile}
    />);

    expect(screen.getByText("未筛选 · 图像预览 + 元数据")).toBeVisible();
    expect(screen.getByText(/"data_length": 6/)).toBeVisible();
    expect(screen.queryByText(imageData)).not.toBeInTheDocument();
    await waitFor(() => expect(putImageData).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("ROS 图像预览")).toBeVisible();
    expect(screen.getByText("2 × 1 · rgb8")).toBeVisible();
  });

  it("runs and persists a per-topic jq expression in Topic Inspector", async () => {
    render(<TopicInspector selected="/joint_states" topicType="sensor_msgs/msg/JointState" sample={sample} profile={defaultProfile} />);
    fireEvent.change(screen.getByLabelText("jq 过滤 /joint_states"), { target: { value: ".position[1]" } });
    await waitFor(() => expect(screen.getByText("0.6")).toBeVisible());
    expect(screen.getByText("jq 已启用")).toBeVisible();
    expect(JSON.parse(localStorage.getItem("robot-console-jq-filters")!)).toEqual({ "/joint_states": ".position[1]" });
  });

  it("keeps filtering when messages arrive faster than the expression debounce", async () => {
    const { container, rerender } = render(<TopicInspector selected="/joint_states" topicType="sensor_msgs/msg/JointState" sample={sample} profile={defaultProfile} />);
    fireEvent.change(screen.getByLabelText("jq 过滤 /joint_states"), { target: { value: ".position[1]" } });
    let position = 0.6;
    const stream = window.setInterval(() => {
      position += 0.01;
      act(() => rerender(<TopicInspector
        selected="/joint_states"
        topicType="sensor_msgs/msg/JointState"
        sample={{ ...sample, data: { ...sample.data, position: [0.2, position] } }}
        profile={defaultProfile}
      />));
    }, 20);
    try {
      await waitFor(() => expect(container.querySelector(".data-tab-content > pre")?.textContent).toMatch(/^0\.\d+$/));
    } finally {
      window.clearInterval(stream);
    }
  });

  it("loads verbose ROS topic info in the second tab", async () => {
    render(<TopicInspector selected="/joint_states" topicType="sensor_msgs/msg/JointState" sample={sample} profile={defaultProfile} />);
    fireEvent.click(screen.getByRole("tab", { name: "Topic Info" }));
    await waitFor(() => expect(screen.getByText(/Publisher count: 1/)).toBeVisible());
    expect(doubles.invoke).toHaveBeenCalledWith("get_topic_info", { profile: defaultProfile, topic: "/joint_states" });
  });

  it("rejects malformed JSON before invoking publish and sends one valid frame", async () => {
    render(<TopicInspector selected="/joint_states" topicType="sensor_msgs/msg/JointState" sample={sample} profile={defaultProfile} />);
    fireEvent.click(screen.getByRole("tab", { name: "发送" }));
    const editor = screen.getByLabelText("发布 JSON /joint_states");
    fireEvent.change(editor, { target: { value: "{" } });
    fireEvent.click(screen.getByRole("button", { name: "校验并发送一帧" }));
    expect(await screen.findByText(/JSON 格式无效/)).toBeVisible();
    expect(doubles.invoke).not.toHaveBeenCalledWith("publish_topic_once", expect.anything());

    const payload = '{"name":["joint1"],"position":[0.2]}';
    fireEvent.change(editor, { target: { value: payload } });
    fireEvent.click(screen.getByRole("button", { name: "校验并发送一帧" }));
    await waitFor(() => expect(doubles.invoke).toHaveBeenCalledWith("publish_topic_once", {
      profile: defaultProfile,
      topic: "/joint_states",
      typeName: "sensor_msgs/msg/JointState",
      payloadJson: payload,
    }));
    expect(await screen.findByText("publishing #1")).toBeVisible();
  });

  it("blocks generic publishing to the configured motor command topic", () => {
    render(<TopicInspector selected={defaultProfile.commandTopic} topicType="microros_stm32h723_bridge/msg/JointCommand" sample={undefined} profile={defaultProfile} />);
    fireEvent.click(screen.getByRole("tab", { name: "发送" }));
    expect(screen.getByText(/电机命令 Topic 已锁定/)).toBeVisible();
    expect(screen.getByRole("button", { name: "校验并发送一帧" })).toBeDisabled();
  });
});
