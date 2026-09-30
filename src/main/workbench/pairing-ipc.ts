import type { IpcMainInvokeEvent } from 'electron';
import type { StudioWindow } from '../window';
import { isTrustedUiSender } from '../ui-ipc';
import { WorkbenchError } from './errors';
import { WorkbenchPairing } from './pairing';

/** The dedicated pairing channel never routes through Agent/UI dispatch. */
export function createPairingHandlers(window: Pick<StudioWindow, 'window' | 'uiUrl'>,
  pairing: WorkbenchPairing | undefined, closing: () => boolean) {
  const trusted = (event: IpcMainInvokeEvent) => {
    if (closing() || !isTrustedUiSender(event, window)) throw new WorkbenchError('forbidden');
  };
  const issuing = (event: IpcMainInvokeEvent) => {
    trusted(event);
    if (window.window.isMinimized() || !window.window.isVisible()) throw new WorkbenchError('forbidden');
  };
  return {
    status(event: IpcMainInvokeEvent) { trusted(event); return pairing?.status() ?? { enabled: false }; },
    begin(event: IpcMainInvokeEvent, input: unknown) {
      issuing(event); if (!pairing) throw new WorkbenchError('unavailable');
      return pairing.begin(input, () => issuing(event));
    },
    revoke(event: IpcMainInvokeEvent) { trusted(event); pairing?.revoke(); },
  };
}
