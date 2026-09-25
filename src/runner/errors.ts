import type { OriginalError } from '../contracts/execution';

/** Keep the first failure and its cause chain, independently of cleanup failures. */
export function originalError(value: unknown, seen = new Set<unknown>()): OriginalError {
  if (seen.has(value)) return { name: 'CircularCause', message: 'Repeated error cause' };
  seen.add(value);
  if (value instanceof Error) return {
    name: value.name, message: value.message, ...(value.stack ? { stack: value.stack } : {}),
    ...(value.cause !== undefined && seen.size < 16 ? { cause: originalError(value.cause, seen) } : {}),
  };
  return { name: 'ThrownValue', message: typeof value === 'string' ? value : String(value) };
}

export function restoreError(value: OriginalError): Error {
  const error = new Error(value.message, value.cause ? { cause: restoreError(value.cause) } : undefined);
  error.name = value.name;
  if (value.stack) error.stack = value.stack;
  return error;
}
