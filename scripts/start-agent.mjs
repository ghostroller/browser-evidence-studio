import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export function developmentDataRoot(env, workspace, platform = process.platform) {
  if (env.BES_DATA) return path.resolve(workspace, env.BES_DATA);
  const appData = platform === 'win32' ? env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
      : env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.resolve(appData, 'BrowserEvidenceStudio-dev');
}

function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  renameSync(temporary, file);
}

/** Reuses Forge unchanged. The command override is for synthetic subprocess tests. */
export async function startAgentDevelopment({ workspace = projectRoot, env = process.env,
  executable = process.execPath, args = [path.join(workspace, 'node_modules/@electron-forge/cli/dist/electron-forge.js'), 'start'],
  stdout = process.stdout, stderr = process.stderr, stdin = 'inherit', signals = true } = {}) {
  workspace = path.resolve(workspace);
  const startedAt = new Date().toISOString();
  const launchId = `${startedAt.replaceAll(/[:.]/g, '-')}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const directory = path.join(workspace, 'output', 'dev', launchId);
  const dataRoot = developmentDataRoot(env, workspace);
  mkdirSync(directory, { recursive: true });
  const files = {
    summary: path.join(directory, 'launch.json'), stdout: path.join(directory, 'stdout.log'),
    stderr: path.join(directory, 'stderr.log'), console: path.join(directory, 'console.jsonl'),
    connection: path.join(dataRoot, 'connection', 'agent-connection.json'),
    lifecycleLatest: path.join(dataRoot, 'diagnostics', 'latest.json'),
    lifecycleDirectory: path.join(dataRoot, 'diagnostics'),
  };
  const handles = Object.fromEntries(['stdout', 'stderr', 'console'].map(key => [key, openSync(files[key], 'wx')]));
  const summary = {
    schemaVersion: 1, launchId, startedAt, updatedAt: startedAt, status: 'starting',
    command: ['npm', 'run', 'start:agent'], workspace, dataRoot,
    dataRootSource: env.BES_DATA ? 'BES_DATA' : 'default-development',
    launcher: { processId: process.pid, startedAt, nodeVersion: process.version },
    child: { executable, args, processId: null, startedAt: null },
    files,
    // These paths locate application evidence; a running Forge process is not proof of app readiness.
    applicationStatus: 'not-inspected',
  };
  const save = () => { summary.updatedAt = new Date().toISOString(); atomicJson(files.summary, summary); };
  save();
  // Publish once. Exit/status updates touch only this launch's file, so an older
  // process cannot replace the newer launch's discovery pointer when it exits.
  atomicJson(path.join(workspace, 'output', 'dev', 'latest.json'), {
    schemaVersion: 1, launchId, startedAt, summary: files.summary, dataRoot,
    connection: files.connection, lifecycleLatest: files.lifecycleLatest,
  });
  stdout.write(`Agent development summary: ${files.summary}\nConnection file: ${files.connection}\n`);

  let child, failure, requestedSignal;
  let consoleSequence = 0;
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  const stop = () => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      // Only this launch's fresh child tree. No process-name matching or unrelated application termination.
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    } else child.kill(requestedSignal || 'SIGTERM');
  };
  const receiveSignal = signal => {
    if (requestedSignal) return;
    requestedSignal = signal; summary.status = 'stopping'; summary.requestedSignal = signal;
    save(); stop();
  };
  const onInterrupt = () => receiveSignal('SIGINT');
  const onTerminate = () => receiveSignal('SIGTERM');
  const record = (stream, chunk) => {
    try {
      appendFileSync(handles[stream], chunk);
      const text = decoders[stream].write(chunk);
      if (text) appendFileSync(handles.console, JSON.stringify({ sequence: ++consoleSequence, at: new Date().toISOString(), stream, text }) + '\n');
    } catch (error) { failure ??= error; stop(); }
  };
  let result;
  try {
    child = spawn(executable, args, {
      cwd: workspace, env: { ...env, BES_DATA: dataRoot }, stdio: [stdin, 'pipe', 'pipe'], windowsHide: true,
    });
    if (signals) { process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate); }
    child.stdout.on('data', chunk => record('stdout', chunk));
    child.stderr.on('data', chunk => record('stderr', chunk));
    child.stdout.pipe(stdout, { end: false });
    child.stderr.pipe(stderr, { end: false });
    result = await new Promise(resolve => {
      child.once('spawn', () => {
        summary.status = 'running'; summary.child.processId = child.pid;
        summary.child.startedAt = new Date().toISOString();
        try { save(); } catch (error) { failure ??= error; stop(); }
      });
      child.once('error', error => { failure ??= error; });
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
  } catch (error) { failure ??= error; result = { exitCode: null, signal: null }; }
  finally {
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
    for (const [stream, decoder] of Object.entries(decoders)) {
      const text = decoder.end();
      if (text) {
        try { appendFileSync(handles.console, JSON.stringify({ sequence: ++consoleSequence, at: new Date().toISOString(), stream, text }) + '\n'); }
        catch (error) { failure ??= error; }
      }
    }
    for (const handle of Object.values(handles)) {
      try { fsyncSync(handle); } catch (error) { failure ??= error; }
      closeSync(handle);
    }
  }
  Object.assign(summary, result, {
    status: failure || result.exitCode !== 0 || requestedSignal ? 'failed' : 'exited',
    finishedAt: new Date().toISOString(), consoleChunks: consoleSequence,
    ...(failure ? { error: String(failure) } : {}),
  });
  save();
  stdout.write(`Agent development ${summary.status}: ${files.summary}\n`);
  return { summary, exitCode: requestedSignal === 'SIGINT' ? 130 : requestedSignal === 'SIGTERM' ? 143
    : failure ? 1 : typeof result.exitCode === 'number' ? result.exitCode : 1 };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length > 2) throw new Error('start:agent does not accept arguments; configure the data directory with BES_DATA.');
    process.exitCode = (await startAgentDevelopment()).exitCode;
  } catch (error) { console.error(error); process.exitCode = 1; }
}
