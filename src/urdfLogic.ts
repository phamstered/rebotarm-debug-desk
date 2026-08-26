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
