import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EvidenceError, IndexEntry, IndexState, RecordKind } from './contracts';
import { atomicJson, exists, jsonLines, safeFile } from './files';

export class EvidenceIndex {
  private constructor(public readonly runDir: string, public readonly state: IndexState) {}
  get directory(): string { return path.join(this.runDir, 'index', this.state.generation); }
  static async create(runDir: string): Promise<EvidenceIndex> {
    const index = new EvidenceIndex(runDir, { schemaVersion: 1, generation: randomUUID(), counts: { events: 0, artifacts: 0, checkpoints: 0, raw: 0 }, lastSequence: 0, gaps: 0, updatedAt: new Date().toISOString() });
    await fs.mkdir(path.join(index.directory, 'artifacts'), { recursive: true });
    for (const kind of ['events', 'artifacts', 'checkpoints', 'raw'] as const) await fs.writeFile(path.join(index.directory, `${kind}.jsonl`), '');
    return index;
  }
  static async load(runDir: string): Promise<EvidenceIndex> {
    const state = JSON.parse(await fs.readFile(path.join(runDir, 'index', 'state.json'), 'utf8')) as IndexState;
    if (!/^[a-f0-9-]{36}$/.test(state.generation)) throw new Error('Invalid evidence index generation.');
    return new EvidenceIndex(runDir, state);
  }
  async append(entry: IndexEntry): Promise<void> {
    await fs.appendFile(path.join(this.directory, `${entry.kind}.jsonl`), `${JSON.stringify(entry)}\n`);
    if (entry.kind === 'artifacts') await fs.writeFile(path.join(this.directory, 'artifacts', `${entry.id}.json`), JSON.stringify(entry));
    this.state.counts[entry.kind]++;
    this.state.lastSequence = Math.max(this.state.lastSequence, entry.sequence);
    if (entry.type === 'gap' || entry.type?.endsWith('.gap')) this.state.gaps++;
  }
  async publish(): Promise<void> { this.state.updatedAt = new Date().toISOString(); await atomicJson(path.join(this.runDir, 'index', 'state.json'), this.state); }
}

export interface CorruptRecord { file: string; offset: number; bytes: number; reason: string; }
export async function evidenceSources(runDir: string): Promise<{ file: string; kind: RecordKind }[]> {
  const sources: { file: string; kind: RecordKind }[] = [];
  for (const [directory, kind] of [['journal', 'events'], ['raw/cdp', 'raw'], ['raw/rrweb', 'raw']] as const) {
    if (await exists(path.join(runDir, directory))) {
      if ((await fs.lstat(path.join(runDir, directory))).isSymbolicLink()) throw new EvidenceError('INVALID_PATH', 'Symbolic links are not accepted in evidence directories.');
      const names = (await fs.readdir(path.join(runDir, directory))).filter((name) => /^\w+-\d{6}\.jsonl$/.test(name)).sort();
      sources.push(...names.map((name) => ({ file: `${directory}/${name}`, kind })));
    }
  }
  for (const kind of ['artifacts', 'checkpoints'] as const) if (await exists(path.join(runDir, `${kind}.jsonl`))) sources.push({ file: `${kind}.jsonl`, kind });
  return sources;
}
export async function rebuildIndex(runDir: string): Promise<{ index: EvidenceIndex; corrupt: CorruptRecord[] }> {
  const index = await EvidenceIndex.create(runDir), corrupt: CorruptRecord[] = [];
  for (const source of await evidenceSources(runDir)) {
    for await (const line of jsonLines(await safeFile(runDir, source.file))) {
      const record = line.value;
      if (line.invalid || !record || typeof record.id !== 'string' || !/^[a-z]+-\d{12}$/.test(record.id) || !Number.isSafeInteger(record.sequence) || Number(record.sequence) < 1) {
        corrupt.push({ file: source.file, offset: line.offset, bytes: line.bytes, reason: line.invalid ?? 'Invalid record identity.' });
        continue;
      }
      await index.append({ id: record.id, sequence: Number(record.sequence), kind: source.kind, file: source.file, offset: line.offset, bytes: line.bytes,
        type: typeof record.type === 'string' ? record.type : undefined,
        timestamp: String(record.receivedAt ?? record.createdAt ?? record.savedAt ?? ''),
        captureStatus: record.captureStatus as IndexEntry['captureStatus'], key: typeof record.key === 'string' ? record.key : undefined });
    }
  }
  await index.publish();
  return { index, corrupt };
}

export * from './contracts';
