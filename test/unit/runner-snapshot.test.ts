import { test } from 'vitest';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fingerprintWorkflow } from '@/runner/fingerprint';
import { prepareExecutionSnapshot, type ExecutionSnapshot } from '@/runner/snapshot';

async function fixture(run: (source: string, output: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'bes-c-snapshot-'));
  const source = path.join(root, 'source'), output = path.join(root, 'output'); await mkdir(source); await mkdir(output);
  try { await run(source, output); }
  finally {
    assert.equal(await realpath(path.dirname(root)), await realpath(tmpdir())); assert.ok(path.basename(root).startsWith('bes-c-snapshot-'));
    await rm(root, { recursive: true, force: true });
  }
}
async function execute(snapshot: ExecutionSnapshot, output: string): Promise<{ value?: unknown; error?: string }> {
  const entry = path.join(output, 'loader.mjs');
  await writeFile(entry, `import { installSnapshotLoader } from ${JSON.stringify(pathToFileURL(path.resolve('src/runner/snapshot-loader.ts')).href)};
    const snapshot = JSON.parse(process.env.BES_SNAPSHOT);
    const hook = installSnapshotLoader(snapshot);
    try { const module = await import(${JSON.stringify(pathToFileURL(path.join(snapshot.directory, 'run.mjs')).href)}); process.send({value:await module.run()}); }
    catch (error) { process.send({error:String(error)}); }
    finally { hook.deregister(); }`);
  const child = fork(entry, [], { execArgv: ['--import', 'tsx'], silent: true, env: { ...process.env, BES_SNAPSHOT: JSON.stringify(snapshot) } });
  let stderr = ''; child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    return await new Promise((resolve, reject) => { child.once('message', value => resolve(value as { value?: unknown; error?: string })); child.once('error', reject); child.once('exit', code => reject(new Error(`Loader exited ${code}: ${stderr}`))); });
  } finally { await exit; }
}

test('snapshot isolates later dynamic imports and captures project-local dependency bytes', async () => fixture(async (source, output) => {
  await writeFile(path.join(source, 'run.mjs'), `export async function run(){ const {value}=await import('./lazy.mjs'); const {pkg}=await import('local-fixture'); return {value,pkg}; }`);
  await writeFile(path.join(source, 'lazy.mjs'), `export const value='before';`);
  const dependency = path.join(source, 'node_modules', 'local-fixture'); await mkdir(dependency, { recursive: true });
  await writeFile(path.join(dependency, 'package.json'), JSON.stringify({ name: 'local-fixture', type: 'module', exports: './index.js' }));
  await writeFile(path.join(dependency, 'index.js'), `export const pkg='installed-v1';`);
  const before = await fingerprintWorkflow(source);
  const snapshot = await prepareExecutionSnapshot(source, before, output);
  await writeFile(path.join(source, 'lazy.mjs'), `export const value='after';`);
  await writeFile(path.join(dependency, 'index.js'), `export const pkg='installed-v2';`);
  assert.deepEqual(await execute(snapshot, output), { value: { value: 'before', pkg: 'installed-v1' } });
  assert.notEqual((await fingerprintWorkflow(source)).sha256, before.sha256);
  assert.ok(snapshot.files.some(file => file.path === 'node_modules/local-fixture/index.js'));
}));

test('changes during snapshot creation and tampering with a frozen lazy module are rejected before execution', async () => fixture(async (source, output) => {
  await writeFile(path.join(source, 'run.mjs'), `export async function run(){ return (await import('./lazy.mjs')).value; }`);
  await writeFile(path.join(source, 'lazy.mjs'), `export const value='before';`);
  const before = await fingerprintWorkflow(source);
  await writeFile(path.join(source, 'lazy.mjs'), `export const value='changed-before-copy';`);
  await assert.rejects(prepareExecutionSnapshot(source, before, output), /changed before snapshot/);
  const snapshot = await prepareExecutionSnapshot(source, await fingerprintWorkflow(source), output);
  const lazy = path.join(snapshot.directory, 'lazy.mjs'); await chmod(lazy, 0o644); await writeFile(lazy, `export const value='tampered';`);
  assert.match((await execute(snapshot, output)).error ?? '', /Frozen module changed before loading/);
}));

test('business modules cannot import mutable files outside the frozen project', async () => fixture(async (source, output) => {
  const outside = path.join(output, 'mutable.mjs'); await writeFile(outside, `export const value='mutable';`);
  await writeFile(path.join(source, 'run.mjs'), `export async function run(){ return (await import(${JSON.stringify(pathToFileURL(outside).href)})).value; }`);
  const snapshot = await prepareExecutionSnapshot(source, await fingerprintWorkflow(source), output);
  assert.match((await execute(snapshot, output)).error ?? '', /outside the frozen execution snapshot/);
  assert.equal(await readFile(outside, 'utf8'), `export const value='mutable';`);
}));
