import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import { build } from 'vite';
import electron from 'electron';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const verify = args.includes('--verify');
const recording = args.includes('--recording');
if (args.some(arg => arg !== '--verify' && arg !== '--recording' && !arg.startsWith('--url='))) throw new Error('Use --verify, --recording or --url=https://example.com');
if (recording && verify) throw new Error('--recording and --verify are separate comparison modes');
if (recording && args.some(arg => arg.startsWith('--url='))) throw new Error('Create the recording and choose its URL in the isolated Studio client');
if (verify && args.some(arg => arg.startsWith('--url='))) throw new Error('Verification only visits its local synthetic site');
const target = new URL(args.find(arg => arg.startsWith('--url='))?.slice(6) || 'https://www.jd.com/');
if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Use an HTTP(S) URL without credentials');
const root = path.join(workspace, 'output', `browser-${recording ? 'recording' : 'baseline'}-${Date.now()}-${process.pid}`);
const buildDir = path.join(root, 'build');
await mkdir(root, { recursive: true });
// Separate output and dependency graph: never replace Forge's running main bundle.
if (recording) {
  await build({
    configFile: path.join(workspace, 'vite.main.config.ts'), root: workspace, logLevel: 'warn',
    build: { outDir: buildDir, emptyOutDir: false },
    // Always load this build's renderer, never an inherited Forge dev server.
    define: { 'process.env.BES_RENDERER_URL': JSON.stringify(''), MAIN_WINDOW_VITE_DEV_SERVER_URL: 'undefined' },
  });
  await build({
    configFile: path.join(workspace, 'vite.preload.config.ts'), root: workspace, logLevel: 'warn',
    build: { outDir: buildDir, emptyOutDir: false },
  });
  await build({
    configFile: path.join(workspace, 'vite.renderer.config.ts'), root: path.join(workspace, 'src/renderer'), logLevel: 'warn',
    build: { outDir: path.join(root, 'renderer/main_window') },
  });
  // Electron's file entry makes buildDir its app path. Keep ESM resolution and
  // the ordinary runner's dependency-lock fingerprint valid in this layout.
  const manifest = JSON.parse(await readFile(path.join(workspace, 'package.json'), 'utf8'));
  await writeFile(path.join(buildDir, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, private: true, type: 'module', main: 'index.js' }, null, 2));
  await writeFile(path.join(buildDir, 'package-lock.json'), await readFile(path.join(workspace, 'package-lock.json')));
  // app.setPath('userData') runs before ready and single-instance locking.
  await mkdir(path.join(root, 'data'), { recursive: true });
} else {
  const result = await build({
    configFile: false, root: workspace, logLevel: 'warn',
    build: {
      target: 'node24', outDir: buildDir, emptyOutDir: false, minify: false,
      lib: { entry: path.join(workspace, 'src/main/browser/baseline.ts'), formats: ['es'], fileName: () => 'baseline.mjs' },
      rolldownOptions: { external: ['electron', ...builtinModules, ...builtinModules.map(name => 'node:' + name)] },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const modules = [...new Set(outputs.flatMap(output => 'output' in output ? output.output.flatMap(item => item.type === 'chunk' ? Object.keys(item.modules) : []) : []))];
  if (!modules.length || modules.some(name => /[\\/]src[\\/](capture|evidence|runner)[\\/]|[\\/]services[\\/]studio\.|[\\/]node_modules[\\/](puppeteer(?:-core)?|@puppeteer|rrweb|ws)[\\/]/.test(name))) {
    throw new Error('The baseline build must not include Studio, capture, evidence, runner or automation dependencies');
  }
  await writeFile(path.join(root, 'build-modules.json'), JSON.stringify(modules.map(name => path.relative(workspace, name)), null, 2));
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// Do not inherit the normal client's workspace, test modes or injected Node options.
for (const key of Object.keys(env)) if (key.startsWith('BES_')) delete env[key];
delete env.NODE_OPTIONS;
if (recording) env.BES_DATA = path.join(root, 'data');
else Object.assign(env, { BES_BASELINE_ROOT: root, BES_BASELINE_VERIFY: verify ? '1' : '', BES_BASELINE_URL: target.href });
console.log(`${recording ? 'Recording comparison' : 'Baseline'} output: ${root}`);
// Electron is the requested interactive window, not a hidden console helper.
const child = spawn(electron, [path.join(buildDir, recording ? 'index.js' : 'baseline.mjs')], { cwd: workspace, env, stdio: 'inherit', windowsHide: false });
const timeout = verify ? setTimeout(() => child.kill(), 60_000) : undefined;
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
if (timeout) clearTimeout(timeout);
if (verify) {
  const report = JSON.parse(await readFile(path.join(root, 'verification.json'), 'utf8'));
  if (code !== 0 || report.passed !== true || report.processId !== child.pid) throw new Error('Baseline verification failed; inspect its report');
  console.log(`Baseline verification passed: ${path.join(root, 'verification.json')}`);
}
process.exitCode = typeof code === 'number' ? code : 1;
