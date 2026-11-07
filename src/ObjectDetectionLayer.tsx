import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry, CanvasTexture, SRGBColorSpace } from "three";
import type { ObjectBox, ObjectDetectionFrame } from "./types";
import { objectBoxLines, objectLabel } from "./objectDetectionLogic";
import { urdfToScenePoint } from "./kinematicsLogic";
const ignoreRaycast = () => {};
function ObjectWireBox({ box, labels, dimensions, selected, onSelect }: { box: ObjectBox; labels: boolean; dimensions: boolean; selected: boolean; onSelect?(id:number):void }) {
  const geometry = useMemo(() => new BufferGeometry().setAttribute("position", new BufferAttribute(objectBoxLines(box), 3)), [box]);
  const text = objectLabel(box, dimensions);
  const texture = useMemo(() => {
    if (!labels) return null;
    const canvas = document.createElement("canvas"); canvas.height = 64;
    const ctx = canvas.getContext("2d"); if (!ctx) return null;
    ctx.font = "44px sans-serif"; canvas.width = Math.ceil(ctx.measureText(text).width) + 24;
    ctx.fillStyle = "rgba(8,18,29,0.88)"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#70efbc"; ctx.font = "44px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, 32);
    const result = new CanvasTexture(canvas); result.colorSpace = SRGBColorSpace; return result;
  }, [text, labels]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => texture?.dispose(), [texture]);
  const pick = (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); if(e.delta <= 3) onSelect?.(box.id); };
  return <group>
    {onSelect && <mesh position={[box.center[0],box.center[2],-box.center[1]]} onClick={pick}>
      <boxGeometry args={[box.size[0],box.size[2],box.size[1]]}/><meshBasicMaterial transparent opacity={selected?.13:0} color="#ffc66d" depthWrite={false}/>
    </mesh>}
    <lineSegments geometry={geometry} raycast={ignoreRaycast}><lineBasicMaterial color={selected?"#ffc66d":"#70efbc"} /></lineSegments>
    {texture && <sprite position={urdfToScenePoint([box.center[0], box.center[1], box.center[2] + box.size[2] / 2 + .025])}
      scale={[.025 * texture.image.width / texture.image.height, .025, 1]} raycast={onSelect?undefined:ignoreRaycast} onClick={onSelect?pick:undefined}>
      <spriteMaterial map={texture} transparent depthWrite={false} />
    </sprite>}
  </group>;
}
export function ObjectDetectionLayer({ frame, visible, labels, dimensions, selectedId, onSelect }: {
  frame?: ObjectDetectionFrame; visible: boolean; labels: boolean; dimensions: boolean; selectedId?:number; onSelect?(id:number):void;
}) {
  if (!visible || frame?.status !== "ok") return null;
  return <group>{frame.items.map(box => <ObjectWireBox key={box.id} box={box} labels={labels} dimensions={dimensions} selected={box.id===selectedId} onSelect={onSelect} />)}</group>;
}
