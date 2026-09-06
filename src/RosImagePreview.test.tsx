import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RosImagePreview } from "./RosImagePreview";

describe("RosImagePreview", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("coalesces rapid messages into one animation-frame draw using the newest image", async () => {
    let drawFrame: FrameRequestCallback | undefined;
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      drawFrame = callback;
      return 7;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const putImageData = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ putImageData } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal("ImageData", class {
      constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    const red = { width: 1, height: 1, encoding: "rgb8", step: 3, data: [255, 0, 0] };
    const green = { width: 1, height: 1, encoding: "rgb8", step: 3, data: [0, 255, 0] };
    const { rerender } = render(<RosImagePreview data={red} />);

    rerender(<RosImagePreview data={green} />);

    expect(requestFrame).toHaveBeenCalledOnce();
    act(() => drawFrame?.(0));
    await waitFor(() => expect(putImageData).toHaveBeenCalledOnce());
    const rendered = putImageData.mock.calls[0][0] as { data: Uint8ClampedArray };
    expect([...rendered.data]).toEqual([0, 255, 0, 255]);
    expect(screen.getByText("1 × 1 · rgb8")).toBeVisible();
  });
});
