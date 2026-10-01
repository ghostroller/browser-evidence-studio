/** @vitest-environment jsdom */
import React, { useEffect } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
const f=vi.hoisted(()=>({save:vi.fn(),layout:{'workspace-first':30,'workspace-second':70},set:vi.fn(),changed:null as any}));
vi.mock('@/renderer/components/theme-provider',()=>({usePreferences:()=>({preferences:{layout:{}},saveLayout:f.save})}));
vi.mock('@/renderer/lib/browser-presentation',()=>({useBrowserLayout:()=>undefined}));
vi.mock('@/renderer/components/ui/resizable',()=>({ResizablePanelGroup:({children,groupRef,onLayoutChanged}:any)=>{groupRef.current={getLayout:()=>f.layout,setLayout:(layout:any)=>{f.set(layout);f.layout=layout;onLayoutChanged(layout,{isUserInteraction:false});}};f.changed=onLayoutChanged;return <div>{children}</div>;},ResizablePanel:({children}:any)=><div>{children}</div>,ResizableHandle:()=>null}));
import { SplitPane } from '@/renderer/components/split-pane';
afterEach(()=>{cleanup();vi.unstubAllGlobals();f.set.mockClear();f.save.mockClear();f.layout={'workspace-first':30,'workspace-second':70};});

test('archive focus expands once, preserves child identity and restores the previous layout without saving automatic ratios',()=>{
 vi.stubGlobal('requestAnimationFrame',()=>0);const mounted=vi.fn(),unmounted=vi.fn();
 function Child(){useEffect(()=>{mounted();return unmounted;},[]);return <input defaultValue="retained"/>;}
 const element=(focused:boolean)=><SplitPane name="workspace" label="resize" initial={30} minFirst="320px" minSecond="400px" focusFirst={focused} first={<Child/>} second={<p>browser</p>}/>;
 const view=render(element(false));view.rerender(element(true));expect(f.set).toHaveBeenLastCalledWith({'workspace-first':66,'workspace-second':34});expect(f.save).not.toHaveBeenCalled();expect(mounted).toHaveBeenCalledTimes(1);
 view.rerender(element(true));expect(f.set).toHaveBeenCalledTimes(1);
 f.changed({'workspace-first':60,'workspace-second':40},{isUserInteraction:true});expect(f.save).toHaveBeenCalledWith('workspace-archive',[60,40]);
 view.rerender(element(false));expect(f.set).toHaveBeenLastCalledWith({'workspace-first':30,'workspace-second':70});expect(unmounted).not.toHaveBeenCalled();expect(mounted).toHaveBeenCalledTimes(1);
});

test('archive and implementation layouts are independent and switching between them still restores the ordinary pane',()=>{
 vi.stubGlobal('requestAnimationFrame',()=>0);const mounted=vi.fn(),unmounted=vi.fn();
 function Child(){useEffect(()=>{mounted();return unmounted;},[]);return <input defaultValue="same editor"/>;}
 const element=(focused:boolean,focusLayout:'archive'|'implementation')=><SplitPane name="workspace" label="resize" initial={30} minFirst="320px" minSecond="400px" focusFirst={focused} focusLayout={focusLayout} first={<Child/>} second={<p>browser</p>}/>;
 const view=render(element(false,'archive'));view.rerender(element(true,'archive'));
 f.changed({'workspace-first':60,'workspace-second':40},{isUserInteraction:true});
 expect(f.save).toHaveBeenLastCalledWith('workspace-archive',[60,40]);
 view.rerender(element(true,'implementation'));expect(f.set).toHaveBeenCalledTimes(2);
 f.changed({'workspace-first':62,'workspace-second':38},{isUserInteraction:true});
 expect(f.save).toHaveBeenLastCalledWith('workspace-implementation',[62,38]);
 view.rerender(element(false,'implementation'));expect(f.set).toHaveBeenLastCalledWith({'workspace-first':30,'workspace-second':70});
 expect(mounted).toHaveBeenCalledTimes(1);expect(unmounted).not.toHaveBeenCalled();
});
