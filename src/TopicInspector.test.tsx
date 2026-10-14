import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopicInspector } from "./TopicInspector";

const sample = { data: { position: [0.2, 0.6], name: ["joint1"], effort: [1, 2, 3] }, count: 4, firstAt: 1, lastAt: 2, hz: 20 };

describe("TopicInspector", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("shows the full selected path and raw JSON, including errors", () => {
    render(<TopicInspector selected="/joint_states" sample={sample} subscribeError="unsupported type" />);
    expect(screen.getByText("/joint_states")).toBeVisible();
    expect(screen.getByRole("tab", { name: "数据" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Topic JSON")).toHaveTextContent('"position": [');
    expect(screen.getByText("订阅失败：unsupported type")).toBeVisible();
  });

  it("prompts while no topic or sample is selected", () => {
    const { rerender } = render(<TopicInspector selected="" sample={undefined} />);
    expect(screen.getByText("从左侧或 Topic Graph 选择一个 Topic")).toBeVisible();
    rerender(<TopicInspector selected="/joint_states" sample={undefined} />);
    expect(screen.getByText(/等待数据/)).toBeVisible();
  });

  it("adds a numeric array or nested scalar by right click and ignores strings", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<TopicInspector selected="/joint_states" sample={{ ...sample, data: { ...sample.data, actual: { positions: [0.4, 0.5] } } }} monitorPanels={[{ id: "torque", name: "Motor Torque" }, { id: "custom", name: "Custom Plot" }]} selectedMonitorPanelId="torque" onAddToDataGraph={onAdd} />);
    const json = screen.getByLabelText("Topic JSON");
    expect(screen.queryByLabelText("可加入 Monitor 的字段")).not.toBeInTheDocument();
    fireEvent.contextMenu(json.querySelector('[data-monitor-path="effort"]')!);
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    await user.click(screen.getByRole("menuitem", { name: "Custom Plot" }));
    expect(onAdd).toHaveBeenCalledWith("effort", "custom");
    fireEvent.contextMenu(json.querySelector('[data-monitor-path="actual.positions[0]"]')!);
    await user.click(screen.getByRole("menuitem", { name: "Motor Torque当前" }));
    expect(onAdd).toHaveBeenCalledWith("actual.positions[0]", "torque");
    fireEvent.contextMenu(screen.getByText('"joint1"'));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps the context menu open while live samples arrive", () => {
    const onAdd = vi.fn();
    const props = { selected: "/joint_states", onAddToDataGraph: onAdd, monitorPanels: [{ id: "p1", name: "Plot 1" }] };
    const { rerender } = render(<TopicInspector {...props} sample={sample} />);
    fireEvent.contextMenu(screen.getByLabelText("Topic JSON").querySelector('[data-monitor-path="effort"]')!);
    expect(screen.getByRole("menuitem", { name: "Plot 1" })).toBeVisible();
    rerender(<TopicInspector {...props} sample={{ ...sample, data: { ...sample.data, effort: [3, 4] } }} />);
    expect(screen.getByRole("menuitem", { name: "Plot 1" })).toBeVisible();
  });

  it("distinguishes existing panels with the same name", () => {
    const onAdd = vi.fn();
    render(<TopicInspector selected="/joint_states" sample={sample} monitorPanels={[{ id: "first", name: "New Panel" }, { id: "second", name: "New Panel" }]} onAddToDataGraph={onAdd} />);
    fireEvent.contextMenu(screen.getByLabelText("Topic JSON").querySelector('[data-monitor-path="effort"]')!);
    fireEvent.click(screen.getByRole("menuitem", { name: "New Panel (2)" }));
    expect(onAdd).toHaveBeenCalledWith("effort", "second");
  });

  it("shows verbose topic endpoint and QoS details on demand", async () => {
    const user = userEvent.setup();
    const bridge = { getTopicInfo: vi.fn().mockResolvedValue({
      name: "/stm32/joint_commands", types: ["microros_stm32h723_bridge/msg/JointCommand"],
      publishers: [{ node_name: "hardware", node_namespace: "/", topic_type: "microros_stm32h723_bridge/msg/JointCommand", endpoint_type: "PUBLISHER", gid: "01.02.03", qos: { reliability: "BEST_EFFORT", history: "UNKNOWN", depth: 0, durability: "VOLATILE", lifespan: "Infinite", deadline: "Infinite", liveliness: "AUTOMATIC", liveliness_lease_duration: "Infinite" } }],
      subscriptions: [],
    }), getNodeInfo: vi.fn() };
    render(<TopicInspector bridge={bridge} selected="/stm32/joint_commands" sample={sample} />);
    expect(bridge.getTopicInfo).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: "详情" }));
    expect(await screen.findByText("BEST_EFFORT")).toBeVisible();
    expect(screen.getByText("01.02.03")).toBeVisible();
    expect(screen.getByText("Publishers")).toBeVisible();
    expect(screen.getByText("Subscriptions")).toBeVisible();
    expect(bridge.getTopicInfo).toHaveBeenCalledWith("/stm32/joint_commands");
  });

  it("shows node publishers, subscriptions and services instead of topic data", async () => {
    const bridge = { getTopicInfo: vi.fn(), getNodeInfo: vi.fn().mockResolvedValue({
      name: "/driver", namespace: "/", publishers: [{ name: "/joint_states", types: ["sensor_msgs/msg/JointState"] }], subscriptions: [], services: [{ name: "/driver/describe", types: ["example/srv/Describe"] }], clients: [],
    }) };
    render(<TopicInspector bridge={bridge} selected="/old_topic" selectedNode="/driver" sample={sample} />);
    expect(screen.getByRole("tab", { name: "数据" })).toBeDisabled();
    expect(await screen.findByText("/driver/describe")).toBeVisible();
    expect(screen.getByText("/joint_states")).toBeVisible();
    expect(bridge.getNodeInfo).toHaveBeenCalledWith("/driver");
    expect(screen.queryByLabelText("Topic JSON")).not.toBeInTheDocument();
  });

  it("renders Image preview and compact metadata", async () => {
    const putImageData = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ putImageData } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
    const imageData = btoa(String.fromCharCode(255, 0, 0, 0, 255, 0));
    render(<TopicInspector selected="/camera/color/image_raw" topicType="sensor_msgs/msg/Image" sample={{ ...sample, data: { width: 2, height: 1, encoding: "rgb8", step: 6, data_length: 6, data_base64: imageData } }} onAddToDataGraph={vi.fn()} />);
    expect(screen.getByText("图像预览 + 元数据")).toBeVisible();
    expect(screen.getByText(/"data_length": 6/)).toBeVisible();
    expect(screen.queryByText(imageData)).not.toBeInTheDocument();
    await waitFor(() => expect(putImageData).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("ROS 图像预览")).toBeVisible();
  });
});
