import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Group } from "three";
import type { URDFRobot } from "urdf-loader";
import type { BridgeClient } from "./bridge";
const doubles = vi.hoisted(() => ({ hydrate: vi.fn(), load: vi.fn(), dispose: vi.fn(), assetsDispose: vi.fn() }));
vi.mock("@react-three/fiber", () => ({ Canvas: ({ frameloop }: { frameloop: string }) => <div data-testid="canvas" data-frameloop={frameloop} />, useFrame: vi.fn(), useThree: vi.fn() }));
vi.mock("./urdfAssetLogic", () => ({ hydrateUrdfResources: doubles.hydrate, loadUrdfScene: doubles.load, disposeUrdfObject: doubles.dispose }));
import { UrdfViewer } from "./UrdfViewer";
const xml = '<robot name="test"><link name="base"/></robot>';
const props = { xml, bridge: {} as BridgeClient, jointState: { name: ["j1"], position: [1] }, tcpLink: "base", trajectoryController: null, onSendTrajectory: vi.fn() };
const robot = () => Object.assign(new Group(), { setJointValue: vi.fn() }) as unknown as URDFRobot;

describe("Robot View lifecycle", () => {
  beforeEach(() => { vi.clearAllMocks(); doubles.hydrate.mockResolvedValue({ dispose: doubles.assetsDispose }); doubles.load.mockResolvedValue(robot()); });
  it("preserves the scene and canvas across navigation, pauses frames and applies fresh feedback on return", async () => {
    const parsed = robot(); doubles.load.mockResolvedValue(parsed);
    const view = render(<UrdfViewer {...props} />);
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    const canvas = screen.getByTestId("canvas");
    view.rerender(<UrdfViewer {...props} active={false} jointState={{ name: ["j1"], position: [2] }} />);
    expect(canvas).toHaveAttribute("data-frameloop", "never");
    expect(doubles.dispose).not.toHaveBeenCalled();
    view.rerender(<UrdfViewer {...props} jointState={{ name: ["j1"], position: [3] }} />);
    expect(screen.getByTestId("canvas")).toBe(canvas);
    expect(canvas).toHaveAttribute("data-frameloop", "always");
    expect(parsed.setJointValue).toHaveBeenLastCalledWith("j1", 3);
    expect(doubles.hydrate).toHaveBeenCalledOnce(); expect(doubles.load).toHaveBeenCalledOnce();
    view.unmount();
    expect(doubles.dispose).toHaveBeenCalledWith(parsed); expect(doubles.assetsDispose).toHaveBeenCalledOnce();
  });
  it("aborts incomplete loads on hide and prevents stale results replacing the current scene", async () => {
    let resolve!: (value: URDFRobot) => void;
    doubles.load.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const view = render(<UrdfViewer {...props} />);
    await waitFor(() => expect(doubles.load).toHaveBeenCalledOnce());
    const signal = doubles.load.mock.calls[0][1] as AbortSignal;
    view.rerender(<UrdfViewer {...props} active={false} />);
    expect(signal.aborted).toBe(true);
    const stale = robot();
    await act(async () => resolve(stale));
    expect(doubles.dispose).toHaveBeenCalledWith(stale); expect(doubles.assetsDispose).toHaveBeenCalledOnce();
    view.rerender(<UrdfViewer {...props} />);
    await waitFor(() => expect(doubles.load).toHaveBeenCalledTimes(2));
    view.rerender(<UrdfViewer {...props} xml={xml.replace("test", "new")} />);
    await waitFor(() => expect(doubles.load).toHaveBeenCalledTimes(3));
    expect(doubles.dispose).toHaveBeenCalledTimes(2);
  });
});
