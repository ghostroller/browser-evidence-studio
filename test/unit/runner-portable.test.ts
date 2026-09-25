import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { build } from 'vite';

test('single-file helper runs outside the repository under plain Node and selectively reruns a failed entity after fresh validation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bes-c-portable-'));
  try {
    await build({ configFile: false, logLevel: 'silent', build: { target: 'node24', outDir: root, emptyOutDir: false, minify: false,
      lib: { entry: path.resolve('src/runner/portable.ts'), formats: ['es'], fileName: () => 'runner-helper.mjs' }, rolldownOptions: { external: /^node:/ } } });
    const source = await readFile(path.join(root, 'runner-helper.mjs'), 'utf8');
    assert.doesNotMatch(source, /(?:from|import\s*\()\s*['"](?:electron|puppeteer|vite|\.)/);
    await writeFile(path.join(root, 'login.json'), JSON.stringify({ authenticated: true, code: 'code-v1', material: 'material-v1', input: 'input-v1' }));
    await writeFile(path.join(root, 'standalone.mjs'), `
      import { createStepRunner } from './runner-helper.mjs';
      import { readFile,writeFile } from 'node:fs/promises';
      const events=[]; const save=async event=>{events.push(event);};
      const first=createStepRunner({executionId:'same-execution',signal:new AbortController().signal,save});
      const prior=await first.run({stepId:'detail',entityKey:'order-2',run:async()=>{throw new Error('transient detail failure');}});
      const selected=createStepRunner({executionId:'same-execution',signal:new AbortController().signal,save,selection:{stepIds:['detail'],entityKeys:['order-2']}});
      const actions=[]; const results=[];
      const verify=async()=>{const login=JSON.parse(await readFile(new URL('./login.json',import.meta.url),'utf8'));return {valid:login.authenticated&&login.code==='code-v1'&&login.material==='material-v1'&&login.input==='input-v1',evidenceRefs:['current-login','same-code-material-input']};};
      for(const id of ['order-1','order-2','order-3'])if(selected.selected('detail',id))results.push(await selected.run({stepId:'detail',entityKey:id,prior:{identity:prior.identity,validate:verify},run:async()=>{actions.push(id);return {id};}}));
      await writeFile(new URL('./login.json',import.meta.url),JSON.stringify({authenticated:false}));
      const blocked=await selected.run({stepId:'detail',entityKey:'order-2',prior:{identity:prior.identity,validate:verify},run:async()=>{actions.push('should-not-run');}});
      process.stdout.write(JSON.stringify({prior,results,blocked,actions,events}));
    `);
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, 'standalone.mjs')], { cwd: root, windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 });
    const result = JSON.parse(stdout) as { prior: { identity: { attemptId: string } }; results: { identity: { attemptId: string }; status: string }[]; blocked: { status: string }; actions: string[]; events: { rerun?: { status: string; from: { attemptId: string } } }[] };
    assert.deepEqual(result.actions, ['order-2']); assert.equal(result.results[0].status, 'succeeded'); assert.equal(result.blocked.status, 'blocked');
    assert.notEqual(result.results[0].identity.attemptId, result.prior.identity.attemptId);
    assert.ok(result.events.some(event => event.rerun?.status === 'passed' && event.rerun.from.attemptId === result.prior.identity.attemptId));
    assert.ok(result.events.some(event => event.rerun?.status === 'failed'));
  } finally {
    assert.equal(await realpath(path.dirname(root)), await realpath(tmpdir())); assert.ok(path.basename(root).startsWith('bes-c-portable-'));
    await rm(root, { recursive: true, force: true });
  }
});
