import { describe, expect, it } from "vitest";
import { boundViewerPanel, defaultViewerPanel, loadViewerFloating, panelIds } from "./viewerFloatingLogic";

describe("Robot View floating bounds", () => {
  it("keeps wide, narrow and tiny frames and folded headers inside the canvas", () => {
    for (const bounds of [{width:1200,height:700},{width:440,height:300},{width:120,height:50}]) {
      for (const id of panelIds) {
        for (const collapsed of [false,true]) {
          const result = boundViewerPanel({...defaultViewerPanel(id,bounds),x:5000,y:5000,width:900,height:800,collapsed},bounds);
          expect(result.x).toBeGreaterThanOrEqual(0);
          expect(result.y).toBeGreaterThanOrEqual(0);
          expect(result.x+result.width).toBeLessThanOrEqual(bounds.width);
          expect(result.y+(collapsed?Math.min(34,bounds.height):result.height)).toBeLessThanOrEqual(bounds.height);
        }
      }
    }
  });
  it("restores only valid panel preferences and tolerates unavailable storage", () => {
    const panel={x:12,y:20,width:260,height:200,collapsed:true};
    expect(loadViewerFloating({getItem:()=>JSON.stringify({status:panel,rgbd:{...panel,width:-1},controls:{...panel,x:'20'}})})).toEqual({status:panel});
    expect(loadViewerFloating({getItem:()=>'{broken'})).toEqual({});
    expect(loadViewerFloating({getItem:()=>{throw Error('denied');}})).toEqual({});
  });
});
