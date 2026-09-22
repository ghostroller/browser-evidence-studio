import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { EvidenceError } from './contracts';
import { atomicJson, hashBytes } from './files';

export interface ProcessIdentity { kind: 'windows-filetime' | 'linux-start-ticks'; value: string; startedAtMs?: number; }
export type ProcessObservation = { state: 'alive'; identity: ProcessIdentity } | { state: 'dead'; reason?: string } | { state: 'unknown'; reason: string };
export interface WriterOwner { schemaVersion?: 2; pid: number; instanceId: string; processStartedAt?: number; processIdentity?: ProcessIdentity; createdAt?: string; }
export type WriterLockState = 'unlocked' | 'live' | 'dead' | 'pid-reused' | 'unknown' | 'corrupt';
export interface WriterLockInspection {
  state: WriterLockState;
  reason: string;
  message: string;
  lockFingerprint: string | null;
  owner?: WriterOwner;
  observedProcess?: ProcessObservation;
  checkedAt: string;
  guard: 'not-probed';
}
export interface WriterLockRecovery { status: 'recovered'; inspection: WriterLockInspection; preservedLockPath: string; diagnosticPath: string; }
export interface WriterLockHandle { readonly owner: WriterOwner; readonly recovery?: WriterLockRecovery; release(): Promise<void>; }
export interface WriterLockOptions { queryProcess?: (pid: number) => Promise<ProcessObservation>; }
export class WriterLockError extends EvidenceError {
  constructor(code: string, message: string, public readonly inspection?: WriterLockInspection, statusCode = 409) { super(code, message, statusCode); }
}

const runFile = (runDir: string) => path.join(runDir, 'writer.lock');
const exec = promisify(execFile);
const validPid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2147483647;
const validIdentity = (value: any): value is ProcessIdentity => !!value && ['windows-filetime', 'linux-start-ticks'].includes(value.kind) && typeof value.value === 'string' && value.value.length > 0 && value.value.length < 256 && (value.startedAtMs === undefined || Number.isFinite(value.startedAtMs));

/** OS start identity is separate from pid existence; query failures never mean a dead owner. */
export async function queryProcessIdentity(pid: number): Promise<ProcessObservation> {
  if (!validPid(pid)) return { state: 'unknown', reason: 'invalid-process-id' };
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'; $observed=$null; try {
      $observed=[System.Diagnostics.Process]::GetProcessById(${pid}); $started=$observed.StartTime.ToUniversalTime();
      $result=@{state='alive';identity=@{kind='windows-filetime';value=$started.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture);startedAtMs=([DateTimeOffset]$started).ToUnixTimeMilliseconds()}}
    } catch { $cause=$_.Exception; while($cause.InnerException){$cause=$cause.InnerException};
      if($cause -is [System.ArgumentException]){$result=@{state='dead';reason='process-not-found'}}else{$result=@{state='unknown';reason='process-start-query-failed'}}
    } finally {if($observed){$observed.Dispose()}}; [Console]::Out.Write(($result|ConvertTo-Json -Compress -Depth 4))`;
    try {
      const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const { stdout } = await exec(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 5000, maxBuffer: 16384 });
      const result = JSON.parse(stdout.trim());
      if (result.state === 'alive' && validIdentity(result.identity)) return { state: 'alive', identity: result.identity };
      if (result.state === 'dead') return { state: 'dead', reason: 'process-not-found' };
      return { state: 'unknown', reason: 'process-start-query-failed' };
    } catch { return { state: 'unknown', reason: 'process-start-query-failed' }; }
  }
  if (process.platform === 'linux') {
    try {
      const [stat, boot] = await Promise.all([fs.readFile(`/proc/${pid}/stat`, 'utf8'), fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')]);
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/), startTicks = fields[19];
      if (!/^\d+$/.test(startTicks ?? '') || !/^[a-f0-9-]+$/i.test(boot.trim())) return { state: 'unknown', reason: 'invalid-process-start-data' };
      if (fields[0] === 'Z' || fields[0] === 'X') return { state: 'dead', reason: 'process-exited' };
      return { state: 'alive', identity: { kind: 'linux-start-ticks', value: `${boot.trim()}:${startTicks}` } };
    } catch {
      try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { state: 'dead', reason: 'process-not-found' }; }
      return { state: 'unknown', reason: 'process-start-query-failed' };
    }
  }
  return { state: 'unknown', reason: 'process-start-query-unsupported-platform' };
}

/** No socket/pipe probing: this is a snapshot; every mutation rechecks under the kernel guard. */
export async function inspectWriterLock(runDir: string, options: WriterLockOptions = {}): Promise<WriterLockInspection> {
  const base = { checkedAt: new Date().toISOString(), guard: 'not-probed' as const, lockFingerprint: null as string | null };
  const outcome = (state: WriterLockState, reason: string, message: string, extra: Partial<WriterLockInspection> = {}): WriterLockInspection => ({ ...base, state, reason, message, ...extra });
  let bytes: Buffer;
  try {
    const stat = await fs.lstat(runFile(runDir), { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) return outcome('corrupt', 'writer-lock-not-regular', 'The writer lock is not a regular local file; no automatic recovery is allowed.');
    if (stat.size > 16384n) return outcome('corrupt', 'writer-lock-too-large', 'The writer lock exceeds its 16 KiB inspection budget; the original has been left unchanged.', { lockFingerprint: hashBytes(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`) });
    const file = await fs.open(runFile(runDir), 'r');
    try {
      const opened = await file.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) return outcome('unknown', 'writer-lock-changed-during-read', 'The writer lock changed while it was being inspected.');
      const buffer = Buffer.alloc(16385);
      let total = 0;
      while (total < buffer.length) { const read = await file.read(buffer, total, buffer.length - total, total); if (!read.bytesRead) break; total += read.bytesRead; }
      const after = await file.stat({ bigint: true });
      if (total > 16384 || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) return outcome('unknown', 'writer-lock-changed-during-read', 'The writer lock changed while it was being inspected.');
      bytes = buffer.subarray(0, total);
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return outcome('unlocked', 'writer-lock-absent', 'No writer lock file was observed; opening still requires the exclusive kernel guard.');
    return outcome('unknown', 'writer-lock-read-failed', 'The writer lock could not be read; ownership remains unknown.');
  }
  base.lockFingerprint = hashBytes(bytes);
  let owner: WriterOwner;
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!parsed || !validPid(parsed.pid) || typeof parsed.instanceId !== 'string' || !/^[a-f0-9-]{36}$/i.test(parsed.instanceId)) throw new Error('Invalid owner');
    if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 2) throw new Error('Unsupported owner');
    if (parsed.schemaVersion === 2 ? !validIdentity(parsed.processIdentity) : !Number.isFinite(parsed.processStartedAt)) throw new Error('Invalid start identity');
    owner = { pid: parsed.pid, instanceId: parsed.instanceId, ...(parsed.schemaVersion === 2 ? { schemaVersion: 2 as const, processIdentity: parsed.processIdentity } : {}), ...(Number.isFinite(parsed.processStartedAt) ? { processStartedAt: parsed.processStartedAt } : {}), ...(typeof parsed.createdAt === 'string' ? { createdAt: parsed.createdAt } : {}) };
  } catch { return outcome('corrupt', 'writer-lock-invalid', 'The writer lock is damaged or has an unsupported owner identity; its bytes have been preserved in place.'); }
  let observedProcess: ProcessObservation;
  try { observedProcess = await (options.queryProcess ?? queryProcessIdentity)(owner.pid); }
  catch { observedProcess = { state: 'unknown', reason: 'process-start-query-failed' }; }
  const extra = { owner, observedProcess };
  if (observedProcess.state === 'dead') return outcome('dead', 'writer-process-exited', 'The recorded writer process no longer exists.', extra);
  if (observedProcess.state !== 'alive' || !validIdentity(observedProcess.identity)) return outcome('unknown', 'writer-process-query-unknown', 'The operating system could not verify the writer process identity; recovery is blocked.', extra);
  if (owner.processIdentity) {
    if (owner.processIdentity.kind !== observedProcess.identity.kind) return outcome('unknown', 'writer-process-identity-kind-mismatch', 'The recorded process identity cannot be compared on this platform.', extra);
    if (owner.processIdentity.value !== observedProcess.identity.value) return outcome('pid-reused', 'writer-pid-reused', 'The PID belongs to a different operating-system process start identity.', extra);
    return outcome('live', 'writer-process-matched', 'The recorded writer process is still alive.', extra);
  }
  // The repository's previous marker estimated birth from wall-clock minus uptime.
  // A mismatch is not proof of PID reuse (startup delay / wall-clock changes are possible).
  if (observedProcess.identity.startedAtMs !== undefined && Math.abs(observedProcess.identity.startedAtMs - owner.processStartedAt!) <= 5000) return outcome('live', 'legacy-writer-process-possibly-matched', 'A live process matches the previous approximate writer start time; recovery is blocked.', extra);
  return outcome('unknown', 'legacy-writer-start-not-exact', 'The previous lock has only an approximate start time and its PID is live; PID reuse cannot be proved safely.', extra);
}

interface KernelGuard { release(): Promise<void>; }
async function acquireGuard(runDir: string): Promise<KernelGuard> {
  const canonical = await fs.realpath(runDir), stat = await fs.stat(canonical, { bigint: true });
  if (!stat.isDirectory() || stat.ino === 0n) throw new WriterLockError('WRITER_GUARD_UNAVAILABLE', 'The run directory has no stable filesystem identity.');
  // Directory device/inode identity makes junction, case and pathname aliases share one guard.
  const key = createHash('sha256').update(`${process.platform}:${stat.dev}:${stat.ino}`).digest('hex');
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\bes-writer-${key}` : process.platform === 'linux' ? `\0bes-writer-${key}` : undefined;
  if (!address) throw new WriterLockError('WRITER_GUARD_UNSUPPORTED', 'This platform has no verified kernel writer guard.');
  const server = net.createServer(socket => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen({ path: address }, () => { server.removeListener('error', reject); resolve(); }); });
  } catch (error) {
    server.close();
    const code = (error as NodeJS.ErrnoException).code;
    throw new WriterLockError(code === 'EADDRINUSE' ? 'WRITER_BUSY' : 'WRITER_GUARD_UNAVAILABLE', code === 'EADDRINUSE' ? 'Another process holds the run writer guard.' : 'The operating system could not establish an exclusive writer guard.');
  }
  // Windows libuv 1.52.1 uv_pipe_bind uses FILE_FLAG_FIRST_PIPE_INSTANCE.
  // The pipe handle, or Linux abstract socket, is released by the kernel on process death.
  server.unref();
  let releasing: Promise<void> | undefined;
  return { release: () => releasing ??= new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

function requireRecoverable(inspection: WriterLockInspection): void {
  if (inspection.state === 'dead' || inspection.state === 'pid-reused') return;
  throw new WriterLockError(inspection.state === 'live' ? 'WRITER_BUSY' : inspection.state === 'corrupt' ? 'WRITER_LOCK_INVALID' : 'WRITER_OWNERSHIP_UNKNOWN', inspection.message, inspection);
}

async function preserveLock(runDir: string, inspection: WriterLockInspection, mode: 'automatic' | 'explicit'): Promise<WriterLockRecovery> {
  const recoveryRoot = path.join(runDir, 'recovery');
  await fs.mkdir(recoveryRoot, { recursive: true });
  if ((await fs.lstat(recoveryRoot)).isSymbolicLink()) throw new WriterLockError('WRITER_RECOVERY_PATH_INVALID', 'Recovery storage cannot be a symbolic link.', inspection);
  const relative = `recovery/writer-lock-${Date.now()}-${randomUUID()}`;
  await fs.mkdir(path.join(runDir, relative));
  const preservedLockPath = `${relative}/writer.lock`, diagnosticPath = `${relative}/diagnostic.json`;
  const diagnostic = { schemaVersion: 1, mode, inspection, preservedLockPath, recoveredAt: new Date().toISOString() };
  await atomicJson(path.join(runDir, diagnosticPath), { ...diagnostic, status: 'prepared' });
  // All writers/recoverers hold the same kernel guard; no read-unlink-wx race remains.
  if (hashBytes(await fs.readFile(runFile(runDir))) !== inspection.lockFingerprint) throw new WriterLockError('WRITER_LOCK_CHANGED', 'The writer lock changed after its ownership check.', inspection);
  await fs.rename(runFile(runDir), path.join(runDir, preservedLockPath));
  await atomicJson(path.join(runDir, diagnosticPath), { ...diagnostic, status: 'preserved' });
  return { status: 'recovered', inspection, preservedLockPath, diagnosticPath };
}

export async function recoverWriterLock(runDir: string, input: { expectedFingerprint: string }, options: WriterLockOptions = {}): Promise<WriterLockRecovery> {
  if (!/^[a-f0-9]{64}$/.test(input.expectedFingerprint)) throw new WriterLockError('INVALID_LOCK_FINGERPRINT', 'Recovery requires the exact fingerprint from a current lock inspection.', undefined, 422);
  runDir = await fs.realpath(runDir);
  const guard = await acquireGuard(runDir);
  try {
    const inspection = await inspectWriterLock(runDir, options);
    if (inspection.lockFingerprint !== input.expectedFingerprint) throw new WriterLockError('WRITER_LOCK_CHANGED', 'The writer lock changed; inspect it again before recovery.', inspection);
    requireRecoverable(inspection);
    return await preserveLock(runDir, inspection, 'explicit');
  } finally { await guard.release(); }
}

let ownIdentity: Promise<ProcessObservation> | undefined;
async function publishOwner(runDir: string, owner: WriterOwner): Promise<void> {
  const temporary = path.join(runDir, `.writer-${owner.instanceId}.tmp`);
  try {
    const file = await fs.open(temporary, 'wx');
    try { await file.writeFile(JSON.stringify(owner)); await file.sync(); } finally { await file.close(); }
    // Creating a hard link is atomic and refuses an existing destination. Crashes
    // expose either no marker or a complete, synced marker, never a partial one.
    await fs.link(temporary, runFile(runDir));
  } catch {
    throw new WriterLockError('WRITER_LOCK_PUBLISH_FAILED', 'The complete writer marker could not be published without replacing an existing file.');
  } finally { await fs.unlink(temporary).catch(() => undefined); }
}

async function readOwnerForRelease(runDir: string): Promise<WriterLockInspection> {
  return inspectWriterLock(runDir, { queryProcess: async () => ({ state: 'unknown', reason: 'release-only-checks-owner-token' }) });
}

export async function claimWriterLock(runDir: string, options: WriterLockOptions = {}): Promise<WriterLockHandle> {
  runDir = await fs.realpath(runDir);
  const guard = await acquireGuard(runDir);
  let owner: WriterOwner | undefined;
  try {
    const inspection = await inspectWriterLock(runDir, options);
    if (inspection.state !== 'unlocked') requireRecoverable(inspection);
    let observed: ProcessObservation;
    try { observed = options.queryProcess ? await options.queryProcess(process.pid) : await (ownIdentity ??= queryProcessIdentity(process.pid)); }
    catch { observed = { state: 'unknown', reason: 'process-start-query-failed' }; }
    if (observed.state !== 'alive' || !validIdentity(observed.identity)) { ownIdentity = undefined; throw new WriterLockError('WRITER_IDENTITY_UNAVAILABLE', 'The current operating-system process start identity could not be verified.', inspection); }
    const recovery = inspection.state === 'unlocked' ? undefined : await preserveLock(runDir, inspection, 'automatic');
    owner = { schemaVersion: 2, pid: process.pid, instanceId: randomUUID(), processIdentity: observed.identity, ...(observed.identity.startedAtMs !== undefined ? { processStartedAt: observed.identity.startedAtMs } : {}), createdAt: new Date().toISOString() };
    await publishOwner(runDir, owner);
    const token = owner.instanceId;
    let release: Promise<void> | undefined;
    return { owner, recovery, release: () => release ??= (async () => {
      try {
        const current = await readOwnerForRelease(runDir);
        if (current.owner?.instanceId !== token || current.owner.pid !== process.pid) throw new WriterLockError('WRITER_OWNER_CHANGED', 'Writer release refused because the owner token no longer matches; the current lock was preserved.', current);
        await fs.unlink(runFile(runDir));
      } finally { await guard.release(); }
    })() };
  } catch (error) {
    try {
      // A failed publication may have completed at the OS boundary. It is safe to
      // remove only this attempt's own token while its guard is still held.
      if (owner) {
        const current = await readOwnerForRelease(runDir);
        if (current.owner?.instanceId === owner.instanceId && current.owner.pid === process.pid) await fs.unlink(runFile(runDir));
      }
    } finally { await guard.release(); }
    throw error;
  }
}
