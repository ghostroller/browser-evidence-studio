import { expect, test, vi } from 'vitest';
import { WorkbenchDispatcher } from '@/main/workbench/dispatch';
import { WorkbenchSessions } from '@/main/workbench/session';
import { parseWebReplayRequest } from '@/main/workbench/replay-port';
const position = { recordingId: 'r', pageId: 'p', documentId: 'd', streamEpoch: 's', sourceTimeMs: 1, eventSeq: 1 };
const request = { instanceId: 'i', method: 'webReplayBundle', body: { projectId: 'p', replayId: 'replay', generation: 1, position } };
test('replay input is exact, bounded and generation/source scoped', () => {
  expect(parseWebReplayRequest(request)).toEqual(request);
  for (const value of [ { ...request, method: 'readResource' }, { ...request, body: { ...request.body, generation: 0 } }, { ...request, body: { ...request.body, token: 'other' } }, { ...request, body: { ...request.body, position: { ...position, frameId: 'x' } } }, { ...request, body: { ...request.body, position: { ...position, recordingId: '../x' } } }, { ...request, method: 'webReplaySelection' } ]) expect(() => parseWebReplayRequest(value)).toThrow();
});
test.each(['project-metadata', 'project-materials', 'project-workbench'] as const)('old %s grant cannot acquire replay data', async grant => {
  const sessions = new WorkbenchSessions({ instanceId: 'i' }); const ticket = sessions.begin('p', grant); const session = sessions.exchange(ticket.ticket, 'i');
  const execute = vi.fn(); const dispatcher = new WorkbenchDispatcher(sessions, {} as any, undefined, undefined, undefined, { execute });
  await expect(dispatcher.dispatch(request, sessions.authenticate(session.token, 'i'))).rejects.toMatchObject({ code: 'forbidden' });
  expect(execute).not.toHaveBeenCalled(); sessions.dispose();
});
test('explicit replay grant rejects foreign project and suppresses late revoked response', async () => {
  const sessions = new WorkbenchSessions({ instanceId: 'i' }); const ticket = sessions.begin('p', 'project-replay'); const session = sessions.exchange(ticket.ticket, 'i');
  const context = sessions.authenticate(session.token, 'i');
  const dispatcher = new WorkbenchDispatcher(sessions, {} as any, undefined, undefined, undefined, { execute: async () => { sessions.revokeProject('p'); return {}; } });
  await expect(dispatcher.dispatch({ ...request, body: { ...request.body, projectId: 'foreign' } }, context)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(dispatcher.dispatch(request, context)).rejects.toMatchObject({ code: 'unauthorized' }); sessions.dispose();
});
