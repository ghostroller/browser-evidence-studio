import type { BrowserWorkbenchPairingBridge } from '@/contracts/browser-workbench';
import { workbenchHost } from '@/contracts/host-capabilities';
import type { NativeBounds, WorkbenchCall, WorkbenchClient, WorkbenchInput, WorkbenchMethod, WorkbenchResult } from '@/contracts/workbench';

/** The only renderer boundary allowed to read the isolated Electron preload. */
export interface ElectronWorkbenchBridge {
  call(method: WorkbenchMethod, body?: unknown): Promise<unknown>;
  onChanged(listener: () => void): () => void;
  bounds(rect: NativeBounds): void;
}
declare global { interface Window { studio?: ElectronWorkbenchBridge; workbenchPairing?: BrowserWorkbenchPairingBridge } }

export class WorkbenchStartupError extends Error {
  constructor() { super('工作台连接不可用：未发现完整的 Electron preload bridge。请从 Electron 启动应用；浏览器配对请使用明确的 browser.html 入口。'); this.name = 'WorkbenchStartupError'; }
}
export function createElectronWorkbenchClient(bridge: ElectronWorkbenchBridge | undefined): WorkbenchClient {
  if (!bridge || typeof bridge.call !== 'function' || typeof bridge.onChanged !== 'function' || typeof bridge.bounds !== 'function') throw new WorkbenchStartupError();
  // Do not await, clone, retry or schedule here: preserve body identity, promise
  // rejection, call order, changed-listener lifetime and fire-and-forget bounds.
  const call = <M extends WorkbenchMethod>(method: M, body?: WorkbenchInput<M>) => bridge.call(method, body === undefined ? {} : body) as Promise<WorkbenchResult<M>>;
  return {
    host: workbenchHost('electron'),
    call: call as WorkbenchCall,
    onChanged: listener => bridge.onChanged(listener),
    nativePresentation: { bounds: rect => bridge.bounds(rect), set: body => call('presentation', body) },
  };
}
export function electronWorkbenchClient(): WorkbenchClient {
  return createElectronWorkbenchClient(window.studio);
}

/** Optional synthetic-only bridge; never routed through the generic Studio API. */
export function electronWorkbenchPairing(): BrowserWorkbenchPairingBridge | undefined {
  const bridge = window.workbenchPairing;
  return bridge && typeof bridge.status === 'function' && typeof bridge.begin === 'function' && typeof bridge.revoke === 'function' ? bridge : undefined;
}
