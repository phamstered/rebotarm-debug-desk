import type { BridgeEnvelope } from "./types";

const IMAGE_MAGIC = [0x52, 0x43, 0x49, 0x31]; // RCI1
const RESOURCE_MAGIC = [0x52, 0x43, 0x52, 0x31]; // RCR1
const TARGET_MAGIC = [0x52, 0x43, 0x54, 0x31]; // RCT1
const RGBD_MAGIC = [0x52, 0x43, 0x44, 0x31]; // RCD1

export function decodeBridgeEnvelope(payload: string | ArrayBuffer | Uint8Array): BridgeEnvelope {
  if (typeof payload === "string") return JSON.parse(payload) as BridgeEnvelope;
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const image = IMAGE_MAGIC.every((value, index) => bytes[index] === value);
  const resource = RESOURCE_MAGIC.every((value, index) => bytes[index] === value);
  const rgbd = RGBD_MAGIC.every((value, index) => bytes[index] === value);
  const target = TARGET_MAGIC.every((value, index) => bytes[index] === value);
  if (bytes.length < 8 || (!image && !resource && !rgbd && !target)) throw new Error("未知的 Bridge 二进制消息");
  const metadataLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, false);
  const offset = 8 + metadataLength;
  if (offset > bytes.length) throw new Error("Bridge 二进制元数据不完整");
  const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(8, offset))) as BridgeEnvelope;
  if (resource) {
    if (metadata.op !== "resource" || !metadata.request_id || !metadata.uri || metadata.data_length !== bytes.length - offset) {
      throw new Error("Bridge 资源帧长度或元数据无效");
    }
    metadata.resource_bytes = bytes.subarray(offset);
  } else if (target) {
    if(metadata.op!=="visual_target_frame" || metadata.data_length!==bytes.length-offset)throw new Error("Bridge RGB 目标帧无效");
    metadata.target_rgb_payload=bytes.subarray(offset);
  } else if (rgbd) {
    if (metadata.op !== "rgbd_frame") throw new Error("Bridge RGBD 元数据无效");
    const expected = Number(metadata.data_length ?? bytes.length - offset);
    if (expected !== bytes.length - offset) throw new Error("Bridge RGBD 帧长度无效");
    metadata.rgbd_payload = bytes.subarray(offset);
  } else {
    if (metadata.op !== "topic_message" || !metadata.data || typeof metadata.data !== "object") throw new Error("Bridge 图像元数据无效");
    (metadata.data as Record<string, unknown>).data_bytes = bytes.subarray(offset);
  }
  return metadata;
}

