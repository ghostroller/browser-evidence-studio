import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fingerprintWorkflow, type WorkflowFingerprint } from './fingerprint';

export interface ExecutionSnapshot {
  directory: string;
  files: { path: string; sha256: string; bytes: number }[];
  contentHash: string;
  sourceFingerprint: string;
}
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

/** Copy the registered project, including its local dependencies. No links back to live code.
 * Dependencies installed only in an ancestor directory must be installed in the business project.
 * Retain the snapshot for inspection; its lifetime is owned by the execution archive. */
export async function prepareExecutionSnapshot(root: string, expected: WorkflowFingerprint, destination?: string, signal?: AbortSignal): Promise<ExecutionSnapshot> {
  signal?.throwIfAborted();
  root = await realpath(root);
  const parent = destination ? await realpath(destination) : await realpath(tmpdir());
  const relative = path.relative(root, parent);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Execution snapshot destination must be outside the registered source directory');
  const directory = await mkdtemp(path.join(parent, 'bes-code-'));
  const files: ExecutionSnapshot['files'] = [];
  let totalBytes = 0;
  let directoryCount = 0;
  async function copy(source: string, target: string): Promise<void> {
    for (const entry of (await readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted();
      if (entry.name === '.git' || entry.name === '.bin') continue;
      if (entry.isSymbolicLink()) throw new Error(`Execution snapshot rejects symbolic links: ${entry.name}`);
      const sourceFile = path.join(source, entry.name), targetFile = path.join(target, entry.name);
      if (entry.isDirectory()) { if (++directoryCount > 20_000) throw new Error('Execution snapshot exceeds 20,000 directories'); await mkdir(targetFile); await copy(sourceFile, targetFile); continue; }
      if (!entry.isFile()) throw new Error(`Execution snapshot requires regular files: ${entry.name}`);
      if ((await stat(sourceFile)).size + totalBytes > 256 * 1024 * 1024) throw new Error('Execution snapshot exceeds 256 MiB');
      const data = await readFile(sourceFile, { signal });
      totalBytes += data.length;
      if (files.length >= 20_000 || totalBytes > 256 * 1024 * 1024) throw new Error('Execution snapshot exceeds 20,000 files / 256 MiB; package a focused business project');
      const file = { path: path.relative(root, sourceFile).split(path.sep).join('/'), sha256: hash(data), bytes: data.length };
      const previous = expected.files.find(item => item.path === file.path);
      if (previous && (previous.sha256 !== file.sha256 || previous.bytes !== file.bytes)) throw new Error(`Workflow changed before snapshot: ${file.path}`);
      await writeFile(targetFile, data, { flag: 'wx', mode: 0o444 });
      files.push(file);
    }
  }
  await copy(root, directory);
  if (expected.files.some(previous => !files.some(file => file.path === previous.path && file.sha256 === previous.sha256))) throw new Error('Workflow files disappeared while creating the execution snapshot');
  if (JSON.stringify((await fingerprintWorkflow(root)).files) !== JSON.stringify(expected.files)) throw new Error('Workflow source file set changed while creating the execution snapshot');
  signal?.throwIfAborted();
  return { directory, files, contentHash: hash(JSON.stringify(files)), sourceFingerprint: expected.sha256 };
}
