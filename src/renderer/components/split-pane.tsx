import React, { useEffect, useRef } from 'react';
import type { GroupImperativeHandle } from 'react-resizable-panels';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './ui/resizable';
import { usePreferences } from './theme-provider';
import { useBrowserLayout } from '../lib/browser-presentation';

export function SplitPane({ name, first, second, initial, minFirst, minSecond, label, orientation = 'horizontal', focusFirst = false, focusLayout = 'archive' }: {
  name: string; first: React.ReactNode; second: React.ReactNode; initial: number;
  minFirst: string; minSecond: string; label: string; focusFirst?: boolean; focusLayout?: 'archive' | 'implementation'; orientation?: 'horizontal' | 'vertical';
}) {
  const { preferences, saveLayout } = usePreferences();
  const presentation = useBrowserLayout();
  const defaults = useRef(preferences.layout[name]?.length === 2 ? preferences.layout[name] : [initial, 100 - initial]);
  const group = useRef<GroupImperativeHandle | null>(null);
  const priorLayout = useRef<Record<string, number> | null>(null);
  const left = `${name}-first`, right = `${name}-second`;
  const focusedName = focusFirst ? `${name}-${focusLayout}` : '';
  const appliedFocus = useRef('');
  useEffect(() => {
    if (!group.current) return;
    if (focusedName && appliedFocus.current !== focusedName) {
      if (!priorLayout.current) priorLayout.current = group.current.getLayout();
      const focused = preferences.layout[focusedName];
      group.current.setLayout({ [left]: focused?.[0] ?? 66, [right]: focused?.[1] ?? 34 });
      appliedFocus.current = focusedName;
    } else if (!focusedName && priorLayout.current) { group.current.setLayout(priorLayout.current); priorLayout.current = null; appliedFocus.current = ''; }
  }, [focusedName, left, right]);
  return <ResizablePanelGroup groupRef={group} className="split-body" id={name} orientation={orientation}
    defaultLayout={{ [left]: defaults.current[0], [right]: defaults.current[1] }}
    resizeTargetMinimumSize={{ coarse: 20, fine: 8 }}
    onLayoutChanged={(layout, meta) => {
      if (meta.isUserInteraction) saveLayout(focusedName || name, [layout[left], layout[right]]);
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
