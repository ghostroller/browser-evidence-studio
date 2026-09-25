import type { TaskMaterialDraft } from '@/contracts/materials';

export class MaterialError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 422) {
    super(message);
    this.name = 'MaterialError';
  }
}

export class MaterialConflictError extends MaterialError {
  constructor(public readonly current: TaskMaterialDraft, public readonly expectedDraftRevision: number) {
    super('DRAFT_CONFLICT', 'The draft changed before this operation.', 409);
    this.name = 'MaterialConflictError';
  }
}

export class MaterialPartialPublishError extends MaterialError {
  constructor(public readonly revisionId: string, public readonly contentHash: string, cause: unknown) {
    super('PUBLISH_DRAFT_ADVANCE_FAILED', 'The immutable revision was saved, but the draft did not advance. Inspect the revision before retrying.', 500);
    this.name = 'MaterialPartialPublishError';
    this.cause = cause;
  }
}
