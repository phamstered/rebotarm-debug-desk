declare module "urdf-loader" {
  import { LoadingManager, Object3D } from "three";

  export interface URDFRobot extends Object3D {
    joints: Record<string, { setJointValue(value: number): void }>;
    links: Record<string, Object3D>;
    setJointValue(name: string, value: number): void;
  }

  export default class URDFLoader {
    constructor(manager?: LoadingManager);
    loadMeshCb: (path: string, manager: LoadingManager, done: (object: Object3D | null, error?: Error) => void) => void;
    parse(content: string): URDFRobot;
  }
}
