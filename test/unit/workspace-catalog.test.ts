import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { FileMaterialService } from '@/materials/service';

let root: string;
let service: FileMaterialService;
beforeEach(async () => {
  const parent = path.resolve('output/workspace-catalog');
  await fs.mkdir(parent, { recursive: true });
  root = await fs.mkdtemp(path.join(parent, 'case-'));
  await fs.writeFile(path.join(root, 'workspace.json'), JSON.stringify({ schemaVersion: 1, projects: [{ id: 'project', objective: 'Original goal' }] }));
  service = new FileMaterialService(root);
});
it('atomically chooses one default copy and retains the explicit selection across restart', async () => {
  const [a, b] = await Promise.all([service.workingDraft('project'), service.workingDraft('project')]);
  expect(a.draftId).toBe(b.draftId);
  const other = await service.createDraft('project', 'human');
  await service.setWorkingDraft('project', other.draftId);
  expect((await new FileMaterialService(root).workingDraft('project')).draftId).toBe(other.draftId);
  expect((await service.listDrafts('project', { limit: 100, maxBytes: 28000 })).items).toHaveLength(2);
});
it('keeps 61 version numbers and chronological pagination stable after restart', async () => {
  const draft = await service.workingDraft('project');
  // Genuine service publication; no test-only file model.
  for (let n = 0; n < 61; n++) await service.publish('project', draft.draftId, n, 'human');
  const first = await service.listRevisions('project', { limit: 50, maxBytes: 28000 });
  const second = await service.listRevisions('project', { limit: 50, maxBytes: 28000, cursor: first.nextCursor });
  const all = [...first.items, ...second.items];
  expect(all).toHaveLength(61);
  expect(all.every(item => item.status === 'available')).toBe(true);
  expect(all.map(item => item.status === 'available' ? item.displayNumber : 0)).toEqual(Array.from({ length: 61 }, (_, n) => 61 - n));
  expect(await new FileMaterialService(root).listRevisions('project', { limit: 50, maxBytes: 28000 })).toEqual(first);
});
it('reports brief-only changes without changing the previous fixed content', async () => {
  const draft = await service.workingDraft('project');
  const v1 = await service.publish('project', draft.draftId, 0, 'human');
  await service.updateDraft('project', draft.draftId, 1, { ...draft.content, taskBrief: { objective: 'New goal', scope: 'Two records' } }, 'human');
  const v2 = await service.publish('project', draft.draftId, 2, 'human');
  const diff = await service.diff('project', v1.revisionId, v2.revisionId, { limit: 50, maxBytes: 28000 });
  expect(diff.items).toEqual([{ collection: 'taskBrief', id: 'taskBrief', change: 'changed', changedFields: ['objective', 'scope'] }]);
  expect((await service.revision('project', v1.revisionId, v1.contentHash)).content.taskBrief?.objective).toBe('Original goal');
});
