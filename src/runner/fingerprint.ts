import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseWorkflowManifest, type WorkflowManifest } from '@/contracts/workflow';

export interface WorkflowFingerprint {
  sha256: string;
  files: { path: string; sha256: string; bytes: number }[];
  dependencyLockSha256: string | null;
}

const excluded = new Set(['node_modules', '.git']);
const sourceExtensions = new Set(['.js', '.cjs', '.mjs', '.ts', '.mts', '.cts', '.json', '.yaml', '.yml']);
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** Resolve symlinks and reject every entry outside the registered script root. */
export async function resolveRegisteredFile(registeredRoot: string, requestedPath: string): Promise<string> {
  const root = await realpath(registeredRoot);
  const file = await realpath(path.resolve(root, requestedPath));
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Workflow file is outside its registered directory');
  if (!(await stat(file)).isFile()) throw new Error('Workflow entry must be a regular file');
  return file;
}

export async function loadWorkflow(registeredRoot: string, manifestPath = 'workflow.json'): Promise<{ manifest: WorkflowManifest; entryPath: string; manifestPath: string }> {
  const file = await resolveRegisteredFile(registeredRoot, manifestPath);
  const manifest = parseWorkflowManifest(JSON.parse(await readFile(file, 'utf8')));
  const entryPath = await resolveRegisteredFile(registeredRoot, path.resolve(path.dirname(file), manifest.entry));
  if (!['.js', '.cjs', '.mjs'].includes(path.extname(entryPath))) throw new Error('Workflow entry must be built JavaScript (.js, .cjs or .mjs)');
  return { manifest, entryPath, manifestPath: file };
}

/** Snapshot all source/build/config files; no user-selected list can omit changed code. */
export async function fingerprintWorkflow(registeredRoot: string, dependencyLockPath?: string): Promise<WorkflowFingerprint> {
  const root = await realpath(registeredRoot);
  const files: WorkflowFingerprint['files'] = [];
  let totalBytes = 0;
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded.has(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Workflow fingerprint rejects symbolic links: ${entry.name}`);
      if (entry.isDirectory()) { await walk(filename); continue; }
      if (!entry.isFile() || (!sourceExtensions.has(path.extname(entry.name)) && entry.name !== '.node-version' && entry.name !== '.npmrc')) continue;
      const info = await stat(filename);
      totalBytes += info.size;
      if (files.length >= 2_000 || totalBytes > 64 * 1024 * 1024) throw new Error('Workflow fingerprint exceeds the 2,000-file / 64 MiB budget');
      const data = await readFile(filename);
      files.push({ path: path.relative(root, filename).split(path.sep).join('/'), sha256: hash(data), bytes: data.length });
    }
  }
  await walk(root);
  let dependencyLockSha256: string | null = null;
  if (dependencyLockPath) dependencyLockSha256 = hash(await readFile(dependencyLockPath));
  else {
    const lock = files.find(file => file.path === 'package-lock.json');
    dependencyLockSha256 = lock?.sha256 ?? null;
  }
  return { sha256: hash(JSON.stringify({ files, dependencyLockSha256 })), files, dependencyLockSha256 };
}

export function fingerprintInput(input: unknown): string {
  return hash(JSON.stringify(input));
}
