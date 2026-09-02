import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "./bridge";

const doubles = vi.hoisted(() => ({
  setJointValue: vi.fn(),
  traverse: vi.fn((visitor: (object: { castShadow: boolean; receiveShadow: boolean }) => void) => visitor({ castShadow: false, receiveShadow: false })),
  updateWorldMatrix: vi.fn(),
}));

vi.mock("@react-three/fiber", () => ({
  Canvas: ({ children }: { children: unknown }) => <div>{children as React.ReactNode}</div>,
  useThree: () => ({
    camera: { position: { set: vi.fn() }, lookAt: vi.fn() },
    gl: { domElement: document.createElement("canvas") },
  }),
}));
vi.mock("three/examples/jsm/controls/OrbitControls.js", () => ({
  OrbitControls: class { enableDamping = false; dampingFactor = 0; update() {} dispose() {} },
}));
vi.mock("urdf-loader", () => ({
  default: class {
    loadMeshCb = undefined;
    parse() {
      return {
        traverse: doubles.traverse,
        setJointValue: doubles.setJointValue,
        updateWorldMatrix: doubles.updateWorldMatrix,
        children: [],
      };
    }
  },
}));

import { UrdfViewer } from "./UrdfViewer";

describe("UrdfViewer JointState synchronization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("replays the latest JointState after an asynchronously loaded URDF becomes ready", async () => {
    const bridge = { request: vi.fn() } as unknown as BridgeClient;
    render(<UrdfViewer
      xml={'<robot name="arm"><link name="base"/></robot>'}
      jointState={{ name: ["joint1", "joint2"], position: [0.42, -0.1] }}
      bridge={bridge}
    />);

    await waitFor(() => expect(doubles.setJointValue).toHaveBeenCalledWith("joint1", 0.42));
    expect(doubles.setJointValue).toHaveBeenCalledWith("joint2", -0.1);
  });
});
