import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { resolveSyntheticWorkbenchMode } from '@/main/workbench/synthetic-mode';
import { WorkspaceManagement, type WorkspaceManagementHost } from '@/main/services/workspace-management';
import { WorkbenchSessions } from '@/main/workbench/session';
import { WorkbenchPairing } from '@/main/workbench/pairing';
import { createPairingHandlers } from '@/main/workbench/pairing-ipc';
import { atomicJson } from '@/evidence/files';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
test('normal startup has no synthetic mode; explicit mode requires new empty isolated unpackaged root', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'bes-synthetic-mode-fixture-'));
  const appData = path.join(parent, 'app-data'), root = path.join(parent, 'fresh'); await mkdir(appData); await mkdir(root, { mode: 0o700 });
  const env = { BES_WORKBENCH_SYNTHETIC: '1', BES_WORKBENCH_ORIGIN: 'http://127.0.0.1:43210', BES_DATA: root };
  expect(resolveSyntheticWorkbenchMode({}, appData, false)).toBeUndefined();
  expect(resolveSyntheticWorkbenchMode(env, appData, false)).toEqual({ origin: env.BES_WORKBENCH_ORIGIN, dataRoot: root });
  for (const patch of [{ BES_WORKBENCH_SYNTHETIC: 'true' }, { BES_TEST: '1' }, { BES_DATA: 'relative' }, { BES_DATA: appData },
    { BES_WORKBENCH_ORIGIN: 'http://localhost:43210' }, { BES_WORKBENCH_ORIGIN: 'http://127.0.0.1:43210/path' }]) {
    expect(() => resolveSyntheticWorkbenchMode({ ...env, ...patch }, appData, false)).toThrow();
  }
  expect(() => resolveSyntheticWorkbenchMode(env, appData, true)).toThrow();
  const linked = path.join(parent, 'linked'); await symlink(root, linked);
  expect(() => resolveSyntheticWorkbenchMode({ ...env, BES_DATA: linked }, appData, false)).toThrow();
  await writeFile(path.join(root, 'workspace.json'), '{}');
  expect(() => resolveSyntheticWorkbenchMode(env, appData, false)).toThrow('empty');
});
test('synthetic path validation cannot inspect a normalized empty root then open symlink-dotdot data', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'bes-path-fixture-'));
  const fresh = path.join(parent, 'fresh'), actual = path.join(parent, 'actual');
  await mkdir(fresh, { mode: 0o700 }); await mkdir(path.join(actual, 'sub'), { recursive: true });
  await mkdir(path.join(actual, 'fresh')); await writeFile(path.join(actual, 'fresh', 'sentinel'), 'existing synthetic data');
  await symlink(path.join(actual, 'sub'), path.join(parent, 'redirect'));
  const env = { BES_WORKBENCH_SYNTHETIC: '1', BES_WORKBENCH_ORIGIN: 'http://127.0.0.1:43210', BES_DATA: `${parent}/redirect/../fresh` };
  expect(() => resolveSyntheticWorkbenchMode(env, path.join(parent, 'appData'), false)).toThrow('canonical');
});
async function fixture(write = atomicJson) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bes-pairing-fixture-'));
  const host: WorkspaceManagementHost = { root, projects: [], profiles: [], state: () => ({}) };
  const management = new WorkspaceManagement(host, write); await management.init();
  const project = await management.createProject({ name: 'Dummy pairing fixture' });
  const sessions = new WorkbenchSessions({ instanceId: 'dummy-instance' }); cleanups.push(() => sessions.dispose());
  const pairing = new WorkbenchPairing(sessions, management, 'http://127.0.0.1:43111');
  const frame = { url: 'file:///trusted/index.html' };
  const sender = { isDestroyed: () => false, mainFrame: frame };
  const visibility = { minimized: false, visible: true };
  const window = { uiUrl: frame.url, window: { isDestroyed: () => false, isMinimized: () => visibility.minimized, isVisible: () => visibility.visible, webContents: sender } };
  const event = { sender, senderFrame: frame } as Parameters<ReturnType<typeof createPairingHandlers>['status']>[0];
  let closing = false;
  const handlers = createPairingHandlers(window as Parameters<typeof createPairingHandlers>[0], pairing, () => closing);
  return { host, project, management, sessions, pairing, frame, sender, window, event, handlers, visibility, close: () => { closing = true; } };
}
test('pairing uses exact trusted live main frame for all three channels, with no generic dispatch', async () => {
  const f = await fixture();
  const untrusted = { ...f.event, senderFrame: { ...f.frame } } as typeof f.event;
  expect(() => f.handlers.status(untrusted)).toThrow('forbidden');
  expect(() => f.handlers.begin(untrusted, { projectId: f.project.id })).toThrow('forbidden');
  expect(() => f.handlers.revoke(untrusted)).toThrow('forbidden');
  const ticket = await f.handlers.begin(f.event, { projectId: f.project.id });
  const session = f.sessions.exchange(ticket.ticket, ticket.instanceId);
  const status = f.handlers.status(f.event);
  expect(status).toEqual({ enabled: true, instanceId: 'dummy-instance', origin: 'http://127.0.0.1:43111', tickets: 0, sessions: 1 });
  expect(JSON.stringify(status)).not.toContain(session.token);
  f.handlers.revoke(f.event); expect(() => f.sessions.authenticate(session.token, ticket.instanceId)).toThrow('unauthorized');
  f.close(); expect(() => f.handlers.status(f.event)).toThrow('forbidden');
});
test('pairing validates scope and extra fields; issuing again revokes prior session', async () => {
  const f = await fixture();
  await expect(f.handlers.begin(f.event, { projectId: f.project.id, source: 'ui' })).rejects.toThrow('invalid_request');
  await expect(f.handlers.begin(f.event, { projectId: 'missing' })).rejects.toThrow();
  const first = await f.handlers.begin(f.event, { projectId: f.project.id });
  const session = f.sessions.exchange(first.ticket, first.instanceId);
  await f.handlers.begin(f.event, { projectId: f.project.id });
  expect(() => f.sessions.authenticate(session.token, session.instanceId)).toThrow('unauthorized');
  const disabled = createPairingHandlers(f.window as Parameters<typeof createPairingHandlers>[0], undefined, () => false);
  expect(disabled.status(f.event)).toEqual({ enabled: false });
  expect(() => disabled.begin(f.event, { projectId: f.project.id })).toThrow('unavailable');
});
test('a late begin cannot reauthorize a minimized or hidden issuer, while revoke remains available', async () => {
  const f = await fixture();
  f.visibility.minimized = true; f.handlers.revoke(f.event);
  expect(() => f.handlers.begin(f.event, { projectId: f.project.id })).toThrow('forbidden');
  f.visibility.minimized = false; f.visibility.visible = false;
  expect(() => f.handlers.begin(f.event, { projectId: f.project.id })).toThrow('forbidden');
  expect(() => f.handlers.revoke(f.event)).not.toThrow();
  f.visibility.visible = true;
  const pending = f.handlers.begin(f.event, { projectId: f.project.id }); f.visibility.minimized = true;
  await expect(pending).rejects.toThrow('forbidden');
  expect(f.sessions.counts).toMatchObject({ tickets: 0, sessions: 0 });
});
test('close/revoke or sender reload during a queued begin cannot issue a late ticket', async () => {
  let hold = false, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(async (file, value) => { if (hold) { entered(); await gate; } await atomicJson(file, value); });
  hold = true;
  const native = f.management.updateProject({ projectId: f.project.id, expectedRevision: 1, name: 'Native' }); await reached;
  const pending = f.handlers.begin(f.event, { projectId: f.project.id });
  const denied = expect(pending).rejects.toThrow('cancelled');
  f.handlers.revoke(f.event); release(); await native; await denied;
  expect(f.sessions.counts).toMatchObject({ tickets: 0, sessions: 0 });
  const second = f.handlers.begin(f.event, { projectId: f.project.id });
  f.frame.url = 'https://untrusted.example/'; await expect(second).rejects.toThrow('forbidden');
  expect(f.sessions.counts).toMatchObject({ tickets: 0, sessions: 0 });
});
