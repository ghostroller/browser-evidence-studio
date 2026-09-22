import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { atomicFile } from '../../src/evidence/files';

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bes-atomic-files-'));
  const file = path.join(directory, 'manifest.json');
  const oldBytes = Buffer.from('{"status":"old-confirmed-original"}\n');
  const newBytes = Buffer.from('{"status":"new-confirmed-original","unicode":"中文"}\n');
  await fs.writeFile(file, oldBytes);
  return { directory, file, oldBytes, newBytes, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

test('Windows transient replacement failures reuse one synced temporary file while preserving the old target', { skip: process.platform !== 'win32' }, async context => {
  const f = await fixture(), rename = fs.rename.bind(fs), open = fs.open.bind(fs);
  const sources: string[] = []; let syncs = 0, temporaryCreates = 0;
  try {
    context.mock.method(fs, 'open', async (file: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1], mode?: Parameters<typeof fs.open>[2]) => {
      const handle = await open(file, flags, mode);
      if (flags === 'wx') {
        temporaryCreates++;
        const sync = handle.sync.bind(handle);
        context.mock.method(handle, 'sync', async () => { await sync(); syncs++; });
      }
      return handle;
    });
    context.mock.method(fs, 'rename', async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
      sources.push(String(source));
      assert.equal(syncs, 1, 'Replacement only begins after the complete temporary file is synced');
      assert.equal(String(destination), f.file);
      assert.deepEqual(await fs.readFile(source), f.newBytes);
      assert.deepEqual(await fs.readFile(f.file), f.oldBytes, 'Each retry retains the old target until replacement succeeds');
      const code = ['EACCES', 'EPERM', 'EBUSY'][sources.length - 1];
      if (code) throw Object.assign(new Error('Synthetic transient Windows sharing failure'), { code });
      return rename(source, destination);
    });
    await atomicFile(f.file, f.newBytes);
    assert.equal(sources.length, 4); assert.equal(new Set(sources).size, 1); assert.equal(temporaryCreates, 1); assert.equal(syncs, 1);
    assert.deepEqual(await fs.readFile(f.file), f.newBytes);
    assert.deepEqual(await fs.readdir(f.directory), ['manifest.json']);
  } finally { context.mock.restoreAll(); await f.cleanup(); }
});

test('Windows permanent sharing failure stops within its retry budget and removes only its temporary file', { skip: process.platform !== 'win32' }, async context => {
  const f = await fixture(), sources: string[] = [], failure = Object.assign(new Error('Synthetic permanent sharing failure'), { code: 'EPERM' });
  try {
    const unrelated = path.join(f.directory, 'another-writer.tmp'); await fs.writeFile(unrelated, 'unrelated');
    context.mock.method(fs, 'rename', async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
      sources.push(String(source)); assert.equal(String(destination), f.file);
      assert.deepEqual(await fs.readFile(source), f.newBytes); assert.deepEqual(await fs.readFile(f.file), f.oldBytes);
      throw failure;
    });
    await assert.rejects(atomicFile(f.file, f.newBytes), error => error === failure);
    assert.equal(sources.length, 7); assert.equal(new Set(sources).size, 1);
    assert.deepEqual(await fs.readFile(f.file), f.oldBytes); assert.equal(await fs.readFile(unrelated, 'utf8'), 'unrelated');
    assert.deepEqual((await fs.readdir(f.directory)).sort(), ['another-writer.tmp', 'manifest.json']);
  } finally { context.mock.restoreAll(); await f.cleanup(); }
});

test('non-retryable replacement failure is returned immediately with the confirmed target unchanged', async context => {
  const f = await fixture(), failure = Object.assign(new Error('Synthetic invalid replacement'), { code: 'EINVAL' }); let attempts = 0;
  try {
    context.mock.method(fs, 'rename', async () => { attempts++; throw failure; });
    await assert.rejects(atomicFile(f.file, f.newBytes), error => error === failure);
    assert.equal(attempts, 1); assert.deepEqual(await fs.readFile(f.file), f.oldBytes);
    assert.deepEqual(await fs.readdir(f.directory), ['manifest.json']);
  } finally { context.mock.restoreAll(); await f.cleanup(); }
});
