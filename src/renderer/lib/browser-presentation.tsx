import React, { createContext, useCallback, useContext, useLayoutEffect, useRef } from 'react';

const LayoutContext = createContext<{ start(): void; finish(): void } | null>(null);

export function BrowserPresentation({ browserBox, revision, overlay, children, onError }: {
  browserBox: React.RefObject<HTMLDivElement | null>; revision: number; overlay: string | null;
  children: React.ReactNode; onError(message: string): void;
}) {
  const dragFrame = useRef(0);
  const resizeFrame = useRef(0);
  const releaseFrame = useRef(0);
  const generation = useRef(0);
  const dragging = useRef(false);
  const onErrorRef = useRef(onError); onErrorRef.current = onError;
  const report = useCallback(() => {
    const rect = browserBox.current?.getBoundingClientRect();
    if (rect) window.studio.bounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  }, [browserBox]);
  const presentation = useCallback((reason: 'overlay' | 'layout', hidden: boolean) => {
    void window.studio.call('presentation', { reason, hidden }).catch(failure => onErrorRef.current(String(failure)));
  }, []);
  const finish = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    cancelAnimationFrame(dragFrame.current);
    const current = ++generation.current;
    releaseFrame.current = requestAnimationFrame(() => {
      if (generation.current !== current || dragging.current) return;
      report(); presentation('layout', false);
    });
  }, [report, presentation]);
  const start = useCallback(() => {
    if (dragging.current) return;
    ++generation.current; cancelAnimationFrame(releaseFrame.current);
    dragging.current = true; presentation('layout', true);
    const tick = () => { report(); if (dragging.current) dragFrame.current = requestAnimationFrame(tick); };
    dragFrame.current = requestAnimationFrame(tick);
  }, [report, presentation]);
  useLayoutEffect(() => {
    const resize = () => { cancelAnimationFrame(resizeFrame.current); resizeFrame.current = requestAnimationFrame(report); };
    const observer = new ResizeObserver(resize);
    if (browserBox.current) observer.observe(browserBox.current);
    window.addEventListener('resize', resize);
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
    window.addEventListener('blur', finish);
    report();
    return () => {
      observer.disconnect(); cancelAnimationFrame(dragFrame.current); cancelAnimationFrame(resizeFrame.current); cancelAnimationFrame(releaseFrame.current);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', finish, true);
      window.removeEventListener('blur', finish);
      ++generation.current; dragging.current = false; presentation('layout', false);
    };
  }, [browserBox, revision, finish, report]);
  useLayoutEffect(() => { report(); presentation('overlay', !!overlay); }, [overlay, report, presentation]);
  return <LayoutContext.Provider value={{ start, finish }}>{children}</LayoutContext.Provider>;
}

export function useBrowserLayout() { return useContext(LayoutContext); }
