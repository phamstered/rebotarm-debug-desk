import { Color, Mesh, type Material, type Object3D } from "three";

type UrdfObject = Object3D & {
  isURDFVisual?: boolean;
  urdfNode?: Element | null;
};

type ColorMaterial = Material & {
  color: Color;
  depthWrite: boolean;
  needsUpdate: boolean;
  opacity: number;
  transparent: boolean;
};

function directChild(element: Element, name: string): Element | undefined {
  return Array.from(element.children).find((child) => child.localName.toLowerCase() === name);
}

function visualRgba(visual: Element): [number, number, number, number] | null {
  let material = directChild(visual, "material");
  if (!material) return null;

  let color = directChild(material, "color");
  if (!color) {
    const materialName = material.getAttribute("name");
    const robot = visual.ownerDocument?.documentElement;
    material = materialName && robot
      ? Array.from(robot.children).find((candidate) => (
        candidate.localName.toLowerCase() === "material"
        && candidate.getAttribute("name") === materialName
      ))
      : undefined;
    color = material ? directChild(material, "color") : undefined;
  }

  const values = color?.getAttribute("rgba")?.trim().split(/\s+/).map(Number);
  if (!values || values.length < 3 || values.some((value) => !Number.isFinite(value))) return null;
  return [values[0], values[1], values[2], values[3] ?? 1];
}

function visualAncestor(object: Object3D): UrdfObject | null {
  let current: UrdfObject | null = object as UrdfObject;
  while (current) {
    if (current.isURDFVisual || current.urdfNode?.localName.toLowerCase() === "visual") return current;
    current = current.parent as UrdfObject | null;
  }
  return null;
}

function applyColor(material: Material, rgba: [number, number, number, number]): Material {
  const clone = material.clone() as ColorMaterial;
  if (!(clone.color instanceof Color)) return material;
  clone.color.setRGB(rgba[0], rgba[1], rgba[2]);
  clone.opacity = rgba[3];
  clone.transparent = rgba[3] < 1;
  clone.depthWrite = !clone.transparent;
  clone.needsUpdate = true;
  return clone;
}

/** Apply a visual's URDF color without discarding textures or other mesh material properties. */
export function applyUrdfVisualColors(root: Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const visual = visualAncestor(object);
    const rgba = visual?.urdfNode ? visualRgba(visual.urdfNode) : null;
    if (!rgba) return;
    object.material = Array.isArray(object.material)
      ? object.material.map((material) => applyColor(material, rgba))
      : applyColor(object.material, rgba);
  });
}

/** Run after an async STL/DAE/OBJ object has been attached to its URDFVisual. */
export function finalizeLoadedUrdfMesh(object: Object3D): void {
  object.traverse((child) => {
    child.castShadow = true;
    child.receiveShadow = true;
  });
  applyUrdfVisualColors(object);
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function resolvePackageRelative(baseUri: string, relative: string): string {
  if (relative.startsWith("package://")) return relative;
  const base = baseUri.slice(0, baseUri.lastIndexOf("/") + 1);
  const parts = `${base.slice("package://".length)}${relative}`.split("/");
  const normalized: string[] = [];
  parts.forEach((part) => {
    if (!part || part === ".") return;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  });
  return `package://${normalized.join("/")}`;
}

export function packageUris(xml: string): string[] {
  return [...new Set(xml.match(/package:\/\/[^"'\s<>)]+/g) ?? [])];
}

export async function loadPackageResourcesSequentially(
  xml: string,
  load: (uri: string) => Promise<void>,
): Promise<void> {
  for (const uri of packageUris(xml)) {
    try {
      await load(uri);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      throw new Error(`URDF 资源加载失败：${uri}（${detail}）`);
    }
  }
}

export function applyJointState(
  names: string[] | undefined,
  positions: number[] | undefined,
  setJointValue: (name: string, value: number) => void,
): void {
  (names ?? []).forEach((name, index) => setJointValue(name, positions?.[index] ?? 0));
}
