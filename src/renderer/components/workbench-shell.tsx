import React from 'react';
/** Shared host-neutral application chrome. No native adapter or side effects. */
export function WorkbenchShell({ children, browser = false }: { children: React.ReactNode; browser?: boolean }) {
  return <div className={`app-shell${browser ? ' browser-workbench-shell' : ''}`}>{children}</div>;
}
export function WorkbenchHeader({ children }: { children: React.ReactNode }) {
  return <header className="topbar"><div className="brand"><strong>Browser Evidence Studio</strong></div><div className="topbar-spacer" />{children}</header>;
}
