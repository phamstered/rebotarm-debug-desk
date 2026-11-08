import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UrdfPanelDivider } from './UrdfPanelDivider';

function pointer(target: HTMLElement | Window, type: string, clientX: number, pointerId = 1, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, clientX, button });
  Object.defineProperty(event, 'pointerId', { value: pointerId }); fireEvent(target, event);
}
function fixture(side: 'tree' | 'properties', width = side === 'tree' ? 230 : 320, hostWidth = 1000, drawer = false) {
  const change = vi.fn();
  const component = (active: boolean) => <div className="urdf-inspector-body">
    <aside className={`urdf-${side}`} style={{position: drawer ? 'absolute' : 'relative'}}>
      <UrdfPanelDivider side={side} value={width} active={active} onChange={change}/>
    </aside><aside className={side === 'tree' ? 'urdf-properties' : 'urdf-tree'}/>
  </div>;
  const view = render(component(true));
  const handle = screen.getByRole('separator'), panel = handle.parentElement!, host = panel.parentElement!, other = panel.nextElementSibling!;
  vi.spyOn(panel,'getBoundingClientRect').mockReturnValue({ width } as DOMRect);
  vi.spyOn(host,'getBoundingClientRect').mockReturnValue({ width:hostWidth } as DOMRect);
  vi.spyOn(other,'getBoundingClientRect').mockReturnValue({ width:300 } as DOMRect);
  return { ...view, handle, panel, change, deactivate: () => view.rerender(component(false)) };
}
afterEach(() => vi.restoreAllMocks());
describe('URDF layout dividers', () => {
  it.each([['tree',230,280],['properties',320,270]] as const)('drags the %s edge in the correct direction and stops on release', (side,width,expected) => {
    const {handle,change,unmount} = fixture(side,width);
    pointer(handle,'pointerdown',100); pointer(window,'pointermove',150);
    expect(change).toHaveBeenLastCalledWith(expected);
    expect(document.body.style.cursor).toBe('col-resize');
    pointer(window,'pointermove',180,2); expect(change).toHaveBeenCalledTimes(1);
    pointer(window,'pointerup',180,2); expect(document.body.style.cursor).toBe('col-resize');
    pointer(window,'pointerup',150); pointer(window,'pointermove',200);
    expect(change).toHaveBeenCalledTimes(1); expect(document.body.style.cursor).toBe('');
    unmount();
  });
  it('starts from measured width and reserves 200px for the centre', () => {
    const {handle,panel,change} = fixture('tree',300,750);
    vi.mocked(panel.getBoundingClientRect).mockReturnValue({width:210} as DOMRect);
    pointer(handle,'pointerdown',100); pointer(window,'pointermove',120);
    expect(change).toHaveBeenLastCalledWith(230);
    pointer(window,'pointermove',500); expect(change).toHaveBeenLastCalledWith(250);
  });
  it('resizes a drawer up to 85% of its container without reserving the other panel', () => {
    const {handle,change} = fixture('properties',320,400,true);
    pointer(handle,'pointerdown',300); pointer(window,'pointermove',0);
    expect(change).toHaveBeenLastCalledWith(340);
  });
  it('supports keyboard direction, bounds and double-click reset', () => {
    const {handle,change} = fixture('properties');
    fireEvent.keyDown(handle,{key:'ArrowLeft',shiftKey:true}); expect(change).toHaveBeenLastCalledWith(360);
    fireEvent.keyDown(handle,{key:'ArrowRight'}); expect(change).toHaveBeenLastCalledWith(310);
    fireEvent.keyDown(handle,{key:'Home'}); expect(change).toHaveBeenLastCalledWith(260);
    fireEvent.keyDown(handle,{key:'End'}); expect(change).toHaveBeenLastCalledWith(460);
    fireEvent.doubleClick(handle); expect(change).toHaveBeenLastCalledWith(320);
  });
  it.each(['deactivate','unmount','cancel','blur'] as const)('cleans up a drag on %s', action => {
    document.body.style.cursor = 'crosshair'; document.body.style.userSelect = 'text';
    const view = fixture('tree'); pointer(view.handle,'pointerdown',0);
    if (action === 'deactivate') view.deactivate();
    else if (action === 'unmount') view.unmount();
    else if (action === 'cancel') pointer(window,'pointercancel',0);
    else fireEvent(window,new Event('blur'));
    pointer(window,'pointermove',200); expect(view.change).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe('crosshair'); expect(document.body.style.userSelect).toBe('text');
    document.body.style.cursor = ''; document.body.style.userSelect = '';
  });
});
