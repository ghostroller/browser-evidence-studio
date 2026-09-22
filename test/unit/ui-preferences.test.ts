import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { UiPreferencesStore } from '../../src/main/ui-preferences';
import { makeDispatch } from '../../src/main/services/dispatch';
import type { Studio } from '../../src/main/services/studio';

test('UI preferences start light and persist independently of renderer origin with isolated returned values', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bes-ui-preferences-'));
  try {
    const preferences = new UiPreferencesStore(root);
    assert.deepEqual(preferences.read(), { theme: 'light', layout: {} });
    await Promise.all([
      preferences.update({ theme: 'dark' }),
      preferences.update({ layout: { workspace: [30, 70] } }),
      preferences.update({ layout: { evidence: [25, 75] } }),
    ]);
    const expected = { theme: 'dark', layout: { workspace: [30, 70], evidence: [25, 75] } };
    assert.deepEqual(new UiPreferencesStore(root).read(), expected);
    const response = preferences.read(); response.layout.workspace[0] = 1;
    assert.deepEqual(preferences.read(), expected);
    assert.deepEqual(JSON.parse(await readFile(preferences.file, 'utf8')), expected);
    assert.deepEqual(await preferences.update({ layout: {} }), { theme: 'dark', layout: {} });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unknown preferences, paths and invalid layout sizes cannot change saved settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bes-ui-preferences-'));
  try {
    const preferences = new UiPreferencesStore(root);
    await preferences.update({ theme: 'dark' });
    const saved = await readFile(preferences.file, 'utf8');
    for (const patch of [null, [], { path: '../run.json' }, { theme: 'system' }, { layout: [] },
      { layout: { unknown: [30, 70] } }, { layout: { workspace: [100, 0] } },
      { layout: { workspace: [NaN, 70] } }, { layout: { workspace: [Infinity, 70] } },
      { layout: { workspace: ['30', 70] } }, { layout: { workspace: [30, 30] } },
    ]) assert.throws(() => preferences.update(patch), (error: any) => error.status === 422);
    assert.equal(await readFile(preferences.file, 'utf8'), saved);
    assert.deepEqual(preferences.read(), { theme: 'dark', layout: {} });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('damaged, oversized and unrecognized preference files fall back to bounded light defaults', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bes-ui-preferences-'));
  try {
    const file = path.join(root, 'ui-preferences.json');
    for (const content of ['{"theme":', ' '.repeat(8192), '{"theme":"dark","path":"../private"}', '{"theme":"dark","layout":{"workspace":[-3,103]}}']) {
      await writeFile(file, content);
      assert.deepEqual(new UiPreferencesStore(root).read(), { theme: 'light', layout: {} });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a preference write failure preserves defaults and does not poison subsequent writes', { timeout: 3000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bes-ui-preferences-'));
  const blocked = path.join(root, 'blocked');
  try {
    await writeFile(blocked, 'A regular file cannot hold preferences');
    const preferences = new UiPreferencesStore(blocked);
    await assert.rejects(preferences.update({ theme: 'dark' }));
    assert.deepEqual(preferences.read(), { theme: 'light', layout: {} });
    await rm(blocked); await mkdir(blocked);
    assert.deepEqual(await preferences.update({ theme: 'dark' }), { theme: 'dark', layout: {} });
    assert.deepEqual(new UiPreferencesStore(blocked).read(), { theme: 'dark', layout: {} });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('trusted presentation bypasses a busy business queue and public callers cannot alter it', async () => {
  const calls: unknown[] = [], active = { controller: 'agent', leaseEpoch: 9, execution: 'finalizing' };
  const studio = {
    active,
    serialized: () => { throw new Error('Presentation entered the busy run queue'); },
    window: {
      setPresentation: (reason: string, hidden: boolean) => calls.push({ reason, hidden }),
      setBrowserVisible: (visible: boolean) => calls.push({ visible }),
      uiPreferences: async (patch: unknown) => { calls.push(patch); return { theme: 'light', layout: {} }; },
    },
  } as unknown as Studio;
  const dispatch = makeDispatch(studio);
  await dispatch('presentation', { reason: 'overlay', hidden: true });
  await dispatch('presentation', { reason: 'layout', hidden: true });
  await dispatch('presentation', { reason: 'layout', hidden: false });
  await dispatch('showBrowser', { visible: false });
  assert.deepEqual(await dispatch('uiPreferences'), { theme: 'light', layout: {} });
  assert.equal(calls.length, 5);
  for (const method of ['presentation', 'showBrowser', 'uiPreferences']) {
    await assert.rejects(dispatch(method, {}, 'api'), (error: any) => error.status === 403);
  }
  for (const [method, body] of [['presentation', { reason: 'business-lock', hidden: true }], ['presentation', { reason: 'layout', hidden: 'false' }], ['showBrowser', { visible: 1 }]] as const) {
    await assert.rejects(dispatch(method, body), (error: any) => error.status === 422);
  }
  assert.equal(calls.length, 5);
  assert.deepEqual(active, { controller: 'agent', leaseEpoch: 9, execution: 'finalizing' });
});
