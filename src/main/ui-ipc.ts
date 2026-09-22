import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import type { StudioWindow } from './window';

/** Frame accessors can throw after reload/teardown, even for already queued IPC. */
export function isTrustedUiSender(event: Pick<IpcMainEvent | IpcMainInvokeEvent, 'sender' | 'senderFrame'>, window: Pick<StudioWindow, 'window' | 'uiUrl'>): boolean {
  try {
    if (window.window.isDestroyed() || event.sender.isDestroyed()) return false;
    const trusted = window.window.webContents;
    if (trusted.isDestroyed() || event.sender !== trusted) return false;
    const frame = event.senderFrame;
    return !!frame && frame === trusted.mainFrame && frame.url === window.uiUrl;
  } catch {
    // A destroyed WebFrameMain is no longer an authorized UI sender.
    return false;
  }
}
