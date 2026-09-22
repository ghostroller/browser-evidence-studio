import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startFixture } from '../../test/fixtures/site/index.ts';

const executable = process.env.BROWSER_EXECUTABLE_PATH;
test('ordinary independent Puppeteer workflow accepts complete data and rejects missing/incorrect/partial entities', { skip: !executable, timeout: 120000 }, async () => {
  const fixture = await startFixture();
  const output = await mkdtemp(path.join(tmpdir(), 'bes-independent-'));
  try {
    for (const variant of ['normal', 'duplicate', 'missing', 'wrong-image', 'empty-middle']) {
      const directory = path.join(output, variant);
      const child = spawn(process.execPath, ['examples/orders/standalone.mjs', '--url', fixture.url, '--executable-path', executable, '--variant', variant, '--output', directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
