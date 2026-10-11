import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ViewerHeadsUp } from "./ViewerHeadsUp";

describe("ViewerHeadsUp", () => {
  it("把资源错误和轨迹状态放在同一个非重叠布局容器中", () => {
    render(
      <ViewerHeadsUp error="URDF 资源加载失败">
        <span>轨迹控制器未激活</span>
      </ViewerHeadsUp>,
    );

    const error = screen.getByRole("alert");
    const overlay = screen.getByText("轨迹控制器未激活").parentElement;
    expect(error.parentElement).toHaveClass("viewer-heads-up");
    expect(overlay).toHaveClass("viewer-overlay");
    expect(overlay?.parentElement).toBe(error.parentElement);
  });

  it("没有错误时仍把状态固定在 heads-up 容器中", () => {
    render(<ViewerHeadsUp error=""><span>状态</span></ViewerHeadsUp>);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("状态").parentElement?.parentElement).toHaveClass("viewer-heads-up");
  });
});
