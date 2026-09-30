/** Project-scoped material authoring contract. It deliberately excludes Studio
 * state, capture, replay surfaces, raw resources, profiles and Agent authority. */
import type { BoundedPage } from './recording';
import type { MaterialDraftView, ProjectReadBudget, ProjectScope, WorkbenchProjectMethods } from './workbench-project';

export const BROWSER_MATERIAL_METHODS = [
  'materialCatalog', 'manageMaterialCatalog', 'workingMaterialDraft', 'setWorkingMaterialDraft',
  'materialDrafts', 'materialRevisions', 'materialDraft', 'materialRevision', 'materialCollection', 'materialEntity',
  'createMaterialDraft', 'copyMaterialDraft', 'editMaterialDraft', 'publishMaterialDraft', 'materialPublicationStatus',
  'prepareMaterialArchive', 'materialDiff', 'materialDraftDiff', 'recordingStreams', 'recordingPositions', 'materialRecordings',
] as const;
export type BrowserMaterialMethod = typeof BROWSER_MATERIAL_METHODS[number];
export interface BrowserRecordingSummary { recordingId: string; sealedAt: string; }
export type BrowserMaterialMethods = Pick<WorkbenchProjectMethods, Exclude<BrowserMaterialMethod, 'workingMaterialDraft' | 'materialRecordings'>> & {
  /** May ensure/create the working copy and repair its catalog. A write grant is required. */
  workingMaterialDraft: { input: ProjectScope; result: MaterialDraftView };
  materialRecordings: { input: ProjectScope & ProjectReadBudget; result: BoundedPage<BrowserRecordingSummary> };
};
export type BrowserMaterialInput<M extends BrowserMaterialMethod> = BrowserMaterialMethods[M]['input'];
export type BrowserMaterialResult<M extends BrowserMaterialMethod> = BrowserMaterialMethods[M]['result'];
export type BrowserMaterialRequest = { [M in BrowserMaterialMethod]: { instanceId: string; method: M; body: BrowserMaterialInput<M> } }[BrowserMaterialMethod];
export const BROWSER_MATERIAL_WRITE_METHODS: readonly BrowserMaterialMethod[] = [
  'workingMaterialDraft', 'materialCatalog', 'materialDrafts', 'materialRevisions', // Existing catalog migration/repair semantics.
  'manageMaterialCatalog', 'setWorkingMaterialDraft', 'createMaterialDraft', 'copyMaterialDraft', 'editMaterialDraft', 'publishMaterialDraft',
];
/** Independent bounded JSON envelope; collection budgets remain 1–28 KiB. */
export const BROWSER_MATERIAL_BUDGET = Object.freeze({ requestBytes: 65_536, responseBytes: 262_144, depth: 24, nodes: 8_192 });
