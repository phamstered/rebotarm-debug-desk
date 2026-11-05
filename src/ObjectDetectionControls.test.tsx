import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ObjectDetectionControls } from "./ObjectDetectionControls";
it("gates unsupported detection and exposes display-only options", () => {
  const change=vi.fn();const props={supported:false,enabled:false,onEnabledChange:change,labels:true,dimensions:false,onLabelsChange:vi.fn(),onDimensionsChange:vi.fn()};
  const view=render(<ObjectDetectionControls {...props}/>);
  expect(screen.getByLabelText("物体三维框")).toBeDisabled();
  view.rerender(<ObjectDetectionControls {...props} supported/>);
  fireEvent.click(screen.getByLabelText("物体三维框"));expect(change).toHaveBeenCalledWith(true);
  view.rerender(<ObjectDetectionControls {...props} supported enabled frame={{status:"no_table",message:"未找到桌面",items:[],frame_seq:1}}/>);
  expect(screen.getByText("0 个物体 · 未找到桌面")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("可见尺寸"));expect(props.onDimensionsChange).toHaveBeenCalledWith(true);
});
