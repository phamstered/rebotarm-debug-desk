import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { defaultProfile } from "./types";
import { StatusPage } from "./StatusPage";

describe("StatusPage", () => {
  it("renders the read-only status grid with Chinese labels", () => {
    render(
      <StatusPage
        stage="connected"
        sshOk
        bridgeUp
        localPort={18765}
        profile={{ ...defaultProfile, name: "desk" }}
        hello={{ bridgeVersion: "0.1.0", rosDistro: "humble" }}
        agentStatus={{
          loadState: "loaded",
          activeState: "active",
          subState: "running",
          result: "success",
          mainPid: 9,
          unitFileState: "enabled",
          description: "agent",
        }}
        agentError=""
        agentChecked
        hardwareStatus={{ mode: 0, mode_name: "HOLD", fault_code: 0 }}
        jointState={{ name: ["j1"], position: [0.1] }}
        jointStateSample={{ data: {}, count: 3, firstAt: 0, lastAt: 500, hz: 4 }}
        rosControl={{
          manager: "/controller_manager",
          available: true,
          controllers: [{ name: "forward_position_controller", typeName: "t", state: "active" }],
          message: "",
        }}
        lastKnownDomainId={0}
      />,
    );

    expect(screen.getByRole("heading", { name: "Status" })).toBeVisible();
    expect(screen.getByText(/只读系统状态总览/)).toBeVisible();
    expect(screen.getByLabelText("状态卡片")).toBeVisible();
    expect(screen.getByLabelText("SSH / 隧道")).toBeVisible();
    expect(screen.getByLabelText("Bridge")).toBeVisible();
    expect(screen.getByLabelText("micro-ROS Agent")).toBeVisible();
    expect(screen.getByLabelText("Hardware")).toBeVisible();
    expect(screen.getByLabelText("ROS 就绪")).toBeVisible();
    expect(screen.getByLabelText("ros2_control")).toBeVisible();
    expect(screen.getByLabelText("DDS Domain")).toBeVisible();
    expect(screen.getByLabelText("systemd")).toBeVisible();
    expect(screen.getByLabelText("USB CDC / 传输")).toBeVisible();
    expect(screen.getByText("localhost:18765")).toBeVisible();
    expect(screen.getByText("HOLD")).toBeVisible();
    expect(screen.getByText("forward_position_controller")).toBeVisible();
    expect(screen.getByText(/不提供一键升级全部/)).toBeVisible();
  });
});
