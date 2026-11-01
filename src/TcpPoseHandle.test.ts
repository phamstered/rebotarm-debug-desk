import { expect, it, vi } from "vitest";
import { Group, Mesh, PerspectiveCamera, Raycaster, Vector3 } from "three";
import {
  installTcpPosePointerHandlers,
  type TcpPoseHandleProps,
} from "./TcpPoseHandle";
function setup() {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  canvas.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 200,
    height: 200,
    right: 200,
    bottom: 200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  let capture = -1;
  canvas.setPointerCapture = vi.fn((id) => {
    capture = id;
  });
  canvas.hasPointerCapture = (id) => capture === id;
  canvas.releasePointerCapture = vi.fn(() => {
    capture = -1;
  });
  const camera = new PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.set(0, 0, 4);
  camera.lookAt(new Vector3());
  camera.updateMatrixWorld();
  const raycaster = new Raycaster(),
    mesh = new Mesh();
  mesh.userData = { axisIndex: 0, rotation: false };
  vi.spyOn(raycaster, "intersectObject").mockReturnValue([
    { object: mesh, distance: 1, point: new Vector3() },
  ]);
  const state: TcpPoseHandleProps = {
    pose: { position: [0, 0, 0], orientation: [0, 0, 0, 1] },
    frame: "base",
    enabled: true,
    onDragStart: vi.fn(),
    onDragMove: vi.fn(),
    onDragEnd: vi.fn(),
    onDragCancel: vi.fn(),
  };
  const controller = installTcpPosePointerHandlers({
    element: canvas,
    camera,
    raycaster,
    getGroup: () => new Group(),
    getState: () => state,
  });
  const send = (type: string, x = 100, id = 1, y = 100) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
    });
    Object.defineProperty(event, "pointerId", { value: id });
    canvas.dispatchEvent(event);
    return event;
  };
  return { canvas, state, controller, send, mesh, camera, raycaster };
}
it("free sphere drags in the fixed camera plane without snapping or changing orientation", () => {
  const { canvas, state, controller, send, mesh } = setup();
  mesh.userData = { freeDrag: true };
  state.pose.orientation = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  state.frame = "tool";
  const orbit = vi.fn();
  canvas.addEventListener("pointerdown", orbit);
  try {
    send("pointerdown", 108, 1, 104);
    expect(orbit).not.toHaveBeenCalled();
    send("pointermove", 108, 1, 104);
    expect(vi.mocked(state.onDragMove).mock.calls[0][0]).toEqual(state.pose);
    send("pointermove", 128, 1, 84);
    const target = vi.mocked(state.onDragMove).mock.calls[1][0];
    expect(target.position[0]).toBeGreaterThan(0);
    expect(target.position[1]).toBeCloseTo(0); // Scene Z maps to URDF Y.
    expect(target.position[2]).toBeGreaterThan(0);
    expect(target.orientation).toEqual(state.pose.orientation);
    send("pointerup");
    expect(state.onDragEnd).toHaveBeenCalledOnce();
    expect(state.onDragCancel).not.toHaveBeenCalled();
  } finally { controller.dispose(); canvas.remove(); }
});
it("free sphere keeps the initiating pointer and cancels cleanly on Escape", () => {
  const { canvas, state, controller, send, mesh } = setup();
  mesh.userData = { freeDrag: true };
  try {
    send("pointerdown");
    send("pointerdown", 120, 2);
    send("pointermove", 120, 2);
    send("pointerup", 120, 2);
    expect(state.onDragStart).toHaveBeenCalledOnce();
    expect(state.onDragMove).not.toHaveBeenCalled();
    expect(state.onDragEnd).not.toHaveBeenCalled();
    send("pointermove", 120);
    expect(state.onDragMove).toHaveBeenCalledOnce();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(state.onDragCancel).toHaveBeenCalledOnce();
    expect(canvas.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1);
    send("pointerup");
    expect(state.onDragEnd).not.toHaveBeenCalled();
  } finally { controller.dispose(); canvas.remove(); }
});
it("visible free sphere takes precedence over an overlapping axis", () => {
  const { canvas, state, controller, send, mesh, raycaster } = setup();
  const sphere = new Mesh();
  sphere.userData = { freeDrag: true };
  vi.mocked(raycaster.intersectObject).mockReturnValue([
    { object: mesh, distance: 1, point: new Vector3() },
    { object: sphere, distance: 2, point: new Vector3() },
  ]);
  try {
    send("pointerdown");
    send("pointermove", 100, 1, 80);
    expect(vi.mocked(state.onDragMove).mock.calls[0][0].position[2]).toBeGreaterThan(0);
  } finally { controller.dispose(); canvas.remove(); }
});
it("captures axis drags before OrbitControls and releases once on pointerup", () => {
  const { canvas, state, controller, send } = setup();
  const orbit = vi.fn();
  canvas.addEventListener("pointerdown", orbit);
  try {
    send("pointerdown");
    expect(orbit).not.toHaveBeenCalled();
    expect(state.onDragStart).toHaveBeenCalledOnce();
    send("pointermove", 120, 2);
    expect(state.onDragMove).not.toHaveBeenCalled();
    send("pointermove", 120);
    expect(state.onDragMove).toHaveBeenCalledOnce();
    expect(
      (state.onDragMove as any).mock.calls[0][0].position[0],
    ).toBeGreaterThan(0);
    send("pointerup", 120);
    expect(state.onDragEnd).toHaveBeenCalledOnce();
    expect(state.onDragCancel).not.toHaveBeenCalled();
    expect(canvas.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1);
  } finally {
    controller.dispose();
    canvas.remove();
  }
});
it("pointercancel, Escape, lost capture and teardown cancel without ending a motion", () => {
  const { canvas, state, controller, send } = setup();
  try {
    send("pointerdown");
    send("pointercancel");
    expect(state.onDragCancel).toHaveBeenCalledTimes(1);
    send("pointerdown");
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(state.onDragCancel).toHaveBeenCalledTimes(2);
    send("pointerdown");
    send("lostpointercapture");
    expect(state.onDragCancel).toHaveBeenCalledTimes(3);
    send("pointerdown");
    controller.dispose();
    expect(state.onDragCancel).toHaveBeenCalledTimes(4);
    expect(state.onDragEnd).not.toHaveBeenCalled();
  } finally {
    controller.dispose();
    canvas.remove();
  }
});
it("disabled handles leave camera gestures alone", () => {
  const { canvas, state, controller, send } = setup();
  state.enabled = false;
  const orbit = vi.fn();
  canvas.addEventListener("pointerdown", orbit);
  try {
    send("pointerdown");
    expect(orbit).toHaveBeenCalledOnce();
    expect(state.onDragStart).not.toHaveBeenCalled();
  } finally {
    controller.dispose();
    canvas.remove();
  }
});

it("rotation rings change orientation while preserving TCP position", () => {
  const { canvas, state, controller, send, mesh } = setup();
  mesh.userData = { axisIndex: 1, rotation: true };
  try {
    send("pointerdown", 120);
    const event = new MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: 100, clientY: 80, button: 0 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    canvas.dispatchEvent(event);
    const target = (state.onDragMove as any).mock.calls[0][0];
    expect(target.position).toEqual([0,0,0]);
    expect(target.orientation).not.toEqual([0,0,0,1]);
    expect(Math.hypot(...target.orientation)).toBeCloseTo(1);
    send("pointerup");
    expect(state.onDragEnd).toHaveBeenCalledOnce();
  } finally { controller.dispose(); canvas.remove(); }
});
