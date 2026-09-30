import { WorkbenchError } from './errors';

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new WorkbenchError('invalid_request');
  }
  return value as Record<string, unknown>;
}
export function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new WorkbenchError('invalid_request');
  }
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new WorkbenchError('invalid_request');
  return value;
}
export function textField(value: unknown, max: number, nonempty = false): string {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new WorkbenchError('invalid_request');
  }
  return value;
}
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new WorkbenchError('invalid_request');
  return value as number;
}
/** Iterative depth/node budget also protects direct (non-HTTP) fixture dispatch. */
export function checkJsonBudget(value: unknown, maxDepth = 6, maxNodes = 64): void {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > maxNodes || item.depth > maxDepth) throw new WorkbenchError('invalid_request');
    if (item.value && typeof item.value === 'object') {
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
    } else if (!['string', 'number', 'boolean'].includes(typeof item.value) && item.value !== null) {
      throw new WorkbenchError('invalid_request');
    }
  }
}
