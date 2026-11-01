import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Group } from "three";
import userEvent from "@testing-library/user-event";
import rebotarmUrdf from "./testFixtures/rebotarm-kinematics.urdf?raw";
import type { PositionMotionControls } from "./positionMotionLogic";
import type { URDFRobot } from "urdf-loader";
import type { BridgeClient } from "./bridge";
const doubles = vi.hoisted(() => ({ hydrate: vi.fn(), load: vi.fn(), dispose: vi.fn(), assetsDispose: vi.fn(), children: null as any }));
vi.mock("@react-three/fiber", () => ({ Canvas: ({ frameloop, children }: { frameloop: string; children: any }) => { doubles.children = children; return <div data-testid="canvas" data-frameloop={frameloop} />; }, useFrame: vi.fn(), useThree: vi.fn() }));
vi.mock("./urdfAssetLogic", () => ({ hydrateUrdfResources: doubles.hydrate, loadUrdfScene: doubles.load, disposeUrdfObject: doubles.dispose }));
import * as trajectoryLogic from "./trajectoryLogic";
import { UrdfViewer } from "./UrdfViewer";
const xml = '<robot name="test"><link name="base"/></robot>';
const props = { xml, bridge: {} as BridgeClient, jointState: { name: ["j1"], position: [1] }, tcpLink: "base", trajectoryController: null, onSendTrajectory: vi.fn() };
const robot = () => Object.assign(new Group(), { setJointValue: vi.fn() }) as unknown as URDFRobot;

describe("Robot View lifecycle", () => {
  beforeEach(() => { vi.clearAllMocks(); doubles.hydrate.mockResolvedValue({ dispose: doubles.assetsDispose }); doubles.load.mockResolvedValue(robot()); });
  it("waits for the controller joint contract and displays subscription errors", async () => {
    const controller = { name: "arm", topic: "/arm/joint_trajectory" };
    const view = render(<UrdfViewer {...props} trajectoryController={controller} />);
    await waitFor(() => expect(screen.getByText("等待轨迹控制器关节反馈后可拖拽 TCP")).toBeVisible());
    view.rerender(<UrdfViewer {...props} trajectoryController={{ ...controller, readinessError: "无法读取轨迹控制器反馈：类型未安装" }} />);
    expect(screen.getByText("无法读取轨迹控制器反馈：类型未安装")).toBeVisible();
    view.rerender(<UrdfViewer {...props} trajectoryController={{ ...controller, jointNames: ["j1"] }} />);
    await waitFor(() => expect(screen.getByText("拖动青色球快速定位，XYZ/RPY 微调；松手预览，确认执行")).toBeVisible());
    expect(props.onSendTrajectory).not.toHaveBeenCalled();
  });
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
  it("previews only the selected joint, preserves editing across feedback and executes only on confirmation", async () => {
    const user = userEvent.setup(), parsed = robot(); doubles.load.mockResolvedValue(parsed);
    const motion: PositionMotionControls = { logs: [], recordLog: vi.fn(), state: { phase: "idle", commandId: "", label: "", message: "" },
      homePositions: [], reason: "", jointRotationReason: "", jointTargetsReason: "", tcpPoseReason: "", executeTcpPose: vi.fn(), armed: true, busy: false,
      setArmed: vi.fn(), execute: vi.fn(), executeJoint: vi.fn(), executeJoints: vi.fn(), cancel: vi.fn() };
    const names = ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6"];
    const view = render(<UrdfViewer {...props} xml={rebotarmUrdf} tcpLink="" jointState={{ name: names, position: [0, 0, 0, 0, 0, 0] }} jointMotion={motion} />);
    await waitFor(() => expect(doubles.load).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "关节调整" }));
    await user.selectOptions(screen.getByLabelText("选择旋转关节"), "joint1");
    const input = screen.getByLabelText("joint1 目标角度");
    await user.clear(input); await user.type(input, "30");
    expect(screen.getByText(/轴姿态预览中/)).toBeVisible();
    expect(parsed.setJointValue).toHaveBeenLastCalledWith("joint1", Math.PI / 6);
    expect(motion.executeJoint).not.toHaveBeenCalled(); expect(props.onSendTrajectory).not.toHaveBeenCalled();
    view.rerender(<UrdfViewer {...props} xml={rebotarmUrdf} tcpLink="" jointState={{ name: names, position: [.1, .2, 0, 0, 0, 0] }} jointMotion={motion} />);
    expect(input).toHaveValue("30");
    expect(parsed.setJointValue).toHaveBeenCalledWith("joint2", .2);
    expect(parsed.setJointValue).toHaveBeenLastCalledWith("joint1", Math.PI / 6);
    await user.keyboard("{Escape}");
    expect(screen.queryByText(/轴姿态预览中/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
    await user.clear(input); await user.type(input, "30");
    await user.click(screen.getByRole("button", { name: "确认执行" }));
    expect(motion.executeJoints).toHaveBeenCalledExactlyOnceWith({ joint1: Math.PI / 6 }, 5);
    expect(parsed.setJointValue).toHaveBeenLastCalledWith("joint6", 0);
    expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
    await user.clear(input); await user.type(input, "9999");
    expect(screen.getByRole("alert")).toHaveTextContent("限位");
    expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
    await user.clear(input); await user.type(input, "-15");
    view.rerender(<UrdfViewer {...props} active={false} xml={rebotarmUrdf} tcpLink="" jointState={{ name: names, position: [.1, .2, 0, 0, 0, 0] }} jointMotion={motion} />);
    expect(screen.queryByText(/轴姿态预览中/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
    expect(motion.executeJoints).toHaveBeenCalledTimes(1);
  });
  it("previews calibrated joint7 in mm, ignores raw actuator units, and executes only after confirmation", async () => {
    const parsed = robot(); doubles.load.mockResolvedValue(parsed);
    const motion: PositionMotionControls = { logs: [], recordLog: vi.fn(), state: { phase: "idle", commandId: "", label: "", message: "" },
      homePositions: [], reason: "", jointRotationReason: "", jointTargetsReason: "", tcpPoseReason: "", executeTcpPose: vi.fn(), armed: true, busy: false,
      setArmed: vi.fn(), execute: vi.fn(), executeJoint: vi.fn(), executeJoints: vi.fn(), cancel: vi.fn(),
      gripper: { supported: true, available: true, fresh: true, position: .025, lower: 0, upper: .05, message: "" } };
    const names = ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6", "gripper_finger_left_joint"];
    render(<UrdfViewer {...props} xml={rebotarmUrdf} tcpLink="" jointState={{ name: names, position: [0,0,0,0,0,0,-2] }} jointMotion={motion} />);
    await waitFor(() => expect(doubles.load).toHaveBeenCalledOnce());
    expect(parsed.setJointValue).toHaveBeenCalledWith("gripper_finger_left_joint", .025);
    expect(parsed.setJointValue).not.toHaveBeenCalledWith("gripper_finger_left_joint", -2);
    fireEvent.change(screen.getByLabelText("TCP 夹爪行程 mm"), { target: { value: "30" } });
    expect(parsed.setJointValue).toHaveBeenLastCalledWith("gripper_finger_left_joint", .03);
    expect(motion.executeJoints).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    expect(motion.executeJoints).toHaveBeenCalledExactlyOnceWith({ gripper_finger_left_joint: .03 }, 5);
    expect(props.onSendTrajectory).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("TCP 夹爪行程 mm"), { target: { value: "70" } });
    expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByLabelText("TCP 夹爪行程 mm")).toHaveValue(null);
  });

  it("holds TCP preview after release and replans on explicit confirmation, refusing a newly failed IK", async () => {
    const parsed = robot(); doubles.load.mockResolvedValue(parsed);
    const motion: PositionMotionControls = { logs: [], recordLog: vi.fn(), state: { phase: "idle", commandId: "", label: "", message: "" },
      homePositions: [], reason: "", jointRotationReason: "", jointTargetsReason: "", tcpPoseReason: "", executeTcpPose: vi.fn(), armed: true, busy: false,
      setArmed: vi.fn(), execute: vi.fn(), executeJoint: vi.fn(), executeJoints: vi.fn(), cancel: vi.fn() };
    const names = ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6"];
    const plan = { jointNames: names, start: [0,0,0,0,0,0], goal: [.1,0,0,0,0,0], chainJointNames: names, chainIndices: [0,1,2,3,4,5], chainGoal: [.1,0,0,0,0,0], target: [0,0,0] as [number,number,number], solved: [0,0,0] as [number,number,number], positionError: 0, orientationError: 0, duration: 1, points: [] };
    const spy = vi.spyOn(trajectoryLogic, "planTrajectory").mockReturnValue({ plan });
    const props2 = { ...props, xml: rebotarmUrdf, tcpLink: "", jointState: { name: names, position: [0,0,0,0,0,0] }, jointMotion: motion,
      trajectoryController: { name: "arm", topic: "/arm/joint_trajectory", jointNames: names } };
    const view = render(<UrdfViewer {...props2} />);
    await waitFor(() => expect(doubles.load).toHaveBeenCalledOnce());
    const find = (node: any): any => Array.isArray(node) ? node.map(find).find(Boolean) : node?.props?.onDragStart ? node.props : find(node?.props?.children ?? []);
    act(() => { find(doubles.children).onDragStart(); find(doubles.children).onDragMove({position:[.1,.2,.3],orientation:[0,0,0,1]}); find(doubles.children).onDragEnd(); });
    expect(motion.executeJoints).not.toHaveBeenCalled();
    expect(find(doubles.children).pose).toEqual({position:[.1,.2,.3],orientation:[0,0,0,1]});
    expect(screen.getByLabelText("TCP X")).toHaveValue("100.00");
    const count = (parsed.setJointValue as any).mock.calls.length;
    view.rerender(<UrdfViewer {...props2} jointState={{ name: names, position: [.2,0,0,0,0,0] }} />);
    expect((parsed.setJointValue as any).mock.calls.length).toBe(count);
    spy.mockReturnValueOnce({ error: "IK 未收敛：目标已不可达" });
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    expect(motion.executeJoints).not.toHaveBeenCalled();
    expect(screen.getByText("IK 未收敛：目标已不可达")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    expect(motion.executeTcpPose).toHaveBeenCalledExactlyOnceWith({frame_id:"base_link",tcp_link:"gripper_link",position:[.1,.2,.3],orientation:[0,0,0,1]},5,undefined);
    expect(motion.executeJoints).not.toHaveBeenCalled();
    expect(props.onSendTrajectory).not.toHaveBeenCalled(); spy.mockRestore();
  });

  it("keeps unreachable numeric pose targets independent of IK and blocks invalid input", async () => {
    const parsed = robot(); doubles.load.mockResolvedValue(parsed);
    const motion: PositionMotionControls = { logs: [], recordLog: vi.fn(), state: { phase: "idle", commandId: "", label: "", message: "" },
      homePositions: [], reason: "", jointRotationReason: "", jointTargetsReason: "", tcpPoseReason: "", executeTcpPose: vi.fn(), armed: true, busy: false,
      setArmed: vi.fn(), execute: vi.fn(), executeJoint: vi.fn(), executeJoints: vi.fn(), cancel: vi.fn() };
    const names = ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6"];
    const spy = vi.spyOn(trajectoryLogic, "planTrajectory").mockReturnValue({error:"位姿 IK 未收敛"});
    const props2 = {...props,xml:rebotarmUrdf,tcpLink:"",jointState:{name:names,position:[0,0,0,0,0,0]},jointMotion:motion};
    const view=render(<UrdfViewer {...props2}/>);
    await waitFor(()=>expect(doubles.load).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("TCP X"),{target:{value:"9999"}});
    const find=(node:any):any=>Array.isArray(node)?node.map(find).find(Boolean):node?.props?.onDragStart?node.props:find(node?.props?.children??[]);
    expect(find(doubles.children).pose.position[0]).toBe(9.999);
    expect(screen.getByRole("button",{name:"确认执行"})).toBeDisabled();
    view.rerender(<UrdfViewer {...props2} jointState={{name:names,position:[.5,0,0,0,0,0]}}/>);
    expect(screen.getByLabelText("TCP X")).toHaveValue("9999");
    fireEvent.change(screen.getByLabelText("TCP Pitch"),{target:{value:"-"}});
    expect(screen.getByRole("alert")).toHaveTextContent("有限数值");
    expect(find(doubles.children).pose.position[0]).toBe(9.999);
    fireEvent.keyDown(window,{key:"Escape"});
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("TCP X")).not.toHaveValue("9999");
    expect(motion.executeTcpPose).not.toHaveBeenCalled();spy.mockRestore();
  });

});
