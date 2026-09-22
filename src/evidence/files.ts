import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EvidenceError } from './contracts';

export const hashBytes = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');
export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await atomicFile(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
}
export async function atomicFile(file: string, data: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx');
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temporary, file); } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}
/** Resolve only run-local regular files. Imported metadata must never escape the run through links. */
export async function safeFile(root: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some((part) => part === '..' || part === '' || part.includes(':'))) {
    throw new EvidenceError('INVALID_PATH', 'Evidence path must be a run-local relative path.');
  }
  const resolvedRoot = await fs.realpath(root);
  const candidate = path.resolve(root, relative);
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new EvidenceError('INVALID_PATH', 'Symbolic links are not accepted in evidence paths.');
  }
  const real = await fs.realpath(candidate);
  const diff = path.relative(resolvedRoot, real);
  if (!diff || diff.startsWith(`..${path.sep}`) || path.isAbsolute(diff) || diff === '..') throw new EvidenceError('INVALID_PATH', 'Evidence path escapes the run.');
  if (!(await fs.stat(real)).isFile()) throw new EvidenceError('INVALID_PATH', 'Evidence path is not a regular file.');
  return real;
}
export async function readSlice(root: string, relative: string, offset: number, bytes: number): Promise<Buffer> {
  const handle = await fs.open(await safeFile(root, relative), 'r');
  try { const buffer = Buffer.alloc(bytes); const { bytesRead } = await handle.read(buffer, 0, bytes, offset); return buffer.subarray(0, bytesRead); } finally { await handle.close(); }
}
export interface JsonLine { value?: Record<string, unknown>; offset: number; bytes: number; invalid?: string; }
/** Bounded streaming scan: a corrupt tail is reported, never silently discarded. */
export async function* jsonLines(file: string, start = 0): AsyncGenerator<JsonLine> {
  const handle = await fs.open(file, 'r');
  let pending = Buffer.alloc(0), position = start, lineStart = start;
  try {
    while (true) {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let newline: number;
      while ((newline = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, newline), bytes = newline + 1;
        try {
          const value: unknown = JSON.parse(line.toString('utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object record.');
          yield { value: value as Record<string, unknown>, offset: lineStart, bytes };
        } catch (error) { yield { offset: lineStart, bytes, invalid: String(error) }; }
        lineStart += bytes; pending = pending.subarray(bytes);
      }
      if (pending.length > 32 * 1024 * 1024) { yield { offset: lineStart, bytes: position - lineStart, invalid: 'Record exceeds the 32 MiB recovery scan limit.' }; return; }
    }
    if (pending.length) yield { offset: lineStart, bytes: pending.length, invalid: 'Unterminated JSONL record.' };
  } finally { await handle.close(); }
}
export async function exists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
