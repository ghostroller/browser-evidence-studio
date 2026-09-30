import React from 'react';
import { afterEach } from 'vitest';
import { render as testingRender, type RenderOptions } from '@testing-library/react';
import { WorkbenchClientProvider } from '@/renderer/lib/workbench-client';
import { createElectronWorkbenchClient, type ElectronWorkbenchBridge } from '@/renderer/lib/electron-workbench-client';
import type { WorkbenchClient } from '@/contracts/workbench';

export * from '@testing-library/react';
let client: WorkbenchClient | undefined;
/** Test-only transport fixtures are explicitly injected; no preload global. */
export function setTestWorkbenchClient(transport: Omit<ElectronWorkbenchBridge, 'onChanged'> & Partial<Pick<ElectronWorkbenchBridge, 'onChanged'>>) {
  client = createElectronWorkbenchClient({ ...transport, onChanged: transport.onChanged ?? (() => () => {}) });
  return client;
}
export function clearTestWorkbenchClient() { client = undefined; }
afterEach(clearTestWorkbenchClient);
export function render(ui: React.ReactNode, options?: RenderOptions) {
  const injected = client;
  if (!injected) throw new Error('Set the test WorkbenchClient before rendering');
  const Outer = options?.wrapper;
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <WorkbenchClientProvider client={injected!}>{Outer ? <Outer>{children}</Outer> : children}</WorkbenchClientProvider>;
  }
  return testingRender(ui, { ...options, wrapper: Wrapper });
}
