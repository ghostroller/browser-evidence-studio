import React, { useRef } from 'react';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './ui/resizable';
import { usePreferences } from './theme-provider';
import { useBrowserLayout } from '../lib/browser-presentation';

export function SplitPane({ name, first, second, initial, minFirst, minSecond, label, orientation = 'horizontal' }: {
  name: string; first: React.ReactNode; second: React.ReactNode; initial: number;
  minFirst: string; minSecond: string; label: string; orientation?: 'horizontal' | 'vertical';
}) {
  const { preferences, saveLayout } = usePreferences();
  const presentation = useBrowserLayout();
  const defaults = useRef(preferences.layout[name]?.length === 2 ? preferences.layout[name] : [initial, 100 - initial]);
  const left = `${name}-first`, right = `${name}-second`;
  return <ResizablePanelGroup className="split-body" id={name} orientation={orientation}
    defaultLayout={{ [left]: defaults.current[0], [right]: defaults.current[1] }}
    resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
    onLayoutChanged={(layout, meta) => {
      if (meta.isUserInteraction) saveLayout(name, [layout[left], layout[right]]);
      // The final browser measurement must precede restoring the native view.
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    }}>
    <ResizablePanel id={left} minSize={minFirst}>{first}</ResizablePanel>
    <ResizableHandle className="split-handle" aria-label={label}
      onPointerDownCapture={event => { if (event.button === 0) presentation?.start(); }} onPointerUpCapture={() => presentation?.finish()}
      onPointerCancel={() => presentation?.finish()} />
    <ResizablePanel id={right} minSize={minSecond}>{second}</ResizablePanel>
  </ResizablePanelGroup>;
}
