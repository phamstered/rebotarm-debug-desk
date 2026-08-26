import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { TopicInspector } from "./TopicInspector";

const sample = { data: { position: [0.2, 0.6], name: ["joint1"] }, count: 4, firstAt: 1, lastAt: 2, hz: 20 };

describe("TopicInspector jq filtering", () => {
  beforeEach(() => localStorage.clear());

  it("shows raw JSON by default without a jq expression", () => {
    render(<TopicInspector selected="/joint_states" sample={sample} />);
    expect(screen.getByLabelText("jq 过滤 /joint_states")).toHaveValue("");
    expect(screen.getByText("未筛选 · 原始 JSON")).toBeVisible();
    expect(screen.getByText(/"position": \[/)).toBeVisible();
  });

  it("runs and persists a per-topic jq expression in Topic Inspector", async () => {
    render(<TopicInspector selected="/joint_states" sample={sample} />);
    fireEvent.change(screen.getByLabelText("jq 过滤 /joint_states"), { target: { value: ".position[1]" } });
    await waitFor(() => expect(screen.getByText("0.6")).toBeVisible());
    expect(screen.getByText("jq 已启用")).toBeVisible();
    expect(JSON.parse(localStorage.getItem("robot-console-jq-filters")!)).toEqual({ "/joint_states": ".position[1]" });
  });
});
