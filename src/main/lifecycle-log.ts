import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from '@/evidence/files';

/** Local process diagnostics, separate from immutable run evidence. No URLs, input or tokens. */
export class LifecycleLog {
  readonly instanceId = randomUUID();
  readonly startedAt = new Date().toISOString();
  private tail: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private constructor(readonly directory: string) {}

  static async start(root: string): Promise<LifecycleLog> {
    const log = new LifecycleLog(path.join(root, 'diagnostics'));
    await mkdir(log.directory, { recursive: true });
    await log.record('process-started');
    return log;
  }

  record(stage: string, details: Record<string, unknown> = {}): Promise<void> {
    const at = new Date().toISOString();
    const task = this.tail.catch(() => {}).then(async () => {
      const record = { schemaVersion: 1, instanceId: this.instanceId, processId: process.pid,
        startedAt: this.startedAt, sequence: ++this.sequence, at, stage, details };
      const line = JSON.stringify(record) + '\n';
      if (Buffer.byteLength(line) > 8192) throw new Error('Lifecycle diagnostic exceeds 8 KiB');
      const file = `lifecycle-${this.instanceId}.jsonl`;
      const handle = await open(path.join(this.directory, file), 'a');
      try { await handle.writeFile(line); await handle.sync(); } finally { await handle.close(); }
      await atomicJson(path.join(this.directory, 'latest.json'), { ...record, file });
    });
    this.tail = task;
    return task;
  }
}
