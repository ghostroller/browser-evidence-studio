import type { BrowserProjectMetadata, BrowserUpdateProject, BrowserWorkbenchRequest, BrowserWorkbenchState } from '../../contracts/browser-workbench';
import { WorkbenchError, publicError } from './errors';
import { WorkbenchSessions, type WorkbenchSessionContext } from './session';
import { checkJsonBudget, exactKeys, identifier, record, revision, textField } from './validation';

/** The existing business queue must call start exactly once at its actual execution
 * boundary, without an intervening await before beginning the atomic operation.
 * signal only cancels work that has not started; it is not a rollback guarantee.
 */
export interface WorkbenchExecutionPermit {
  readonly signal: AbortSignal;
  start<T>(operation: () => T): T;
}
/** The port retains domain revision checks and operationId idempotency in its
 * existing transaction/queue. The transport neither retries nor deduplicates. */
export interface ProjectMetadataPort {
  readProject(projectId: string, permit: WorkbenchExecutionPermit): Promise<BrowserProjectMetadata>;
  updateProject(input: Readonly<BrowserUpdateProject>, permit: WorkbenchExecutionPermit): Promise<BrowserProjectMetadata>;
}

export function parseWorkbenchRequest(value: unknown): BrowserWorkbenchRequest {
  checkJsonBudget(value);
  const envelope = record(value);
  exactKeys(envelope, ['instanceId', 'method', 'body']);
  const instanceId = identifier(envelope.instanceId);
  const body = record(envelope.body);
  if (envelope.method === 'state') {
    exactKeys(body, ['projectId']);
    return { instanceId, method: 'state', body: { projectId: identifier(body.projectId) } };
  }
  if (envelope.method !== 'updateProject') throw new WorkbenchError('invalid_request');
  exactKeys(body, ['projectId', 'expectedRevision', 'operationId'], ['name', 'objective']);
  if (!Object.hasOwn(body, 'name') && !Object.hasOwn(body, 'objective')) throw new WorkbenchError('invalid_request');
  const input: BrowserUpdateProject = { projectId: identifier(body.projectId), expectedRevision: revision(body.expectedRevision), operationId: identifier(body.operationId) };
  if (Object.hasOwn(body, 'name')) input.name = textField(body.name, 200, true);
  if (Object.hasOwn(body, 'objective')) input.objective = textField(body.objective, 4_000);
  return { instanceId, method: 'updateProject', body: input };
}

function projectDto(value: BrowserProjectMetadata, projectId: string): BrowserProjectMetadata {
  try {
    if (value.id !== projectId) throw new Error();
    // Explicit projection keeps private service fields out of HTTP responses.
    return { id: identifier(value.id), name: textField(value.name, 200, true), objective: textField(value.objective, 4_000), revision: revision(value.revision) };
  } catch { throw new WorkbenchError('internal_error'); }
}

/** No Studio import, generic dispatch, retry, business lock or deduplication here. */
export class WorkbenchDispatcher {
  constructor(private readonly sessions: WorkbenchSessions, private readonly port: ProjectMetadataPort,
    private readonly changed: (projectId: string) => void = () => {}) {}

  async dispatch(value: unknown, context: WorkbenchSessionContext, signal?: AbortSignal): Promise<BrowserWorkbenchState | BrowserProjectMetadata> {
    const request = parseWorkbenchRequest(value);
    this.sessions.assertActive(context);
    if (request.instanceId !== context.instanceId || request.body.projectId !== context.projectId) throw new WorkbenchError('forbidden');
    const controller = new AbortController();
    let started = false;
    let finished = false;
    const cancelPending = () => { if (!started) controller.abort(); };
    const unsubscribe = this.sessions.onInvalidated(context, cancelPending);
    signal?.addEventListener('abort', cancelPending, { once: true });
    if (signal?.aborted) cancelPending();
    const permit: WorkbenchExecutionPermit = Object.freeze({
      signal: controller.signal,
      start: <T>(operation: () => T): T => {
        if (started || finished) throw new WorkbenchError('invalid_request');
        this.sessions.assertActive(context);
        if (controller.signal.aborted || signal?.aborted) throw new WorkbenchError('cancelled');
        started = true;
        return operation();
      },
    });
    try {
      // Guard before enqueue as well as inside the port's actual start boundary.
      this.sessions.assertActive(context);
      if (controller.signal.aborted) throw new WorkbenchError('cancelled');
      const result = request.method === 'state'
        ? await this.port.readProject(request.body.projectId, permit)
        : await this.port.updateProject(Object.freeze(request.body), permit);
      if (!started) throw new WorkbenchError('internal_error');
      const project = projectDto(result, context.projectId);
      // An already-started atomic write completes normally even if revoked or
      // disconnected meanwhile. Never relabel it 'cancelled' or retry it.
      if (request.method === 'updateProject') {
        try { this.changed(context.projectId); } catch { /* Notification failure cannot roll back an atomic write. */ }
        return project;
      }
      this.sessions.assertActive(context);
      return { project };
    } catch (error) { throw publicError(error); }
    finally {
      finished = true;
      unsubscribe();
      signal?.removeEventListener('abort', cancelPending);
    }
  }
}
