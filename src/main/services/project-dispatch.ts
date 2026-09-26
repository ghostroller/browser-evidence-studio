import type { Studio } from './studio';
import type { TaskCapability } from './task-authorization';
import { MATERIAL_COLLECTIONS, materialBudget, materialSummary } from './project-materials';
import { parseReplayPosition } from '@/contracts/recording';
import { ensure } from '@/shared/errors';

export const PROJECT_METHODS = new Set(['taskAuthorizations', 'authorizeTask', 'revokeTask', 'taskChanges', 'materialDrafts', 'materialRevisions', 'materialDraft', 'materialRevision', 'materialCollection', 'createMaterialDraft', 'editMaterialDraft', 'publishMaterialDraft', 'materialDiff', 'recordingStreams', 'recordingForeground', 'recordingPositions', 'resolveRecordingTime', 'historicalState', 'historicalNode', 'historicalLocators', 'execution', 'executionItems', 'datasetBatches', 'datasetRecords', 'assessExecution', 'executionReport', 'executionReportItems', 'reviewExecution']);
const EDIT = new Set(['createMaterialDraft', 'editMaterialDraft', 'publishMaterialDraft']);
const HISTORY = new Set(['recordingStreams', 'recordingForeground', 'recordingPositions', 'resolveRecordingTime', 'historicalState', 'historicalNode', 'historicalLocators']);
const RESULTS = new Set(['execution','executionItems','datasetBatches','datasetRecords','assessExecution','executionReport','executionReports','executionReportItems','reviewExecution']);
for(const method of RESULTS)PROJECT_METHODS.add(method);

/** B's writer/version guard serializes material changes. Historical reads never
 * enter Studio's browser-operation queue or change the selected live page. */
export async function dispatchProject(studio: Studio, method: string, body: any, source: 'api' | 'ui', signal?: AbortSignal): Promise<unknown> {
  ensure(typeof body.projectId === 'string' && studio.projects.some(project => project.id === body.projectId), 'Unknown project', 404);
  if (method === 'authorizeTask') { ensure(source === 'ui', 'Only the trusted client can authorize a task', 403); return studio.authorizeTask(body); }
  if (method === 'revokeTask') { ensure(source === 'ui', 'Only the trusted client can revoke task authorization', 403); return studio.revokeTask(body); }
  // Discovery reveals scope and status, never a browser credential or API token.
  if (method === 'taskAuthorizations') return { instanceId: studio.instanceId, items: studio.tasks.list(body.projectId) };
  const capability: TaskCapability = EDIT.has(method) ? 'materials-edit' : HISTORY.has(method) ? 'history-read' : RESULTS.has(method) ? 'results-read' : 'materials-read';
  const perform = async (operationSignal?: AbortSignal) => {
    operationSignal?.throwIfAborted();
    const service = studio.materials.service, budget = materialBudget(body);
    switch (method) {
      case 'execution': return studio.executions.summary(body.projectId,body.executionId);
      case 'executionItems': return studio.executions.items(body.projectId,body.executionId,body.collection,budget);
      case 'datasetBatches': return studio.executions.batches(body.projectId,{executionId:body.executionId,attemptId:body.attemptId,datasetId:body.datasetId},budget);
      case 'datasetRecords': return studio.executions.records(body.projectId,{executionId:body.executionId,attemptId:body.attemptId,datasetId:body.datasetId},body.batchId,body);
      case 'assessExecution': return studio.executions.assess(body.projectId,body.executionId,body.datasetIdentities);
      case 'executionReport': return studio.executions.reportSummary(body.projectId,body.executionId,body.reportId);
      case 'executionReports': return studio.executions.reports(body.projectId,body.executionId,budget);
      case 'executionReportItems': return studio.executions.reportItems(body.projectId,body.executionId,body.reportId,body.collection,budget);
      case 'reviewExecution': ensure(source==='ui','Human reviews must originate in the trusted client',403);return studio.executions.review(body.projectId,body.executionId,body.reportId,body);
      case 'taskChanges': return { instanceId: studio.instanceId, ...studio.tasks.changes(body.projectId, body.afterSequence ?? 0, budget.limit) };
      case 'materialDrafts': return service.listDrafts(body.projectId, budget);
      case 'materialRevisions': return service.listRevisions(body.projectId, budget);
      case 'materialDraft': return materialSummary(await service.getDraft(body.projectId, body.draftId));
      case 'materialRevision': ensure(typeof body.contentHash === 'string', 'Fixed revision contentHash is required'); return materialSummary(await service.revision(body.projectId, body.revisionId, body.contentHash));
      case 'materialCollection': {
        ensure(MATERIAL_COLLECTIONS.includes(body.collection), 'Unknown material collection');
        ensure(body.kind === 'draft' || body.kind === 'revision', 'Choose draft or revision');
        if (body.kind === 'revision') ensure(typeof body.contentHash === 'string', 'Fixed revision contentHash is required');
        return service.pageCollection(body.projectId, { kind: body.kind, id: body.kind === 'draft' ? body.draftId : body.revisionId, expectedHash: body.contentHash }, body.collection, budget);
      }
      case 'createMaterialDraft': return materialSummary(await service.createDraft(body.projectId, source === 'api' ? 'agent' : 'human', body.baseRevisionId));
      case 'editMaterialDraft': {
        const result = await studio.materials.edit(body.projectId, body.draftId, body.expectedDraftRevision, body.edits, source);
        if (result.status === 'saved') studio.tasks.publish(body.projectId, 'material-draft-saved', { draftId: body.draftId, draftRevision: String(result.draft!.draftRevision) });
        return result;
      }
      case 'publishMaterialDraft': {
        const draft = await service.getDraft(body.projectId, body.draftId);
        ensure(source === 'ui' || draft.author === 'agent', 'Agent may publish its candidate draft only', 403);
        const revision = await service.publish(body.projectId, body.draftId, body.expectedDraftRevision, source === 'api' ? 'agent' : 'human');
        studio.tasks.publish(body.projectId, 'material-revision-published', { revisionId: revision.revisionId, contentHash: revision.contentHash });
        return materialSummary(revision);
      }
      case 'materialDiff': return service.diff(body.projectId, body.fromRevisionId, body.toRevisionId, budget);
      case 'recordingStreams': return (await studio.materials.replay(body.recordingId, body.projectId)).archive.streams(budget.limit, body.cursor);
      case 'recordingForeground': return (await studio.materials.replay(body.recordingId, body.projectId)).archive.foreground(budget.limit, body.cursor);
      case 'recordingPositions': {
        const position = parseReplayPosition(body.position);
        return (await studio.materials.replay(position.recordingId, body.projectId)).archive.positions(position, budget.limit, body.ordinal ?? 0);
      }
      case 'resolveRecordingTime': {
        const position = parseReplayPosition(body.position);
        return (await studio.materials.replay(position.recordingId, body.projectId)).archive.resolveTime(position, body.sourceTimeMs);
      }
      case 'historicalState': {
        const position = parseReplayPosition(body.position);
        return (await studio.materials.replay(position.recordingId, body.projectId)).state(position, budget, operationSignal);
      }
      case 'historicalNode': case 'historicalLocators': {
        const position = parseReplayPosition(body.target?.position);
        const replay = await studio.materials.replay(position.recordingId, body.projectId);
        return method === 'historicalNode' ? replay.node(body.target, budget, operationSignal) : replay.locators(body.target, budget, operationSignal);
      }
      default: ensure(false, 'Unknown project operation', 404);
    }
  };
  return source === 'ui' ? perform(signal) : studio.tasks.run(body.authorizationId, capability, { projectId: body.projectId }, perform, signal);
}
