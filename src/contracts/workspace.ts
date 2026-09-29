/** Mutable directory metadata never enters immutable material hashes. */
export interface CatalogEntry {
  name: string;
  hidden: boolean;
  note?: string;
  displayNumber?: number;
}
export interface MaterialCatalog {
  schemaVersion: 1;
  catalogRevision: number;
  workingDraftId?: string;
  drafts: Record<string, CatalogEntry>;
  revisions: Record<string, CatalogEntry>;
  recordings: Record<string, CatalogEntry>;
}
export type WorkspaceView = 'checkpoints' | 'archives' | 'implementation';
export type CatalogKind = 'drafts' | 'revisions' | 'recordings';
