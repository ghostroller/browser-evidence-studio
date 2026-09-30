import type { BrowserWorkbenchPairingStatus, BrowserWorkbenchTicket } from '../../contracts/browser-workbench';
import type { WorkspaceManagement } from '../services/workspace-management';
import { WorkbenchError } from './errors';
import { WorkbenchSessions } from './session';
import { exactKeys, identifier, record } from './validation';

/** No HTTP route can access this issuer. The IPC owner checks trusted sender on
 * every call, and again after the queued project read before issuing a ticket. */
export class WorkbenchPairing {
  private generation = 0;
  constructor(private readonly sessions: WorkbenchSessions, private readonly management: WorkspaceManagement,
    private readonly origin: string) {}
  status(): BrowserWorkbenchPairingStatus {
    const { tickets, sessions } = this.sessions.counts;
    return { enabled: true, instanceId: this.sessions.instanceId, origin: this.origin, tickets, sessions };
  }
  async begin(input: unknown, assertTrusted: () => void): Promise<BrowserWorkbenchTicket> {
    const body = record(input); exactKeys(body, ['projectId'], ['grant']); const projectId = identifier(body.projectId);
    const grant = body.grant ?? 'project-metadata';
    if (grant !== 'project-metadata' && grant !== 'project-materials' && grant !== 'project-workbench') throw new WorkbenchError('invalid_request');
    this.revoke(); const generation = this.generation;
    await this.management.readProject(projectId, { start: operation => { assertTrusted(); return operation(); } });
    assertTrusted();
    if (generation !== this.generation) throw new WorkbenchError('cancelled');
    return this.sessions.begin(projectId, grant);
  }
  revoke(): void { this.generation++; this.sessions.revokeIssuer(); }
}
