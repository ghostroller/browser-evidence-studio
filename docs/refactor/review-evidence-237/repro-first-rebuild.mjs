/**
 * Independent control-flow probe, NOT a project/Electron integration test.
 * Mirrors the no-pointer branch in src/replay/archive.ts:indexPrefix at 237d778.
 * The only state added is an unpublished recovery staging directory.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, stat, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'bes-review-first-rebuild-'));
async function selectPrefix(runDir) {
  try {
    const pointer = JSON.parse(await readFile(path.join(runDir, 'replay-index-current.json'), 'utf8'));
    return `replay-index-generations/${pointer.generation}`;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try {
      await stat(path.join(runDir, 'replay-index-generations'));
      const failure = new Error('Replay generation pointer is missing; directed recovery required');
      failure.code = 'REPLAY_INDEX_MISSING';
      throw failure;
    } catch (problem) {
      if (problem.code === 'ENOENT') return 'replay-index';
      throw problem;
    }
  }
}
try {
  await mkdir(path.join(root, 'replay-index'));
  const before = await selectPrefix(root);
  assert.equal(before, 'replay-index');
  // Equivalent to a first rebuild staging its generation and failing before publication.
  await mkdir(path.join(root, 'replay-index-generations', 'unpublished'), { recursive: true });
  let after;
  try { after = await selectPrefix(root); }
  catch (error) { after = error.code; }
  assert.equal(after, 'REPLAY_INDEX_MISSING');
  console.log(JSON.stringify({
    scope: 'isolated-control-flow-probe-not-project-test',
    sourceCommit: '237d778bebf99dce74f3f4929eb320f17e10c7ff',
    node: process.version,
    before,
    afterUnpublishedStagingDirectory: after,
    legacyDirectoryStillExists: (await stat(path.join(root, 'replay-index'))).isDirectory()
  }, null, 2));
} finally {
  // Only this probe's own synthetic temporary directory is removed.
  await rm(root, { recursive: true, force: true });
}
