export class StudioError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function ensure(condition: unknown, message: string, status = 422): asserts condition {
  if (!condition) throw new StudioError(status, status === 409 ? 'conflict' : 'invalid_request', message);
}
export const now = () => new Date().toISOString();
