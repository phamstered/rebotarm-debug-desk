import { Mesh, type Material, type Object3D } from "three";

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

type ColorMaterial = Material & {
  color?: { setRGB: (red: number, green: number, blue: number) => unknown };
};

function directChild(node: Element, name: string) {
  return Array.from(node.children).find((child) => child.localName.toLowerCase() === name);
}

function visualRgba(visualNode: Element): [number, number, number, number] | null {
  const materialNode = directChild(visualNode, "material");
  if (!materialNode) return null;
  const materialName = materialNode.getAttribute("name");
  const robotNode = visualNode.ownerDocument?.documentElement;
  const materialDefinition = directChild(materialNode, "color")
    ? materialNode
    : Array.from(robotNode?.children ?? []).find((candidate) =>
      candidate.localName.toLowerCase() === "material"
      && candidate.getAttribute("name") === materialName);
  const rgbaValue = directChild(materialDefinition ?? materialNode, "color")?.getAttribute("rgba");
  if (!rgbaValue) return null;
  const values = rgbaValue.trim().split(/\s+/).map(Number);
  if (values.length < 3 || values.some((value) => !Number.isFinite(value))) return null;
  return [values[0], values[1], values[2], values[3] ?? 1];
}

/** Applies colors declared by URDF visuals to nested DAE/OBJ meshes as well as STL meshes. */
export function applyUrdfVisualColors(robot: Object3D): void {
  robot.traverse((object) => {
    const visualNode = (object as Object3D & { urdfNode?: Element }).urdfNode;
    if (!visualNode || visualNode.localName.toLowerCase() !== "visual") return;
    const rgba = visualRgba(visualNode);
    if (!rgba) return;
    object.traverse((descendant) => {
      if (!(descendant instanceof Mesh)) return;
      const recolor = (source: Material) => {
        const material = source.clone() as ColorMaterial;
        material.color?.setRGB(rgba[0], rgba[1], rgba[2]);
        material.opacity = rgba[3];
        material.transparent = rgba[3] < 1;
        material.depthWrite = !material.transparent;
        return material;
      };
      descendant.material = Array.isArray(descendant.material)
        ? descendant.material.map(recolor)
        : recolor(descendant.material);
    });
  });
}
