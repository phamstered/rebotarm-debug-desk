export type RosImageMessage = {
  header?: { stamp?: { sec?: number; nanosec?: number }; frame_id?: string };
  height: number;
  width: number;
  encoding: string;
  is_bigendian?: number | boolean;
  step: number;
  data?: number[];
  data_bytes?: Uint8Array;
  data_base64?: string;
  data_length?: number;
};

export type DecodedRosImage = {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  message: RosImageMessage;
};

const BYTES_PER_PIXEL: Record<string, number> = {
  rgb8: 3,
  bgr8: 3,
  rgba8: 4,
  bgra8: 4,
  mono8: 1,
  "8uc1": 1,
  "8uc3": 3,
  "8uc4": 4,
  mono16: 2,
  "16uc1": 2,
};

function bytesFromMessage(message: RosImageMessage): Uint8Array {
  if (message.data_bytes instanceof Uint8Array) return message.data_bytes;
  if (typeof message.data_base64 === "string") {
    const binary = atob(message.data_base64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  if (Array.isArray(message.data)) {
    if (message.data.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
      throw new Error("图像 data 必须是 0–255 的字节数组");
    }
    return Uint8Array.from(message.data);
  }
  throw new Error("图像消息缺少 data_bytes、data_base64 或 data");
}

export function isRosImageType(topicType: string): boolean {
  return topicType === "sensor_msgs/msg/Image";
}

export function decodeRosImage(value: unknown): DecodedRosImage {
  if (!value || typeof value !== "object") throw new Error("等待图像数据…");
  const message = value as RosImageMessage;
  const width = Number(message.width);
  const height = Number(message.height);
  const step = Number(message.step);
  const encoding = String(message.encoding ?? "").toLowerCase();
  const bytesPerPixel = BYTES_PER_PIXEL[encoding];
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("图像宽高无效");
  }
  if (!bytesPerPixel) throw new Error(`暂不支持图像编码：${message.encoding || "未知"}`);
  if (!Number.isInteger(step) || step < width * bytesPerPixel) throw new Error("图像 step 小于单行像素数据");
  const bytes = bytesFromMessage(message);
  if (bytes.length < step * height) throw new Error(`图像数据不完整：需要 ${step * height} 字节，收到 ${bytes.length} 字节`);

  const rgba = new Uint8ClampedArray(width * height * 4);
  const bigEndian = message.is_bigendian === true || Number(message.is_bigendian) === 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = y * step + x * bytesPerPixel;
      const target = (y * width + x) * 4;
      if (encoding === "rgb8" || encoding === "8uc3") {
        rgba[target] = bytes[source];
        rgba[target + 1] = bytes[source + 1];
        rgba[target + 2] = bytes[source + 2];
      } else if (encoding === "bgr8") {
        rgba[target] = bytes[source + 2];
        rgba[target + 1] = bytes[source + 1];
        rgba[target + 2] = bytes[source];
      } else if (encoding === "rgba8" || encoding === "8uc4") {
        rgba[target] = bytes[source];
        rgba[target + 1] = bytes[source + 1];
        rgba[target + 2] = bytes[source + 2];
        rgba[target + 3] = bytes[source + 3];
        continue;
      } else if (encoding === "bgra8") {
        rgba[target] = bytes[source + 2];
        rgba[target + 1] = bytes[source + 1];
        rgba[target + 2] = bytes[source];
        rgba[target + 3] = bytes[source + 3];
        continue;
      } else if (encoding === "mono16" || encoding === "16uc1") {
        const highByte = bytes[source + (bigEndian ? 0 : 1)];
        rgba[target] = highByte;
        rgba[target + 1] = highByte;
        rgba[target + 2] = highByte;
      } else {
        rgba[target] = bytes[source];
        rgba[target + 1] = bytes[source];
        rgba[target + 2] = bytes[source];
      }
      rgba[target + 3] = 255;
    }
  }
  return { width, height, rgba, message };
}

export function imageMetadataJson(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify("等待数据…", null, 2);
  const message = value as RosImageMessage;
  const byteLength = message.data_length
    ?? message.data_bytes?.byteLength
    ?? (Array.isArray(message.data) ? message.data.length : undefined);
  return JSON.stringify({
    header: message.header,
    height: message.height,
    width: message.width,
    encoding: message.encoding,
    is_bigendian: message.is_bigendian,
    step: message.step,
    data_length: byteLength,
    data: message.data_bytes ? "<binary image data>" : message.data_base64 ? "<base64 image data>" : message.data ? `<${message.data.length} bytes>` : undefined,
  }, null, 2);
}
