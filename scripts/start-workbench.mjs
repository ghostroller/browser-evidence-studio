import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import electron from 'electron';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
export function workbenchChildEnv(env, dataRoot, origin) {
  const next = { ...env, BES_DATA: dataRoot, BES_WORKBENCH_SYNTHETIC: '1', BES_WORKBENCH_ORIGIN: origin };
  for (const key of Object.keys(next)) if (key.startsWith('BES_TEST') || key.startsWith('BES_WORKBENCH_') && !['BES_WORKBENCH_SYNTHETIC', 'BES_WORKBENCH_ORIGIN'].includes(key)) delete next[key];
  delete next.ELECTRON_RUN_AS_NODE;
  delete next.BES_VISIBLE_EVIDENCE;
  return next;
}
/** Real supported launch flow: no seeded project, ticket extraction or browser
 * automation. The human creates a project and begins pairing in the native UI. */
export async function startWorkbench() {
  const build = await readFile(path.join(workspace, '.vite/build/index.js'));
  const directory = path.join(workspace, 'output', `workbench-${Date.now()}-${randomUUID().slice(0, 8)}`);
  const dataRoot = path.join(directory, 'companion');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(dataRoot, { mode: 0o700 });
  const browserPort = await freeLoopbackPort(), origin = `http://127.0.0.1:${browserPort}`;
  const companion = spawn(electron, ['.'], { cwd: workspace, env: workbenchChildEnv(process.env, dataRoot, origin), stdio: 'inherit' });
  let vite, stopping = false;
  const children = [companion];
  const done = new Map();
  const watch = child => {
    const outcome = new Promise(resolve => {
      child.once('error', () => resolve({ code: 1, error: 'process_start_failed' }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    done.set(child, outcome); return outcome;
  };
  const companionDone = watch(companion);
  const stop = () => {
    if (stopping) return; stopping = true;
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    let discovery;
    for (let attempt = 0; attempt < 300; attempt++) {
      if (stopping || companion.exitCode !== null || companion.signalCode !== null) throw new Error('Synthetic companion stopped before readiness.');
      try { discovery = JSON.parse(await readFile(path.join(dataRoot, 'connection/workbench.json'), 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('Synthetic companion discovery was unreadable.'); }
      await delay(100);
    }
    if (!discovery || discovery.processId !== companion.pid || discovery.origin !== origin || !/^[a-zA-Z0-9_-]{1,128}$/.test(discovery.instanceId)) throw new Error('Synthetic companion readiness was not verified.');
    const target = new URL(discovery.baseUrl);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.origin !== discovery.baseUrl) throw new Error('Invalid companion authority.');
    vite = spawn(process.execPath, [path.join(workspace, 'node_modules/vite/bin/vite.js'), '--config', 'vite.browser.config.ts'], {
      cwd: workspace, stdio: 'inherit', env: { ...process.env, BES_WORKBENCH_BROWSER_PORT: String(browserPort), BES_WORKBENCH_TARGET_PORT: target.port, BES_WORKBENCH_INSTANCE_ID: discovery.instanceId },
    });
    children.push(vite); const viteDone = watch(vite);
    const identity = { schemaVersion: 1, startedAt: new Date().toISOString(), dataRoot, workspace,
      sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim(),
      sourceDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' }).trim(),
      backendKind: 'electron-companion', runtimeProvider: 'electron', frontendOrigin: origin, backendOrigin: discovery.baseUrl,
      logs: { processOutput: 'launcher terminal stdout/stderr (not captured)', lifecycleDirectory: path.join(dataRoot, 'diagnostics') },
      buildSha256: createHash('sha256').update(build).digest('hex'), instanceId: discovery.instanceId,
      companionProcessId: companion.pid, viteProcessId: vite.pid, browserUrl: `${origin}/browser.html` };
    await writeFile(path.join(directory, 'launch.json'), JSON.stringify({ ...identity, status: 'starting' }, null, 2));
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (stopping || vite.exitCode !== null || vite.signalCode !== null || companion.exitCode !== null || companion.signalCode !== null) break;
      try {
        const response = await fetch(`${origin}/browser.html`, { signal: AbortSignal.timeout(1000) });
        const html = await response.text();
        if (response.ok && html.includes(`content="${discovery.instanceId}"`)) { ready = true; break; }
      } catch { /* Vite is still starting; no auth data is used for readiness. */ }
      await delay(100);
    }
    if (!ready) throw new Error('Synthetic browser UI readiness was not verified.');
    await writeFile(path.join(directory, 'launch.json'), JSON.stringify({ ...identity, status: 'ready' }, null, 2));
    console.log(`Web UI + Electron companion: ${origin}/browser.html\nCreate a synthetic project in Electron, open browser pairing, and manually enter its short-lived ticket in the browser.\nNo project or login data was imported. Closing the pairing panel revokes access.\nLaunch identity: ${path.join(directory, 'launch.json')}`);
    const outcome = await Promise.race([companionDone, viteDone]);
    if (!stopping && outcome.code !== 0) throw new Error('A synthetic workbench process stopped unexpectedly.');
  } finally {
    stop();
    await Promise.all([...done.values()]);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 2) throw new Error('start:workbench accepts no arguments and always creates fresh synthetic data.');
    await startWorkbench();
  } catch (error) { console.error(error instanceof Error ? error.message : 'Synthetic workbench failed.'); process.exitCode = 1; }
}
