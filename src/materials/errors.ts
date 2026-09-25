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
