import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { HandeyeImageViewer } from "./HandeyeImageViewer";
vi.mock("./RosImagePreview", () => ({
  RosImagePreview: () => <canvas aria-label="ROS 图像预览" />,
}));
const props = {
  sourceKey: "sample1:overlay",
  title: "检测图",
  caption: "静态截图",
  png: "iVBORw0KGgo",
  active: true,
  empty: "等待图像",
};
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
function loaded() {
  const image = screen.getByAltText("检测图");
  Object.defineProperties(image, {
    naturalWidth: { value: 1280, configurable: true },
    naturalHeight: { value: 720, configurable: true },
  });
  fireEvent.load(image);
}
it("provides fit, pixel scale, keyboard zoom and source reset", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<HandeyeImageViewer {...props} />);
  loaded();
  expect(screen.getByLabelText("图片缩放比例")).toHaveTextContent("50%");
  await user.click(screen.getByRole("button", { name: "原始尺寸" }));
  expect(screen.getByLabelText("图片缩放比例")).toHaveTextContent("100%");
  fireEvent.keyDown(screen.getByRole("group", { name: "检测图查看区" }), {
    key: "+",
  });
  expect(screen.getByLabelText("图片缩放比例")).toHaveTextContent("125%");
  fireEvent.doubleClick(screen.getByRole("group", { name: "检测图查看区" }));
  expect(screen.getByLabelText("图片缩放比例")).toHaveTextContent("50%");
  await user.click(screen.getByRole("button", { name: "原始尺寸" }));
  rerender(<HandeyeImageViewer {...props} sourceKey="sample2" />);
  loaded();
  expect(screen.getByLabelText("图片缩放比例")).toHaveTextContent("50%");
});
it("leaves ordinary wheel scrolling alone, zooms with Ctrl and restores focus after closing", async () => {
  const user = userEvent.setup();
  render(<HandeyeImageViewer {...props} />);
  loaded();
  const stage = screen.getByRole("group", { name: "检测图查看区" });
  expect(fireEvent.wheel(stage, { deltaY: -100 })).toBe(true);
  expect(screen.getByLabelText("图片缩放比例")).toHaveTextContent("50%");
  expect(fireEvent.wheel(stage, { deltaY: -100, ctrlKey: true })).toBe(false);
  expect(screen.getByLabelText("图片缩放比例")).toHaveTextContent("57%");
  await user.click(screen.getByRole("button", { name: "放大查看" }));
  expect(screen.getByRole("dialog", { name: "检测图大图" })).toBeVisible();
  expect(screen.getByRole("button", { name: "关闭大图 · Esc" })).toHaveFocus();
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: true }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "放大查看" })).toHaveFocus(),
  );
});
it("retains live zoom between frames but hides stale images and closes on page departure", async () => {
  const user = userEvent.setup();
  const liveProps = {
    ...props,
    sourceKey: "live",
    png: undefined,
    live: true,
    liveData: { width: 1280, height: 720 },
  };
  const { rerender } = render(<HandeyeImageViewer {...liveProps} />);
  await user.click(screen.getByRole("button", { name: "原始尺寸" }));
  rerender(
    <HandeyeImageViewer
      {...liveProps}
      liveData={{ width: 1280, height: 720, frame: 2 }}
    />,
  );
  expect(screen.getByLabelText("图片缩放比例")).toHaveTextContent("100%");
  await user.click(screen.getByRole("button", { name: "放大查看" }));
  rerender(
    <HandeyeImageViewer {...liveProps} active={false} liveData={null} />,
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.getByText("等待图像")).toBeVisible();
  expect(screen.getByRole("button", { name: "放大查看" })).toBeDisabled();
});
it("shows decode failures instead of leaving an apparently usable viewer", () => {
  render(<HandeyeImageViewer {...props} />);
  fireEvent.error(screen.getByAltText("检测图"));
  expect(screen.getByText(/图片无法解码/)).toBeVisible();
  expect(screen.getByRole("button", { name: "原始尺寸" })).toBeDisabled();
});

it("preserves alignment when toggling overlay on the same capture", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<HandeyeImageViewer {...props} />);
  loaded();
  await user.click(screen.getByRole("button", { name: "原始尺寸" }));
  fireEvent.keyDown(screen.getByRole("group", { name: "检测图查看区" }), {
    key: "ArrowRight",
  });
  const before = screen.getByAltText("检测图").parentElement!.style.transform;
  rerender(<HandeyeImageViewer {...props} png="iVBORw0KGgoRAW" />);
  loaded();
  expect(screen.getByLabelText("图片缩放比例")).toHaveTextContent("100%");
  expect(screen.getByAltText("检测图").parentElement!.style.transform).toBe(
    before,
  );
});

it("pans with captured pointer movement, clamps the image and stops on cancellation", async () => {
  const user = userEvent.setup();
  render(<HandeyeImageViewer {...props} />);
  loaded();
  await user.click(screen.getByRole("button", { name: "原始尺寸" }));
  const stage = screen.getByRole("group", { name: "检测图查看区" });
  stage.setPointerCapture = vi.fn();
  const pointer = (type: string, x: number, y: number) =>
    fireEvent(
      stage,
      Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
        pointerId: 7,
        button: 0,
        clientX: x,
        clientY: y,
      }),
    );
  pointer("pointerdown", 100, 100);
  pointer("pointermove", 5000, -5000);
  expect(stage.setPointerCapture).toHaveBeenCalledWith(7);
  expect(
    screen.getByAltText("检测图").parentElement!.style.transform,
  ).toContain("translate(320px, -180px)");
  pointer("pointercancel", 5000, -5000);
  pointer("pointermove", 0, 0);
  expect(
    screen.getByAltText("检测图").parentElement!.style.transform,
  ).toContain("translate(320px, -180px)");
});
