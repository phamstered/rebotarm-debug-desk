import { describe, expect, it } from "vitest";
import {
  applyRecentHostToProfile,
  connectStepStatus,
  defaultPanelState,
  defaultSidebarState,
  deriveConnectStatusLights,
  domainMismatchHint,
  formatConnectError,
  isAgentOnline,
  isRosReady,
  loadLastKnownDomainId,
  loadPanelState,
  loadProfile,
  loadRecentHosts,
  loadSidebarState,
  migrateProfile,
  nextTopicSample,
  rememberLastKnownDomainId,
  rememberSuccessfulHost,
} from "./appLogic";
import { defaultProfile } from "./types";

const storage = (value: string | null) => ({ getItem: () => value });

describe("connection profile", () => {
  it("uses defaults when there is no saved profile or malformed JSON", () => {
    expect(loadProfile(storage(null))).toEqual(defaultProfile);
    expect(loadProfile(storage("{"))).toEqual(defaultProfile);
  });

  it("migrates legacy ROS setup and joint-state topic values", () => {
    const profile = migrateProfile({
      host: "robot",
      rosSetupScript: "/home/jialiang/Project/install/setup.bash",
      jointStateTopic: "/joint_states",
    });
    expect(profile.host).toBe("robot");
    expect(profile.rosSetupScript).toBe(defaultProfile.rosSetupScript);
    expect(profile.jointStateTopic).toBe("/stm32/joint_states");
  });
});

describe("panel and topic state", () => {
  it("loads defaults and merges persisted collapsed panels", () => {
    expect(loadPanelState(storage(null))).toEqual(defaultPanelState);
    expect(loadPanelState(storage('{"topics":false}'))).toEqual({ topics: false, rosControl: true, inspector: true });
    expect(loadPanelState(storage('{"motor":false,"inspector":false}'))).toEqual({ topics: true, rosControl: true, inspector: false });
    expect(loadPanelState(storage("bad"))).toEqual(defaultPanelState);
  });

  it("loads persistent outer sidebar visibility", () => {
    expect(loadSidebarState(storage(null))).toEqual(defaultSidebarState);
    expect(loadSidebarState(storage('{"left":false}'))).toEqual({ left: false, right: true });
    expect(loadSidebarState(storage("bad"))).toEqual(defaultSidebarState);
  });

  it("counts messages and calculates average frequency", () => {
    const first = nextTopicSample(undefined, { value: 1 }, 1000);
    const second = nextTopicSample(first, { value: 2 }, 1500);
    expect(first).toMatchObject({ count: 1, hz: 0, firstAt: 1000, lastAt: 1000 });
    expect(second).toMatchObject({ data: { value: 2 }, count: 2, hz: 2, firstAt: 1000, lastAt: 1500 });
  });
});

describe("connect status helpers", () => {
  it("maps connect step highlight states", () => {
    expect(connectStepStatus("ssh", "ssh", null, false)).toBe("current");
    expect(connectStepStatus("session", "ssh", null, false)).toBe("pending");
    expect(connectStepStatus("ssh", "tunnel", null, false)).toBe("done");
    expect(connectStepStatus("session", "failed", "session", false)).toBe("failed");
    expect(connectStepStatus("agent", "connected", null, false)).toBe("current");
    expect(connectStepStatus("agent", "connected", null, true)).toBe("done");
  });

  it("derives four status lights and ROS-ready smoke", () => {
    const lights = deriveConnectStatusLights({
      stage: "connected",
      failedStep: null,
      sshOk: true,
      bridgeUp: true,
      agentOnline: true,
      agentChecked: true,
      agentError: "",
      hardwareReceived: false,
    });
    expect(lights).toEqual({ ssh: "ok", bridge: "ok", agent: "ok", hardware: "pending" });
    expect(isAgentOnline({ activeState: "active", subState: "running" })).toBe(true);
    expect(isAgentOnline({ activeState: "inactive", subState: "dead" })).toBe(false);
    expect(isRosReady(null)).toBe(false);
    expect(isRosReady({ name: ["j1"], position: [0] })).toBe(true);
  });

  it("formats readable connect errors with step context", () => {
    expect(formatConnectError("Permission denied (publickey)", "ssh")).toContain("SSH 认证失败");
    expect(formatConnectError("Connection refused", "session")).toContain("无法到达主机");
    expect(formatConnectError("websocket closed 1006", "bridge")).toContain("Bridge WebSocket");
  });

  it("persists recent hosts and domain hints without breaking profile keys", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    };
    expect(loadRecentHosts(storage)).toEqual([]);
    const hosts = rememberSuccessfulHost({
      host: "jetson",
      username: "robot",
      sshPort: 22,
      identityFile: "",
    }, storage, 1000);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.host).toBe("jetson");
    rememberSuccessfulHost({
      host: "192.168.1.8",
      username: "",
      sshPort: 22,
      identityFile: "~/.ssh/id_ed25519",
    }, storage, 2000);
    const loaded = loadRecentHosts(storage);
    expect(loaded[0]?.host).toBe("192.168.1.8");
    expect(loaded).toHaveLength(2);

    const patched = applyRecentHostToProfile(defaultProfile, loaded[0]!);
    expect(patched.host).toBe("192.168.1.8");
    expect(patched.jointStateTopic).toBe(defaultProfile.jointStateTopic);

    expect(domainMismatchHint(0, null)).toBe("");
    expect(domainMismatchHint(42, null)).toContain("ROS_DOMAIN_ID=42");
    rememberLastKnownDomainId(7, storage);
    expect(loadLastKnownDomainId(storage)).toBe(7);
    expect(domainMismatchHint(0, 7)).toContain("上次成功为 7");
  });
});
