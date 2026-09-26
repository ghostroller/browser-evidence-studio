import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskAuthorizations } from '@/main/services/task-authorization';

const offline = { origins: [], pages: [], capabilities: ['history-read', 'materials-read'] as const, durationMs: 60_000, maxOperations: 10 };
describe('host task authorization', () => {
  it('reads offline project history without a live browser or directory and cannot acquire browser access', async () => {
    const tasks = new TaskAuthorizations();
    try {
      const grant = await tasks.issue({ projectId: 'one' }, { ...offline, capabilities: [...offline.capabilities] });
      await expect(tasks.run(grant.authorizationId, 'history-read', { projectId: 'one' }, async () => 'read')).resolves.toBe('read');
      await expect(tasks.check(grant.authorizationId, 'history-read', { projectId: 'two' })).rejects.toMatchObject({ code: 'AUTHORIZATION_SCOPE' });
      await expect(tasks.check(grant.authorizationId, 'page-act', { projectId: 'one' })).rejects.toMatchObject({ code: 'AUTHORIZATION_SCOPE' });
    } finally { tasks.close(); }
  });
  it('a revoke at the check/registration microtask boundary prevents the operation', async () => {
    const tasks = new TaskAuthorizations(), operation = vi.fn(async () => 'should never run');
    const grant = await tasks.issue({ projectId: 'one' }, { ...offline, capabilities: [...offline.capabilities] });
    const realCheck = tasks.check.bind(tasks);
    vi.spyOn(tasks, 'check').mockImplementation(async (...args) => { const result = await realCheck(...args); queueMicrotask(() => tasks.revoke(grant.authorizationId)); return result; });
    await expect(tasks.run(grant.authorizationId, 'history-read', { projectId: 'one' }, operation)).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
    expect(operation).not.toHaveBeenCalled(); tasks.close();
  });
  it('revokes in-flight operations and enforces exact page/target/origin and budget', async () => {
    const tasks = new TaskAuthorizations();
    const grant = await tasks.issue({ projectId: 'one', sessionId: 'session', profileId: 'profile' }, { ...offline, origins: ['https://example.test'], pages: [{ pageId: 'page', targetId: 'target' }], capabilities: ['page-read'], maxOperations: 1 });
    const scope = { projectId: 'one', sessionId: 'session', profileId: 'profile', pageId: 'page', targetId: 'target', url: 'https://example.test/path' };
    await expect(tasks.check(grant.authorizationId, 'page-read', { ...scope, targetId: 'other' })).rejects.toMatchObject({ code: 'AUTHORIZATION_PAGE' });
    await expect(tasks.check(grant.authorizationId, 'page-read', { ...scope, url: 'https://other.test/' })).rejects.toMatchObject({ code: 'AUTHORIZATION_ORIGIN' });
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    const pending = tasks.run(grant.authorizationId, 'page-read', scope, signal => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(signal.reason)); entered(); }));
    await ready; tasks.revoke(grant.authorizationId);
    await expect(pending).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' });
    expect(tasks.get(grant.authorizationId).remainingOperations).toBe(0); tasks.close();
  });
  it('requires the registered directory still resolve to the original authorized path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bes-task-')), tasks = new TaskAuthorizations();
    try {
      await mkdir(path.join(root, 'workflow'));
      const grant = await tasks.issue({ projectId: 'one', sessionId: 's', profileId: 'p', directory: path.join(root, 'workflow') }, { ...offline, origins: ['https://example.test'], pages: [{ pageId: 'page', targetId: 'target' }], capabilities: ['execute'] });
      await rename(path.join(root, 'workflow'), path.join(root, 'moved'));
      await expect(tasks.check(grant.authorizationId, 'execute', { projectId: 'one', directory: path.join(root, 'moved') })).rejects.toMatchObject({ code: 'AUTHORIZATION_DIRECTORY' });
    } finally { tasks.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('preserves a committed checkpoint receipt after HTTP cancellation but never after task revocation',async()=>{
    const tasks=new TaskAuthorizations();
    try{
      const grant=await tasks.issue({projectId:'one'},{...offline,capabilities:[...offline.capabilities]});
      const cancelled=new AbortController();
      const receipt={id:'checkpoint-1',metadata:{captureOutcome:'completed'},artifactRefs:['saved']};
      await expect(tasks.run(grant.authorizationId,'history-read',{projectId:'one'},async()=>{cancelled.abort(new Error('HTTP cancelled'));return receipt;},cancelled.signal)).resolves.toEqual(receipt);
      await expect(tasks.run(grant.authorizationId,'history-read',{projectId:'one'},async()=>{tasks.revoke(grant.authorizationId);return receipt;})).rejects.toMatchObject({code:'AUTHORIZATION_REVOKED'});
    }finally{tasks.close();}
  });
});
