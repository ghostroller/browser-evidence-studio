const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve('output/desktop-' + Date.now());
fs.mkdirSync(root, { recursive: true });
const baseEnv = { ...process.env, BES_TEST: '1', BES_DATA: root };
delete baseEnv.ELECTRON_RUN_AS_NODE;
const soakArgument = process.argv.find(argument => argument.startsWith('--soak='));
if (soakArgument) {
  const minutes = Number(soakArgument.slice('--soak='.length));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) throw new Error('Soak duration must be 1–60 minutes');
  baseEnv.BES_SOAK_MINUTES = String(minutes);
}
const executableArgument = process.argv.find(argument => argument.startsWith('--executable='));
const executable = executableArgument ? path.resolve(executableArgument.slice('--executable='.length)) : require('electron');

function launchPhase(phase, timeoutMs) {
  return new Promise(resolve => {
    const resultName = phase === 'main' ? 'test-result.json' : 'profile-restart-result.json';
    const logName = phase === 'main' ? 'desktop.log' : 'profile-restart.log';
    const log = fs.createWriteStream(path.join(root, logName), { flags: 'wx' });
    const child = spawn(executable, executableArgument ? [] : ['.'], {
      env: { ...baseEnv, BES_TEST_PHASE: phase, ...(phase === 'profile-restart' ? { BES_SOAK_MINUTES: '0' } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let timedOut = false, spawnError, settled = false;
    const consume = (chunk, destination) => { log.write(chunk); destination.write(chunk); };
    child.stdout.on('data', chunk => consume(chunk, process.stdout));
    child.stderr.on('data', chunk => consume(chunk, process.stderr));
    const timeout = setTimeout(() => {
      timedOut = true;
      console.error(`Desktop phase ${phase} exceeded ${timeoutMs} ms; terminating its own Electron process.`);
      child.kill();
    }, timeoutMs);
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      log.end();
      let result, reportError;
      try { result = JSON.parse(fs.readFileSync(path.join(root, resultName), 'utf8')); }
      catch (error) { reportError = `No complete ${phase} report: ${String(error)}`; }
      const passed = !timedOut && !spawnError && code === 0 && result?.passed === true && result.phase === phase && result.processId === child.pid;
      resolve({ phase, pid: child.pid, exitCode: code, signal, timedOut, passed, result, error: spawnError || reportError });
    };
    child.once('error', error => { spawnError = String(error); finish(null, null); });
    // `close` follows process exit AND stream closure. A second Electron cannot
    // start until the first process released its profile lock and fixture port.
    child.once('close', finish);
  });
}

async function main() {
  const summary = { passed: false, output: root, main: null, profileRestart: { passed: false, status: 'not-run' } };
  try {
    const soakMinutes = Math.max(0, Number(baseEnv.BES_SOAK_MINUTES) || 0);
    summary.main = await launchPhase('main', 300000 + soakMinutes * 60000);
    if (!summary.main.passed) throw new Error('The initial desktop process failed; profile restart was not attempted.');

    const before = JSON.parse(fs.readFileSync(path.join(root, 'profile-restart-state.json'), 'utf8'));
    if (before.schemaVersion !== 1 || before.restartStatus !== 'not-run' || before.originalProcessId !== summary.main.pid) {
      throw new Error('The first process did not save a fresh profile-restart checkpoint with its actual PID.');
    }
    if (!Number.isSafeInteger(before.fixturePort) || before.fixturePort < 1 || before.fixturePort > 65535 || before.siteOrigin !== `http://127.0.0.1:${before.fixturePort}`) {
      throw new Error('The saved synthetic fixture origin/port is invalid.');
    }
    console.log(`Starting a second Electron process with the same BES_DATA and synthetic origin ${before.siteOrigin}.`);
    const restarted = await launchPhase('profile-restart', 120000);
    summary.profileRestart = { ...restarted, status: restarted.passed ? 'completed' : 'failed' };
    if (!restarted.passed) throw new Error('The second Electron process did not produce a successful fresh restart result.');
    const after = JSON.parse(fs.readFileSync(path.join(root, 'profile-restart-state.json'), 'utf8'));
    if (restarted.pid === summary.main.pid || restarted.result.originalProcessId !== summary.main.pid || restarted.result.fixturePort !== before.fixturePort ||
        after.restartStatus !== 'passed' || after.originalProcessId !== summary.main.pid || after.restartProcessId !== restarted.pid ||
        after.siteOrigin !== before.siteOrigin || !after.restartVerifiedAt) {
      throw new Error('Restart result identity, fixture origin, or persisted verification state does not match both actual Electron processes.');
    }
    summary.passed = true;
  } catch (error) {
    summary.error = String(error);
    console.error(summary.error);
  } finally {
    fs.writeFileSync(path.join(root, 'desktop-summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = summary.passed ? 0 : 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
