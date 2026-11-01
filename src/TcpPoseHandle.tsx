import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  Group,
  Quaternion,
  Vector2,
  Vector3,
  type Camera,
  type PerspectiveCamera,
  type OrthographicCamera,
  type Raycaster,
} from "three";
import {
  axisRayParameter,
  moveTcpPose,
  rayRingVector,
  TCP_AXES,
  type TcpHandleFrame,
  type TcpTargetPose,
} from "./tcpPoseInteractionLogic";
const ROOT_ROTATION = new Quaternion().setFromAxisAngle(
  new Vector3(1, 0, 0),
  -Math.PI / 2,
);
export type TcpPoseHandleProps = {
  pose: TcpTargetPose;
  frame: TcpHandleFrame;
  enabled: boolean;
  onDragStart(): void;
  onDragMove(pose: TcpTargetPose): void;
  onDragEnd(): void;
  onDragCancel(): void;
};
export function installTcpPosePointerHandlers({
  element,
  camera,
  raycaster,
  getGroup,
  getState,
}: {
  element: HTMLCanvasElement;
  camera: Camera;
  raycaster: Raycaster;
  getGroup(): Group | null;
  getState(): TcpPoseHandleProps;
}) {
  let drag: {
    id: number;
    start: TcpTargetPose;
    frame: TcpHandleFrame;
    axisIndex: number;
    rotation: boolean;
    axis: Vector3;
    point: Vector3;
    parameter: number;
    radial: Vector3 | null;
  } | null = null;
  const ray = (event: PointerEvent) => {
    const rect = element.getBoundingClientRect();
    raycaster.setFromCamera(
      new Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    );
  };
  const stop = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const release = () => {
    const id = drag?.id;
    drag = null;
    if (id !== undefined && element.hasPointerCapture(id))
      element.releasePointerCapture(id);
  };
  const cancel = () => {
    if (!drag) return;
    release();
    getState().onDragCancel();
  };
  const down = (event: PointerEvent) => {
    const currentGroup = getGroup();
    if (
      event.target !== element ||
      event.button !== 0 ||
      !getState().enabled ||
      !currentGroup
    )
      return;
    ray(event);
    const hit = raycaster
      .intersectObject(currentGroup, true)
      .find((item) => item.object.userData.axisIndex !== undefined);
    if (!hit) return;
    const { axisIndex, rotation } = hit.object.userData as {
      axisIndex: number;
      rotation: boolean;
    };
    const start = getState().pose,
      axis = new Vector3(...TCP_AXES[axisIndex]);
    if (getState().frame === "tool")
      axis.applyQuaternion(new Quaternion(...start.orientation));
    axis.applyQuaternion(ROOT_ROTATION);
    const point = new Vector3(...start.position).applyQuaternion(ROOT_ROTATION);
    const parameter = axisRayParameter(
      raycaster.ray.origin,
      raycaster.ray.direction,
      point,
      axis,
      camera.getWorldDirection(new Vector3()),
    );
    const radial = rayRingVector(
      raycaster.ray.origin,
      raycaster.ray.direction,
      point,
      axis,
    );
    if (rotation ? !radial : parameter === null) return;
    stop(event);
    element.setPointerCapture(event.pointerId);
    drag = {
      id: event.pointerId,
      start,
      frame: getState().frame,
      axisIndex,
      rotation,
      axis,
      point,
      parameter: parameter ?? 0,
      radial,
    };
    getState().onDragStart();
  };
  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    stop(event);
    ray(event);
    let amount: number;
    if (drag.rotation) {
      const radial = rayRingVector(
        raycaster.ray.origin,
        raycaster.ray.direction,
        drag.point,
        drag.axis,
      );
      if (!radial || !drag.radial) return;
      amount = Math.atan2(
        drag.axis.dot(drag.radial.clone().cross(radial)),
        drag.radial.dot(radial),
      );
    } else {
      const parameter = axisRayParameter(
        raycaster.ray.origin,
        raycaster.ray.direction,
        drag.point,
        drag.axis,
        camera.getWorldDirection(new Vector3()),
      );
      if (parameter === null) return;
      amount = parameter - drag.parameter;
    }
    getState().onDragMove(
      moveTcpPose(
        drag.start,
        drag.axisIndex,
        drag.frame,
        amount,
        drag.rotation,
      ),
    );
  };
  const up = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    stop(event);
    release();
    getState().onDragEnd();
  };
  const canceled = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    stop(event);
    cancel();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape" && drag) {
      stop(event);
      cancel();
    }
  };
  window.addEventListener("pointerdown", down, true);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", canceled, true);
  window.addEventListener("keydown", key, true);
  element.addEventListener("lostpointercapture", canceled);
  return {
    cancel,
    dispose: () => {
      cancel();
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", canceled, true);
      window.removeEventListener("keydown", key, true);
      element.removeEventListener("lostpointercapture", canceled);
    },
  };
}
export function TcpPoseHandle({
  pose,
  frame,
  enabled,
  onDragStart,
  onDragMove,
  onDragEnd,
  onDragCancel,
}: {
  pose: TcpTargetPose;
  frame: TcpHandleFrame;
  enabled: boolean;
  onDragStart(): void;
  onDragMove(pose: TcpTargetPose): void;
  onDragEnd(): void;
  onDragCancel(): void;
}) {
  const { camera, gl, raycaster } = useThree();
  const group = useRef<Group>(null);
  const cancelRef = useRef<() => void>(() => {});
  const state = useRef({
    pose,
    frame,
    enabled,
    onDragStart,
    onDragMove,
    onDragEnd,
    onDragCancel,
  });
  state.current = {
    pose,
    frame,
    enabled,
    onDragStart,
    onDragMove,
    onDragEnd,
    onDragCancel,
  };
  const rotations = useMemo(
    () =>
      TCP_AXES.map((axis) => ({
        arrow: new Quaternion().setFromUnitVectors(
          new Vector3(0, 1, 0),
          new Vector3(...axis),
        ),
        ring: new Quaternion().setFromUnitVectors(
          new Vector3(0, 0, 1),
          new Vector3(...axis),
        ),
      })),
    [],
  );
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    g.position
      .set(...state.current.pose.position)
      .applyQuaternion(ROOT_ROTATION);
    g.quaternion.copy(ROOT_ROTATION);
    if (state.current.frame === "tool")
      g.quaternion.multiply(new Quaternion(...state.current.pose.orientation));
    const height = Math.max(gl.domElement.clientHeight, 1);
    const perspective = camera as PerspectiveCamera;
    const orthographic = camera as OrthographicCamera;
    const span = perspective.isPerspectiveCamera
      ? camera.position.distanceTo(g.position) * 2 * Math.tan(perspective.fov * Math.PI / 360)
      : (orthographic.top - orthographic.bottom) / orthographic.zoom;
    g.scale.setScalar(Math.max(span * 65 / height, .00001));
  });
  useEffect(() => {
    const control = installTcpPosePointerHandlers({
      element: gl.domElement,
      camera,
      raycaster,
      getGroup: () => group.current,
      getState: () => state.current,
    });
    cancelRef.current = control.cancel;
    return control.dispose;
  }, [camera, gl, raycaster]);
  useEffect(() => {
    if (!enabled) cancelRef.current();
  }, [enabled]);
  return (
    <group ref={group} name="tcp-six-axis-handle">
      {TCP_AXES.map((_, i) => (
        <group key={i}>
          <group quaternion={rotations[i].arrow}>
            <mesh
              position={[0, 0.6, 0]}
              userData={{ axisIndex: i, rotation: false }}
            >
              <cylinderGeometry args={[0.025, 0.025, 1.2, 10]} />
              <meshBasicMaterial
                color={["#ef4444", "#22c55e", "#3b82f6"][i]}
                depthTest={false}
                transparent
                opacity={enabled ? 0.95 : 0.35}
              />
            </mesh>
            <mesh
              position={[0, 1.3, 0]}
              userData={{ axisIndex: i, rotation: false }}
            >
              <coneGeometry args={[0.09, 0.23, 12]} />
              <meshBasicMaterial
                color={["#ef4444", "#22c55e", "#3b82f6"][i]}
                depthTest={false}
              />
            </mesh>
          </group>
          <mesh
            quaternion={rotations[i].ring}
            userData={{ axisIndex: i, rotation: true }}
          >
            <torusGeometry args={[0.85, 0.025, 8, 72]} />
            <meshBasicMaterial
              color={["#ef4444", "#22c55e", "#3b82f6"][i]}
              depthTest={false}
              transparent
              opacity={enabled ? 0.8 : 0.3}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}
