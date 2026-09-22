import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claimWriterLock, inspectWriterLock, queryProcessIdentity, recoverWriterLock, type ProcessIdentity, type WriterOwner } from '../../src/evidence/writer-lock';
import { EvidenceStore } from '../../src/evidence/store';
import { EvidenceReader } from '../../src/evidence/reader';
import { evidenceSources } from '../../src/evidence/index';

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bes-writer-lock-'));
  return { directory, file: path.join(directory, 'writer.lock'), async close() { await fs.rm(directory, { recursive: true, force: true }); } };
}
async function currentIdentity(): Promise<ProcessIdentity> {
  const process = await queryProcessIdentity(globalThis.process.pid);
  assert.equal(process.state, 'alive');
  assert.ok(process.state === 'alive');
  return process.identity;
}
async function marker(file: string, changes: Partial<WriterOwner> = {}): Promise<string> {
  const owner: WriterOwner = { schemaVersion: 2, pid: process.pid, instanceId: randomUUID(), processIdentity: await currentIdentity(), ...changes };
  const bytes = JSON.stringify(owner);
  await fs.writeFile(file, bytes);
  return bytes;
}

const actorProgram = `import { claimWriterLock } from ${JSON.stringify(new URL('../../src/evidence/writer-lock.ts', import.meta.url).href)};
import { promises as fs } from 'node:fs';
let lock; const keepalive=setInterval(()=>{},1000);
process.on('message',async message=>{
 if(message==='claim-pause-before-publication'||message==='claim-pause-after-publication'){
  const after=message==='claim-pause-after-publication',link=fs.link.bind(fs);fs.link=async(...args)=>{if(after)await link(...args);process.send({status:'publication-paused'});await new Promise(()=>{});};message='claim';
 }
 if(message==='claim')try{lock=await claimWriterLock(process.argv[1]);process.send({status:'held',owner:lock.owner,recovery:lock.recovery});}catch(error){process.send({status:'rejected',code:error.code,message:error.message});}
 if(message==='release')try{await lock.release();process.send({status:'released'});clearInterval(keepalive);process.disconnect();}catch(error){process.send({status:'release-failed',code:error.code});}
});process.send({status:'ready'});`;
function waitMessage(child: ChildProcess): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Writer actor did not report within 15 seconds')); }, 15000);
    const message = (value: unknown) => { cleanup(); resolve(value); };
    const exit = () => { cleanup(); reject(new Error('Writer actor exited before its report')); };
    const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); };
    child.once('message', message); child.once('exit', exit);
  });
}
async function actor(directory: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', actorProgram, directory], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  let errors = ''; child.stderr!.on('data', chunk => { errors += chunk.toString(); });
  assert.equal((await waitMessage(child)).status, 'ready', errors);
  return { child, exited, async send(message: string) { const response = waitMessage(child); child.send(message); return response; }, async kill() { child.kill('SIGKILL'); await exited; } };
}

test('OS identity distinguishes alive processes from exited processes without treating query failures as death', async () => {
  const identity = await currentIdentity();
  assert.ok(identity.value);
  const child = spawn(process.execPath, ['--input-type=module', '-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  const exited = once(child, 'exit');
  try {
    assert.equal((await queryProcessIdentity(child.pid!)).state, 'alive');
    child.kill('SIGKILL'); await exited;
    assert.equal((await queryProcessIdentity(child.pid!)).state, 'dead');
    assert.equal((await queryProcessIdentity(-1)).state, 'unknown');
  } finally { child.kill('SIGKILL'); await exited; }
});

test('live, PID-reused and legacy approximate owners receive different recovery decisions', async () => {
  const f = await fixture();
  try {
    const bytes = await marker(f.file);
    const live = await inspectWriterLock(f.directory);
    assert.equal(live.state, 'live');
    await assert.rejects(claimWriterLock(f.directory), (error: any) => error.code === 'WRITER_BUSY' && error.statusCode === 409);
    assert.equal(await fs.readFile(f.file, 'utf8'), bytes);
    const owner = JSON.parse(bytes) as WriterOwner;
    owner.processIdentity = { ...owner.processIdentity!, value: owner.processIdentity!.kind === 'windows-filetime' ? (BigInt(owner.processIdentity!.value) - 1n).toString() : owner.processIdentity!.value.replace(/:\d+$/, ':0') };
    await fs.writeFile(f.file, JSON.stringify(owner));
    const reused = await inspectWriterLock(f.directory);
    assert.equal(reused.state, 'pid-reused');
    const recovery = await recoverWriterLock(f.directory, { expectedFingerprint: reused.lockFingerprint! });
    assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, recovery.preservedLockPath), 'utf8')).instanceId, owner.instanceId);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, recovery.diagnosticPath), 'utf8')).status, 'preserved');
    assert.equal((await inspectWriterLock(f.directory)).state, 'unlocked');

    const legacy = { pid: process.pid, instanceId: randomUUID(), processStartedAt: Date.now() - process.uptime() * 1000 };
    await fs.writeFile(f.file, JSON.stringify(legacy));
    const near = await inspectWriterLock(f.directory);
    assert.ok(['live', 'unknown'].includes(near.state));
    assert.notEqual(near.state, 'pid-reused');
    await fs.writeFile(f.file, JSON.stringify({ ...legacy, processStartedAt: 1 }));
    assert.equal((await inspectWriterLock(f.directory)).state, 'unknown', 'Approximate legacy timestamps cannot authorize PID-reuse recovery');
    const deadLegacy = JSON.stringify({ ...legacy, pid: 2147483647 });
    await fs.writeFile(f.file, deadLegacy);
    const absent = await inspectWriterLock(f.directory); assert.equal(absent.state, 'dead');
    const legacyRecovery = await recoverWriterLock(f.directory, { expectedFingerprint: absent.lockFingerprint! });
    assert.equal(await fs.readFile(path.join(f.directory, legacyRecovery.preservedLockPath), 'utf8'), deadLegacy);
  } finally { await f.close(); }
});

test('query failures, corrupt locks and stale inspection fingerprints never authorize deletion', async () => {
  const f = await fixture();
  try {
    const bytes = await marker(f.file);
    const failedQuery = { queryProcess: async () => { throw new Error('synthetic access denied'); } };
    const unknown = await inspectWriterLock(f.directory, failedQuery);
    assert.equal(unknown.state, 'unknown');
    await assert.rejects(claimWriterLock(f.directory, failedQuery), (error: any) => error.code === 'WRITER_OWNERSHIP_UNKNOWN');
    await assert.rejects(recoverWriterLock(f.directory, { expectedFingerprint: unknown.lockFingerprint! }, failedQuery), (error: any) => error.code === 'WRITER_OWNERSHIP_UNKNOWN');
    assert.equal(await fs.readFile(f.file, 'utf8'), bytes);
    await fs.writeFile(f.file, '{"pid":');
    const corrupt = await inspectWriterLock(f.directory);
    assert.equal(corrupt.state, 'corrupt'); assert.ok(corrupt.lockFingerprint);
    await assert.rejects(claimWriterLock(f.directory), (error: any) => error.code === 'WRITER_LOCK_INVALID');
    await assert.rejects(recoverWriterLock(f.directory, { expectedFingerprint: corrupt.lockFingerprint! }), (error: any) => error.code === 'WRITER_LOCK_INVALID');
    assert.equal(await fs.readFile(f.file, 'utf8'), '{"pid":');
    await fs.writeFile(f.file, bytes);
    await assert.rejects(recoverWriterLock(f.directory, { expectedFingerprint: corrupt.lockFingerprint! }), (error: any) => error.code === 'WRITER_LOCK_CHANGED');
    assert.equal(await fs.readFile(f.file, 'utf8'), bytes);
  } finally { await f.close(); }
});

test('two real processes cannot both recover a killed writer and the winner preserves the exact old lock', async () => {
  const f = await fixture(), holder = await actor(f.directory), left = await actor(f.directory), right = await actor(f.directory);
  try {
    const first = await holder.send('claim'); assert.equal(first.status, 'held');
    const original = await fs.readFile(f.file);
    assert.equal((await left.send('claim')).code, 'WRITER_BUSY', 'An existing kernel guard excludes even before stale-file inspection');
    await holder.kill();
    const outcomes = await Promise.all([left.send('claim'), right.send('claim')]);
    assert.equal(outcomes.filter(result => result.status === 'held').length, 1);
    assert.equal(outcomes.filter(result => result.code === 'WRITER_BUSY').length, 1);
    const winnerIndex = outcomes.findIndex(result => result.status === 'held'), winner = outcomes[winnerIndex];
    assert.equal(winner.recovery.inspection.state, 'dead');
    assert.deepEqual(await fs.readFile(path.join(f.directory, winner.recovery.preservedLockPath)), original);
    assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).instanceId, winner.owner.instanceId);
    assert.equal((await fs.readdir(path.join(f.directory, 'recovery'))).length, 1);
    const winningActor = winnerIndex === 0 ? left : right;
    assert.equal((await winningActor.send('release')).status, 'released');
    await winningActor.exited;
    assert.equal((await inspectWriterLock(f.directory)).state, 'unlocked');
  } finally { await Promise.all([holder.kill(), left.kill(), right.kill()]); await f.close(); }
});

test('release is idempotent and refuses to remove a different owner token', async () => {
  const f = await fixture();
  try {
    const old = await claimWriterLock(f.directory); await old.release();
    const current = await claimWriterLock(f.directory);
    await old.release();
    assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).instanceId, current.owner.instanceId, 'A late old release must not unlink the replacement writer');
    const foreign = { ...current.owner, instanceId: randomUUID() };
    await fs.writeFile(f.file, JSON.stringify(foreign));
    await assert.rejects(current.release(), (error: any) => error.code === 'WRITER_OWNER_CHANGED');
    assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).instanceId, foreign.instanceId);
  } finally { await f.close(); }
});

test('strong termination on either side of atomic marker publication never leaves a partial writer.lock', async () => {
  for (const point of ['before', 'after'] as const) {
    const f = await fixture(), writer = await actor(f.directory);
    let next: Awaited<ReturnType<typeof claimWriterLock>> | undefined;
    try {
      assert.equal((await writer.send(`claim-pause-${point}-publication`)).status, 'publication-paused');
      await writer.kill();
      if (point === 'before') assert.equal((await inspectWriterLock(f.directory)).state, 'unlocked');
      else { const inspection = await inspectWriterLock(f.directory); assert.equal(inspection.state, 'dead'); assert.ok(inspection.owner?.processIdentity); }
      next = await claimWriterLock(f.directory);
      assert.equal(Boolean(next.recovery), point === 'after');
      assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).instanceId, next.owner.instanceId);
    } finally { await next?.release(); await writer.kill(); await f.close(); }
  }
});

test('a competing marker at the publication boundary is preserved when no-replace publication fails', async () => {
  const f = await fixture(), originalLink = fs.link;
  const foreign = { schemaVersion: 2, pid: process.pid, instanceId: randomUUID(), processIdentity: await currentIdentity() };
  try {
    fs.link = async (existing, target) => {
      await fs.writeFile(target, JSON.stringify(foreign), { flag: 'wx' });
      return originalLink(existing, target);
    };
    await assert.rejects(claimWriterLock(f.directory), (error: any) => error.code === 'WRITER_LOCK_PUBLISH_FAILED');
    assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).instanceId, foreign.instanceId);
    assert.equal((await fs.readdir(f.directory)).filter(name => name.endsWith('.tmp')).length, 0);
  } finally { fs.link = originalLink; await f.close(); }
});

test('directory aliases share the same kernel writer guard', async () => {
  const f = await fixture(), alias = `${f.directory}-alias`;
  let lock: Awaited<ReturnType<typeof claimWriterLock>> | undefined;
  try {
    await fs.symlink(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    lock = await claimWriterLock(f.directory);
    await assert.rejects(claimWriterLock(alias), (error: any) => error.code === 'WRITER_BUSY');
  } finally { await lock?.release(); await fs.unlink(alias).catch(() => undefined); await f.close(); }
});

test('reopening an already interrupted run rebuilds indexes without rewriting originals or adding recovery gaps', async () => {
  const f = await fixture();
  try {
    const input = { id: 'idempotent-recovery', projectId: 'synthetic', kind: 'demonstrate' as const, mode: 'synthetic', objective: 'Repeated recovery is read-only for original evidence' };
    const original = await EvidenceStore.create(f.directory, input);
    const event = await original.appendEvent({ type: 'confirmed', source: 'synthetic' });
    await original.close();
    const recovered = await EvidenceStore.open(f.directory); await recovered.close();
    const sources = ['manifest.json', ...(await evidenceSources(f.directory)).map(source => source.file)];
    const bytes = await Promise.all(sources.map(file => fs.readFile(path.join(f.directory, file))));
    const reopened = await EvidenceStore.open(f.directory); await reopened.close();
    const after = ['manifest.json', ...(await evidenceSources(f.directory)).map(source => source.file)];
    assert.deepEqual(after, sources);
    for (let index = 0; index < sources.length; index++) assert.deepEqual(await fs.readFile(path.join(f.directory, sources[index])), bytes[index], sources[index]);
    const reader = new EvidenceReader(f.directory);
    assert.equal((await reader.gaps()).items.length, 1);
    assert.equal(((await reader.events()).items[0] as any).id, event.id);
  } finally { await f.close(); }
});

test('an acknowledged damaged tail is not preserved or reported again on repeated recovery', async () => {
  const f = await fixture();
  try {
    const store = await EvidenceStore.create(f.directory, { id: 'tail-recovery', projectId: 'synthetic', kind: 'demonstrate', mode: 'synthetic', objective: 'Idempotent damaged-tail recovery' });
    await store.appendEvent({ type: 'confirmed', source: 'synthetic' });
    await store.appendRaw('cdp', { method: 'synthetic' });
    await store.close();
    const journal = path.join(f.directory, 'journal', (await fs.readdir(path.join(f.directory, 'journal')))[0]);
    const raw = path.join(f.directory, 'raw', 'cdp', (await fs.readdir(path.join(f.directory, 'raw', 'cdp')))[0]);
    await fs.appendFile(journal, '{"id":"cut'); await fs.appendFile(raw, '{"id":"cut');
    const first = await EvidenceStore.open(f.directory); await first.close();
    const sources = ['manifest.json', ...(await evidenceSources(f.directory)).map(source => source.file)];
    const before = await Promise.all(sources.map(file => fs.readFile(path.join(f.directory, file))));
    const savedCopies = await fs.readdir(path.join(f.directory, 'recovery'));
    const second = await EvidenceStore.open(f.directory); await second.close();
    assert.deepEqual(await fs.readdir(path.join(f.directory, 'recovery')), savedCopies);
    assert.deepEqual(['manifest.json', ...(await evidenceSources(f.directory)).map(source => source.file)], sources);
    for (let index = 0; index < sources.length; index++) assert.deepEqual(await fs.readFile(path.join(f.directory, sources[index])), before[index], sources[index]);
    assert.equal((await new EvidenceReader(f.directory).gaps()).items.length, 3);
    const third = await EvidenceStore.open(f.directory);
    await third.appendRaw('cdp', { method: 'after-recovery' }); await third.close();
    assert.ok((await fs.readFile(raw, 'utf8')).endsWith('{"id":"cut'), 'New raw records must not be appended behind the acknowledged damaged tail');
    assert.equal((await fs.readdir(path.dirname(raw))).length, 2);
  } finally { await f.close(); }
});
