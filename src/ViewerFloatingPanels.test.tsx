import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { MotionLayoutProvider } from "./MotionLayout";
import { ViewerHeadsUp } from "./ViewerHeadsUp";
import { VIEWER_FLOATING_KEY } from "./viewerFloatingLogic";

let measure: () => void;
let bounds = {width:1000,height:600};
const saved = () => JSON.parse(localStorage.getItem(VIEWER_FLOATING_KEY)!);
function View({active=true,resetVersion=0}) {
  return <MotionLayoutProvider active={active} resetVersion={resetVersion}><ViewerHeadsUp error="resource error" leading={<span>motion state</span>}
    rgbd={<label>RGBD<input aria-label="点大小" defaultValue="0.01"/></label>}><label>TCP<input aria-label="TCP X" defaultValue="100"/></label></ViewerHeadsUp></MotionLayoutProvider>;
}
beforeEach(()=>{
  localStorage.clear(); bounds={width:1000,height:600};
  vi.stubGlobal("PointerEvent",MouseEvent);
  vi.stubGlobal("ResizeObserver",class { constructor(callback:()=>void){measure=callback;} observe(){} disconnect(){} });
  vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockImplementation(()=>({...bounds} as DOMRect));
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe("Robot View floating windows",()=>{
  it("keeps the three panels separate and preserves input state through folding and reset",()=>{
    const {rerender}=render(<View/>);
    expect(screen.getByLabelText("运动状态面板")).toHaveTextContent("resource error");
    expect(screen.getByLabelText("RGBD 面板")).toHaveTextContent("RGBD");
    expect(screen.getByLabelText("Robot View 操作面板")).toHaveTextContent("TCP");
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("TCP X"),{target:{value:"222"}});
    fireEvent.click(screen.getByRole("button",{name:"折叠TCP / 关节操作浮窗"}));
    expect(screen.getByLabelText("TCP X")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button",{name:/^TCP \/ 关节操作$/}));
    expect(screen.getByLabelText("TCP X")).toBeVisible();
    expect(screen.getByLabelText("TCP X")).toHaveValue("222");
    fireEvent.keyDown(screen.getByRole("button",{name:"移动运动控制浮窗"}),{key:"ArrowRight",shiftKey:true});
    expect(saved().status.x).toBe(40);
    rerender(<View resetVersion={1}/>);expect(saved()).toEqual({});
    expect(screen.getByLabelText("TCP X")).toHaveValue("222");
  });
  it("drags, raises, resizes and clamps, cancelling listeners on hide and unmount",()=>{
    const {rerender,unmount}=render(<View/>);
    const drag=screen.getByRole("button",{name:"移动运动控制浮窗"});
    fireEvent.pointerDown(drag,{button:0,clientX:10,clientY:10});
    fireEvent.pointerMove(window,{clientX:110,clientY:80});
    expect(saved().status.x).toBe(100);expect(saved().status.y).toBe(70);
    fireEvent.pointerUp(window);
    fireEvent.pointerMove(window,{clientX:220,clientY:100});expect(saved().status.x).toBe(100);
    const resize=screen.getByRole("button",{name:"调整运动控制浮窗大小"});
    fireEvent.pointerDown(resize,{button:0,clientX:0,clientY:0});
    fireEvent.pointerMove(window,{clientX:100,clientY:60});expect(saved().status.width).toBe(360);expect(saved().status.height).toBe(210);
    fireEvent.pointerCancel(window);
    fireEvent.keyDown(resize,{key:"ArrowDown"});expect(saved().status.height).toBe(220);
    fireEvent.pointerDown(drag,{button:0,clientX:0,clientY:0});
    rerender(<View active={false}/>);
    const before=saved();fireEvent.pointerMove(window,{clientX:700,clientY:700});expect(saved()).toEqual(before);
    rerender(<View/>);fireEvent.pointerDown(drag,{button:0,clientX:0,clientY:0});
    unmount();fireEvent.pointerMove(window,{clientX:900,clientY:900});expect(saved()).toEqual(before);
  });
  it("constrains restored preferences when shrinking without overwriting them, and expands inside bounds",()=>{
    localStorage.setItem(VIEWER_FLOATING_KEY,JSON.stringify({controls:{x:600,y:200,width:320,height:350,collapsed:true}}));
    render(<View/>);
    act(()=>{bounds={width:440,height:220};measure();});
    const window=screen.getByLabelText("Robot View 操作面板");
    expect(parseFloat(window.style.left)+parseFloat(window.style.width)).toBeLessThanOrEqual(440);
    expect(saved().controls.x).toBe(600);
    fireEvent.click(screen.getByRole("button",{name:"展开TCP / 关节操作浮窗"}));
    expect(parseFloat(window.style.top)+parseFloat(window.style.height)).toBeLessThanOrEqual(220);
    fireEvent.click(screen.getByRole("button",{name:"重置浮窗"}));expect(saved()).toEqual({});
  });
  it("survives blocked writes and prevents panel pointer events reaching the scene host",()=>{
    const spy=vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw Error('denied');});
    const scene=vi.fn();render(<div onPointerDown={scene}><View/></div>);
    fireEvent.pointerDown(screen.getByLabelText("TCP X"),{button:0});expect(scene).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button",{name:"折叠TCP / 关节操作浮窗"}));
    expect(screen.getByLabelText("TCP X")).not.toBeVisible();spy.mockRestore();
  });
});
