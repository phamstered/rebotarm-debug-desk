import {useMemo} from "react";
import {Quaternion,Vector3} from "three";
import type {VisualPickPreview} from "./types";
import {urdfToScenePoint} from "./kinematicsLogic";
export function VisualPickPreviewLayer({preview}:{preview:VisualPickPreview|null}){
  const data=useMemo(()=>{
    if(!preview)return null;
    const grasp=urdfToScenePoint(preview.grasp.position),pre=urdfToScenePoint(preview.pregrasp.position);
    const rotation=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),-Math.PI/2).multiply(new Quaternion(...preview.grasp.orientation));
    const origins=[new Vector3(...pre),...Array.from({length:3},()=>new Vector3(...grasp))];
    const ends=[new Vector3(...grasp),...[[1,0,0],[0,1,0],[0,0,1]].map(axis=>new Vector3(...axis).multiplyScalar(.05).applyQuaternion(rotation).add(new Vector3(...grasp)))];
    const segments=origins.map((from,i)=>{const delta=ends[i].clone().sub(from);return{position:from.clone().add(ends[i]).multiplyScalar(.5),length:delta.length(),rotation:new Quaternion().setFromUnitVectors(new Vector3(0,1,0),delta.normalize())};});
    return{grasp,pre,segments};
  },[preview]);
  if(!data)return null;
  return <group>
    {data.segments.map((s,i)=><mesh key={i} position={s.position} quaternion={s.rotation} raycast={()=>{}} renderOrder={6} frustumCulled={false}>
      <cylinderGeometry args={[.0015,.0015,s.length,8]}/><meshBasicMaterial color={["#ffc66d","#ff605a","#65df8e","#58a8ff"][i]} depthTest={false} depthWrite={false}/>
    </mesh>)}
    <mesh position={data.grasp} raycast={()=>{}} renderOrder={7}><sphereGeometry args={[.008,12,8]}/><meshBasicMaterial color="#ffc66d" depthTest={false} depthWrite={false}/></mesh>
    <mesh position={data.pre} raycast={()=>{}} renderOrder={7}><sphereGeometry args={[.006,12,8]}/><meshBasicMaterial color="#ffc66d" depthTest={false} depthWrite={false}/></mesh>
  </group>;
}
