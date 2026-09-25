export { FileMaterialService, materialContentHash } from './service';
export type { MaterialSourceVerifier } from './service';
export { copyCheckpoint, moveCheckpoint, removeCheckpoint } from './edit';
export { projectLegacyRecording } from './legacy';
export type { LegacyCheckpointProjection, LegacyMaterialPage } from './legacy';
export { MaterialError, MaterialConflictError, MaterialPartialPublishError } from './errors';
