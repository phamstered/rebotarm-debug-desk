import { describe, expect, it } from "vitest";
import { decodeRosImage, imageMetadataJson, isRosImageType } from "./imageTopicLogic";

describe("ROS image topic decoding", () => {
  it("decodes base64 RGB pixels while respecting row padding", () => {
    const bytes = [255, 0, 0, 0, 255, 0, 99, 99];
    const image = decodeRosImage({
      width: 2,
      height: 1,
      encoding: "rgb8",
      step: 8,
      is_bigendian: 0,
      data_base64: btoa(String.fromCharCode(...bytes)),
    });
    expect([...image.rgba]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  });

  it("converts BGR and big-endian mono16 images to display RGBA", () => {
    expect([...decodeRosImage({
      width: 1, height: 1, encoding: "bgr8", step: 3, data: [10, 20, 30],
    }).rgba]).toEqual([30, 20, 10, 255]);
    expect([...decodeRosImage({
      width: 1, height: 1, encoding: "mono16", step: 2, is_bigendian: 1, data: [128, 0],
    }).rgba]).toEqual([128, 128, 128, 255]);
  });

  it("rejects unsupported encodings and incomplete buffers", () => {
    expect(() => decodeRosImage({ width: 1, height: 1, encoding: "yuv422", step: 2, data: [0, 0] }))
      .toThrow("暂不支持图像编码：yuv422");
    expect(() => decodeRosImage({ width: 2, height: 2, encoding: "mono8", step: 2, data: [0, 1] }))
      .toThrow("图像数据不完整");
  });

  it("recognizes Image topics and hides binary payloads from metadata JSON", () => {
    expect(isRosImageType("sensor_msgs/msg/Image")).toBe(true);
    expect(isRosImageType("sensor_msgs/msg/CompressedImage")).toBe(false);
    const metadata = imageMetadataJson({ width: 2, height: 1, encoding: "rgb8", step: 6, data_base64: "AAAA", data_length: 6 });
    expect(metadata).toContain('"data_length": 6');
    expect(metadata).toContain("<base64 image data>");
    expect(metadata).not.toContain("AAAA");
    const binaryMetadata = imageMetadataJson({ width: 1, height: 1, encoding: "mono8", step: 1, data_bytes: new Uint8Array([42]) });
    expect(binaryMetadata).toContain("<binary image data>");
  });
});
