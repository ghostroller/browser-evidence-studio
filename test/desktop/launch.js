import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import electron from 'electron';

const root = path.resolve('output/desktop-' + Date.now());
fs.mkdirSync(root, { recursive: true });
const baseEnv = { ...process.env, BES_TEST: '1', BES_DATA: root };
delete baseEnv.ELECTRON_RUN_AS_NODE;
const soakArgument = process.argv.findLast(argument => argument.startsWith('--soak='));
if (soakArgument) {
  const minutes = Number(soakArgument.slice('--soak='.length));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) throw new Error('Soak duration must be 1–60 minutes');
  baseEnv.BES_SOAK_MINUTES = String(minutes);
}
const executableArgument = process.argv.find(argument => argument.startsWith('--executable='));
const executable = executableArgument ? path.resolve(executableArgument.slice('--executable='.length)) : electron;
const development = process.argv.includes('--dev');
const startupOnly = process.argv.includes('--startup-only');
if (development && (!startupOnly || executableArgument)) throw new Error('--dev requires --startup-only and cannot use --executable');

function launchPhase(phase, timeoutMs, { dataRoot = root, extraEnv = {}, terminateAtReady = false } = {}) {
  return new Promise(resolve => {
    fs.mkdirSync(dataRoot, { recursive: true });
    const resultName = phase === 'main' ? 'test-result.json' : `${phase}-result.json`;
    const logName = phase === 'main' ? 'desktop.log' : `${phase}.log`;
    const log = fs.createWriteStream(path.join(dataRoot, logName), { flags: 'wx' });
    const launchedAt = Date.now();
    const child = spawn(development ? process.execPath : executable, development ? [path.resolve('node_modules/@electron-forge/cli/dist/electron-forge.js'), 'start'] : executableArgument ? [] : ['.'], {
      env: { ...baseEnv, BES_DATA: dataRoot, BES_TEST_PHASE: phase, ...(phase !== 'main' ? { BES_SOAK_MINUTES: '0' } : {}), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let timedOut = false, spawnError, settled = false, forcedAtBoundary = false, markerBuffer = '';
    const consume = (chunk, destination) => { log.write(chunk); destination.write(chunk); };
    child.stdout.on('data', chunk => {
      consume(chunk, process.stdout);
      if (!terminateAtReady || forcedAtBoundary) return;
      markerBuffer = (markerBuffer + chunk.toString()).slice(-8192);
      if (!markerBuffer.split(/\r?\n/).includes('BES_RECOVERY_READY')) return;
      try {
        const cut = JSON.parse(fs.readFileSync(path.join(dataRoot, 'recovery-cut.json'), 'utf8'));
        assert.equal(cut.processId, child.pid); assert.equal(cut.stage, extraEnv.BES_RECOVERY_STAGE);
        forcedAtBoundary = true; child.kill('SIGKILL');
      } catch (error) { spawnError = 'Invalid crash boundary: ' + String(error); child.kill('SIGKILL'); }
    });
    child.stderr.on('data', chunk => consume(chunk, process.stderr));
    const timeout = setTimeout(() => {
      timedOut = true;
      console.error(`Desktop phase ${phase} exceeded ${timeoutMs} ms; terminating its own Electron process.`);
      if (development && process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      else child.kill();
    }, timeoutMs);
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      log.end();
      let result, reportError, lifecycle, lastSoakProgress;
      try { result = JSON.parse(fs.readFileSync(path.join(dataRoot, resultName), 'utf8')); }
      catch (error) { reportError = `No complete ${phase} report: ${String(error)}`; }
      try {
        const latest = JSON.parse(fs.readFileSync(path.join(dataRoot, 'diagnostics/latest.json'), 'utf8'));
        if (latest.processId === child.pid || (development && Date.parse(latest.startedAt) >= launchedAt)) lifecycle = latest;
      } catch { /* Missing diagnostics remain unknown, never evidence of success. */ }
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(dataRoot, 'soak-progress.json'), 'utf8'));
        lastSoakProgress = { recordedStatus: saved.status, elapsedMs: saved.elapsedMs, cycles: saved.cycles, minutes: saved.minutes };
      } catch { /* A short phase has no soak progress. */ }
      const expectedPid = development ? lifecycle?.processId : child.pid;
      const passed = !timedOut && !spawnError && code === 0 && result?.passed === true && result.phase === phase && result.processId === expectedPid &&
        (!development || (Date.parse(result.startedAt) >= launchedAt && lifecycle?.stage === 'shutdown-complete' && lifecycle.details.exitCode === 0));
      resolve({ phase, pid: child.pid, exitCode: code, signal, timedOut, passed, forcedAtBoundary, result, lifecycle, lastSoakProgress, error: spawnError || reportError });
    };
    child.once('error', error => { spawnError = String(error); finish(null, null); });
    // `close` follows process exit AND stream closure. A second Electron cannot
    // start until the first process released its profile lock and fixture port.
    child.once('close', finish);
  });
}

async function main() {
  if (startupOnly) {
    const summary = { passed: false, output: root, development, phases: [] };
    try {
      // Same isolated data/cache directory: a cold start, a warm start and a failed-module reload.
      for (const phase of ['startup-cold', 'startup-warm', 'startup-reload', 'startup-failed']) {
        const result = await launchPhase(phase, 60000);
        summary.phases.push(result);
        if (phase === 'startup-failed') {
          assert.equal(result.passed, false); assert.equal(result.timedOut, false);
          assert.equal(result.lifecycle?.stage, 'shutdown-complete');
          assert.equal(result.lifecycle.details.reason, 'startup-failed');
          assert.equal(result.lifecycle.details.exitCode, 1);
          const events = fs.readFileSync(path.join(root, 'diagnostics', result.lifecycle.file), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
          assert(!events.some(event => event.stage === 'ui-ready'), 'Missing modules cannot announce a ready UI');
          const failure = events.find(event => event.stage === 'ui-startup-failed');
          assert.equal(failure?.details.documentReady, true);
          assert.equal(failure.details.needsBounds, true);
          assert.equal(failure.details.boundsReports, 0);
          result.expectedFailureVerified = true;
          continue;
        }
        assert(result.passed, `${phase} failed: ${result.error || result.result?.error || result.lifecycle?.details?.reason}`);
      }
      summary.passed = true;
    } catch (error) { summary.error = String(error); }
    fs.writeFileSync(path.join(root, 'startup-summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ passed: summary.passed, output: root, development, phases: summary.phases.map(({ phase, passed, expectedFailureVerified, result }) => ({ phase, passed, expectedFailureVerified, processId: result?.processId })), error: summary.error }, null, 2));
    process.exitCode = summary.passed ? 0 : 1;
    return;
  }
  const summary = { passed: false, output: root, main: null, profileRestart: { passed: false, status: 'not-run' }, recovery: [], exitDiagnostics: [] };
  try {
    if (!process.argv.includes('--recovery-only')) {
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
    let expectSoak;
    if (soakMinutes > 0) {
      const soak = JSON.parse(fs.readFileSync(path.join(root, 'soak-result.json'), 'utf8'));
      assert.equal(soak.schemaVersion, 2); assert.equal(soak.passed, true);
      assert.equal(soak.processId, summary.main.pid); assert.equal(soak.minutes, soakMinutes);
      assert.ok(typeof soak.runId === 'string' && soak.runId.length > 0);
      assert.ok(soak.elapsedMs >= soakMinutes * 60000, 'The first process must complete the requested soak duration');
      assert.equal(soak.evidenceSnapshot?.runId, soak.runId);
      assert.deepEqual(soak.evidenceSnapshot?.checkpointIds, soak.checkpointIds);
      expectSoak = { processId: summary.main.pid, runId: soak.runId, minutes: soakMinutes };
    }
    console.log(`Starting a second Electron process with the same BES_DATA and synthetic origin ${before.siteOrigin}.`);
    const restarted = await launchPhase('profile-restart', 120000, { extraEnv: { BES_EXPECT_SOAK: expectSoak ? JSON.stringify(expectSoak) : '' } });
    summary.profileRestart = { ...restarted, status: restarted.passed ? 'completed' : 'failed' };
    if (!restarted.passed) throw new Error('The second Electron process did not produce a successful fresh restart result.');
    const after = JSON.parse(fs.readFileSync(path.join(root, 'profile-restart-state.json'), 'utf8'));
    if (restarted.pid === summary.main.pid || restarted.result.originalProcessId !== summary.main.pid || restarted.result.fixturePort !== before.fixturePort ||
        after.restartStatus !== 'passed' || after.originalProcessId !== summary.main.pid || after.restartProcessId !== restarted.pid ||
        after.siteOrigin !== before.siteOrigin || !after.restartVerifiedAt) {
      throw new Error('Restart result identity, fixture origin, or persisted verification state does not match both actual Electron processes.');
    }
    if (expectSoak) {
      assert.equal(restarted.result.soak?.passed, true, 'The second process must explicitly verify the long-run evidence');
      assert.equal(restarted.result.soak.originalProcessId, expectSoak.processId);
      assert.equal(restarted.result.soak.processId, restarted.pid);
      assert.equal(restarted.result.soak.runId, expectSoak.runId);
      assert.equal(restarted.result.soak.minutes, expectSoak.minutes);
    }
    }
    // Keep each crash case in its own synthetic workspace. The main program is
    // forcibly ended at a durable boundary, then reopened twice with fresh PIDs.
    for (const stage of ['registered-before-worker', 'running', 'waiting-human', 'report-before-terminal', 'terminal-before-catalog']) {
      const dataRoot = path.join(root, 'recovery-' + stage);
      const crash = await launchPhase('recovery-crash', 90000, { dataRoot, extraEnv: { BES_RECOVERY_STAGE: stage }, terminateAtReady: true });
      const entry = { stage, passed: false, crash }; summary.recovery.push(entry);
      assert.equal(crash.forcedAtBoundary, true, `The ${stage} writer must reach its acknowledged boundary before termination`);
      assert.equal(crash.timedOut, false); assert.equal(crash.passed, false);
      assert.equal(crash.lifecycle?.stage, 'recovery-test-cut');
      // A missing or corrupt convenience catalog cannot hide authoritative run evidence.
      if (stage === 'terminal-before-catalog') fs.writeFileSync(path.join(dataRoot, 'validations.json'), '{incomplete-catalog');
      else if (fs.existsSync(path.join(dataRoot, 'validations.json'))) fs.unlinkSync(path.join(dataRoot, 'validations.json'));
      entry.reopened = await launchPhase('recovery-verify', 90000, { dataRoot });
      assert.equal(entry.reopened.passed, true, `First reopen failed after ${stage}: ${entry.reopened.error || entry.reopened.result?.error}`);
      entry.repeated = await launchPhase('recovery-repeat', 90000, { dataRoot });
      assert.equal(entry.repeated.passed, true, `Repeated reopen failed after ${stage}: ${entry.repeated.error || entry.repeated.result?.error}`);
      assert.notEqual(entry.reopened.pid, crash.pid); assert.notEqual(entry.repeated.pid, entry.reopened.pid);
      entry.passed = true;
    }
    for (const [phase, reason] of [['exit-window-close', 'window-close'], ['exit-app-quit', 'app-quit']]) {
      const dataRoot = path.join(root, phase);
      const closed = await launchPhase(phase, 30000, { dataRoot });
      summary.exitDiagnostics.push(closed);
      assert.equal(closed.exitCode, 0); assert.equal(closed.timedOut, false);
      assert.equal(closed.passed, false, 'An intentional exit with no completed test report must never count as a passed test');
      assert.equal(closed.lifecycle?.stage, 'shutdown-complete'); assert.equal(closed.lifecycle?.details?.reason, reason);
      const events = fs.readFileSync(path.join(dataRoot, 'diagnostics', closed.lifecycle.file), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
      const verified = events.filter(event => event.processId === closed.pid && event.stage === 'exit-reentry-verified');
      assert.equal(verified.length, 1); assert.equal(verified[0].details.closeCalls, 1); assert.equal(verified[0].details.materialCount, 2);
      closed.reentry = verified[0].details;
    }
    summary.passed = true;
  } catch (error) {
    summary.error = String(error);
    console.error(summary.error);
  } finally {
    fs.writeFileSync(path.join(root, 'desktop-summary.json'), JSON.stringify(summary, null, 2));
    const phaseSummary = phase => phase && ({ phase: phase.phase, pid: phase.pid, passed: phase.passed, exitCode: phase.exitCode, signal: phase.signal, timedOut: phase.timedOut });
    console.log(JSON.stringify({ passed: summary.passed, output: root, main: phaseSummary(summary.main), profileRestart: phaseSummary(summary.profileRestart), soakRestart: summary.profileRestart.result?.soak,
      recovery: summary.recovery.map(entry => ({ stage: entry.stage, passed: entry.passed, crash: phaseSummary(entry.crash), reopened: phaseSummary(entry.reopened), repeated: phaseSummary(entry.repeated) })),
      exitDiagnostics: summary.exitDiagnostics.map(entry => ({ ...phaseSummary(entry), reason: entry.lifecycle?.details?.reason, reentry: entry.reentry })), error: summary.error }, null, 2));
    process.exitCode = summary.passed ? 0 : 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
