import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../fixtures/site/index.ts';

const executable = process.env.BROWSER_EXECUTABLE_PATH;
const sourceOverride = process.env.BES_ORDERS_SOURCE_DIR;
if (sourceOverride) assert.ok(path.isAbsolute(sourceOverride), 'BES_ORDERS_SOURCE_DIR must be an absolute extracted resources/orders path');
const source = sourceOverride || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../examples/orders');
const sourceFiles = ['package.json', 'package-lock.json', 'standalone.mjs', 'run.mjs', 'input.schema.json', 'output.schema.json'];
let standalone;
before(async () => {
  standalone = await mkdtemp(path.join(tmpdir(), 'bes-standalone-package-'));
  console.log(`Independent workflow source: ${source}`);
  for (const file of sourceFiles) await copyFile(path.join(source, file), path.join(standalone, file));
  const install = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: standalone, shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let installation = '';
  install.stdout.on('data', chunk => installation += chunk);
  install.stderr.on('data', chunk => installation += chunk);
  const installExit = await new Promise((resolve, reject) => { install.once('error', reject); install.once('exit', resolve); });
  assert.equal(installExit, 0, installation);
});
after(async () => { if (standalone) await rm(standalone, { recursive: true, force: true }); });
test('independent entry refuses an occupied output directory before launching Chrome', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'bes-independent-existing-'));
  const original = '{"keep":"earlier evidence"}\n';
  try {
    await writeFile(path.join(output, 'result.json'), original);
    const child = spawn(process.execPath, [path.join(standalone, 'standalone.mjs'), '--url', 'http://127.0.0.1:1', '--executable-path', path.join(output, 'missing-chrome'), '--output', output], { cwd: standalone, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    child.stderr.on('data', chunk => { diagnostics += chunk; });
    const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(exitCode, 1);
    assert.match(diagnostics, /Output directory must be empty/);
    assert.equal(await readFile(path.join(output, 'result.json'), 'utf8'), original);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('ordinary independent Puppeteer workflow installs outside the repository, accepts complete data and rejects missing/incorrect/partial entities', { skip: !executable, timeout: 240000 }, async () => {
  const fixture = await startFixture();
  const output = await mkdtemp(path.join(tmpdir(), 'bes-independent-'));
  try {
    for (const variant of ['normal', 'duplicate', 'missing', 'wrong-image', 'empty-middle']) {
      const directory = path.join(output, variant);
      const child = spawn(process.execPath, [path.join(standalone, 'standalone.mjs'), '--url', fixture.url, '--executable-path', executable, '--variant', variant, '--output', directory], { cwd: standalone, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let diagnostics = '';
      child.stdout.on('data', chunk => diagnostics += chunk);
      child.stderr.on('data', chunk => diagnostics += chunk);
      const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      assert.equal(exitCode, ['normal', 'duplicate'].includes(variant) ? 0 : 1, diagnostics);
      const report = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
      assert.equal(report.machineVerdict, ['normal', 'duplicate'].includes(variant) ? 'pass' : 'fail', diagnostics);
      if (variant === 'duplicate') assert.deepEqual(report.result.duplicateIds, ['SYN-003']);
    }
    console.log(`Independent workflow evidence: ${output}`);
  } finally { await fixture.close(); }
});
