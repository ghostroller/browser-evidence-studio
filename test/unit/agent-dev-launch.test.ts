import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
// Direct Node ESM entry, intentionally outside the Vite/TypeScript source graph.
// @ts-expect-error .mjs development launcher is exercised through subprocess tests.
import { developmentDataRoot, startAgentDevelopment } from '../../scripts/start-agent.mjs';

async function fixture(t: TestContext) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'bes-agent-launch-'));
  t.onTestFinished(async () => {
    assert(path.isAbsolute(workspace) && path.dirname(workspace) === os.tmpdir());
    await rm(workspace, { recursive: true, force: true });
  });
  const stdout = new PassThrough(), stderr = new PassThrough();
  let out = '', err = '';
  stdout.on('data', chunk => { out += chunk.toString(); });
  stderr.on('data', chunk => { err += chunk.toString(); });
  return { workspace, stdout, stderr, output: () => ({ out, err }) };
}

test('agent development preserves terminal and raw logs, records nonzero exit and connection discovery without reading secrets', async t => {
  const f = await fixture(t);
  const result = await startAgentDevelopment({ ...f, stdin: 'ignore', signals: false,
    env: { ...process.env, BES_DATA: 'custom data', BES_EXAMPLE_SECRET: 'do-not-copy-environment' },
    args: ['--input-type=module', '-e', `
      const bytes = Buffer.from('合成控制台输出\\n');
      process.stdout.write(bytes.subarray(0, 2));
      setTimeout(() => {
        process.stdout.write(bytes.subarray(2));
        process.stderr.write('synthetic failure\\n');
        process.exitCode = 7;
      }, 30);
    `],
  });
  assert.equal(result.exitCode, 7);
  const latest = JSON.parse(await readFile(path.join(f.workspace, 'output/dev/latest.json'), 'utf8'));
  const summaryText = await readFile(latest.summary, 'utf8');
  const summary = JSON.parse(summaryText);
  assert.equal(summary.status, 'failed'); assert.equal(summary.exitCode, 7);
  assert(summary.child.processId > 0); assert(summary.finishedAt >= summary.startedAt);
  assert.equal(summary.dataRoot, path.join(f.workspace, 'custom data'));
  assert.equal(summary.files.connection, path.join(f.workspace, 'custom data/connection/agent-connection.json'));
  assert.equal(summary.applicationStatus, 'not-inspected');
  assert(!summaryText.includes('do-not-copy-environment'));
  assert.equal(await readFile(summary.files.stdout, 'utf8'), '合成控制台输出\n');
  assert.equal(await readFile(summary.files.stderr, 'utf8'), 'synthetic failure\n');
  const events = (await readFile(summary.files.console, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1));
  assert.equal(events.filter(event => event.stream === 'stdout').map(event => event.text).join(''), '合成控制台输出\n');
  assert.match(f.output().out, /Agent development summary:/); assert.match(f.output().err, /synthetic failure/);
});

test('older concurrent launcher exit cannot overwrite a newer discovery pointer', async t => {
  const f = await fixture(t);
  const first = startAgentDevelopment({ ...f, stdin: 'ignore', signals: false,
    args: ['-e', 'setTimeout(() => console.log("first"), 300)'] });
  await delay(40);
  const second = await startAgentDevelopment({ ...f, stdin: 'ignore', signals: false,
    args: ['-e', 'console.log("second")'] });
  const prior = await first;
  assert.equal(prior.summary.status, 'exited'); assert.equal(second.summary.status, 'exited');
  assert.notEqual(prior.summary.launchId, second.summary.launchId);
  const latest = JSON.parse(await readFile(path.join(f.workspace, 'output/dev/latest.json'), 'utf8'));
  assert.equal(latest.launchId, second.summary.launchId);
  assert.equal(JSON.parse(await readFile(latest.summary, 'utf8')).child.processId, second.summary.child.processId);
});

test('failed subprocess creation retains the launch summary and reports failure', async t => {
  const f = await fixture(t);
  const result = await startAgentDevelopment({ ...f, stdin: 'ignore', signals: false,
    executable: path.join(f.workspace, 'absent-executable'), args: [] });
  assert.equal(result.exitCode, 1); assert.equal(result.summary.status, 'failed');
  assert.equal(result.summary.child.processId, null); assert.match(result.summary.error, /ENOENT/);
  assert.equal(JSON.parse(await readFile(result.summary.files.summary, 'utf8')).status, 'failed');
});

test('development data root matches Electron platform defaults and resolves custom relative paths', () => {
  const workspace = path.resolve('synthetic-workspace');
  assert.equal(developmentDataRoot({ APPDATA: path.join(workspace, 'roaming') }, workspace, 'win32'), path.join(workspace, 'roaming/BrowserEvidenceStudio-dev'));
  assert.equal(developmentDataRoot({ XDG_CONFIG_HOME: path.join(workspace, 'xdg') }, workspace, 'linux'), path.join(workspace, 'xdg/BrowserEvidenceStudio-dev'));
  assert.equal(developmentDataRoot({ BES_DATA: 'isolated' }, workspace), path.join(workspace, 'isolated'));
});
