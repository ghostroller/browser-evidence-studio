/** B1.2a's deliberately narrow, JSON-only browser transport contract.
 * This is not WorkbenchClient or the trusted Electron/Agent API surface.
 */
export type BrowserWorkbenchGrant = 'project-metadata' | 'project-materials' | 'project-workbench' | 'project-replay';
export interface BrowserProjectMetadata {
  id: string;
  name: string;
  objective: string;
  revision: number;
}
export interface BrowserProjectScope { projectId: string }
export interface BrowserUpdateProject extends BrowserProjectScope {
  expectedRevision: number;
  operationId: string;
  name?: string;
  objective?: string;
}
export type BrowserWorkbenchRequest =
  | { instanceId: string; method: 'state'; body: BrowserProjectScope }
  | { instanceId: string; method: 'updateProject'; body: BrowserUpdateProject };
export interface BrowserWorkbenchState { project: BrowserProjectMetadata }
export interface BrowserWorkbenchSession {
  token: string;
  grant: BrowserWorkbenchGrant;
  expiresAt: number;
  instanceId: string;
  projectId: string;
}
export interface BrowserWorkbenchTicket { ticket: string; expiresAt: number; instanceId: string }
/** Trusted Electron UI only. Status never contains credentials. */
export interface BrowserWorkbenchPairingStatus {
  enabled: boolean;
  instanceId?: string;
  origin?: string;
  tickets?: number;
  sessions?: number;
}
export interface BrowserWorkbenchPairingBridge {
  status(): Promise<BrowserWorkbenchPairingStatus>;
  begin(projectId: string, grant?: BrowserWorkbenchGrant): Promise<BrowserWorkbenchTicket>;
  revoke(): Promise<void>;
}
export type BrowserWorkbenchErrorCode =
  | 'unauthorized' | 'forbidden' | 'invalid_request' | 'not_found'
  | 'conflict' | 'busy' | 'cancelled' | 'unavailable' | 'internal_error';
export interface BrowserWorkbenchFailure { error: { code: BrowserWorkbenchErrorCode } }
