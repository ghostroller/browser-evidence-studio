import type { BrowserWorkbenchErrorCode } from '../../contracts/browser-workbench';

const statuses: Record<BrowserWorkbenchErrorCode, number> = {
  unauthorized: 401, forbidden: 403, invalid_request: 400, not_found: 404,
  conflict: 409, busy: 429, cancelled: 409, unavailable: 503, internal_error: 500,
};
/** Only these codes cross the transport. Never serialize an exception message. */
export class WorkbenchError extends Error {
  readonly status: number;
  constructor(readonly code: BrowserWorkbenchErrorCode) {
    super(code);
    this.status = statuses[code];
  }
}
export function publicError(error: unknown): WorkbenchError {
  return error instanceof WorkbenchError ? error : new WorkbenchError('internal_error');
}
