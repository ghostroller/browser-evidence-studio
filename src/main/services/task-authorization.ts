import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { StudioError } from '@/shared/errors';

export const TASK_CAPABILITIES = ['materials-read', 'materials-edit', 'history-read', 'page-read', 'page-act', 'page-create', 'execute', 'results-read', 'handoff-export'] as const;
export type TaskCapability = typeof TASK_CAPABILITIES[number];
export interface TaskAuthorization {
  authorizationId: string; projectId: string; sessionId?: string; profileId?: string;
  directory?: string; origins: string[]; pages: Array<{ pageId: string; targetId: string }>;
  capabilities: TaskCapability[]; issuedAt: string; expiresAt: string;
  maxOperations: number; remainingOperations: number; issuer: 'human';
  status: 'active' | 'revoked' | 'expired' | 'exhausted'; reason?: string;
}
export interface TaskScope { projectId: string; sessionId?: string; profileId?: string; directory?: string; pageId?: string; targetId?: string; url?: string }
export interface TaskEvent { sequence: number; occurredAt: string; projectId: string; type: string; reference: Record<string, string> }
function reject(code: string, message: string, status = 403): never { throw new StudioError(status, code, message); }
export async function normalizedTaskDirectory(directory: string): Promise<string> {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) reject('DIRECTORY_REQUIRED', 'A registered absolute workflow directory is required');
  return realpath(directory);
}
export function taskOrigin(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return reject('INVALID_ORIGIN', 'A task origin must be an HTTP or HTTPS origin'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) reject('INVALID_ORIGIN', 'Use an exact HTTP or HTTPS origin without credentials, path, query or fragment');
  return parsed.origin;
}

/** Instance/session-scoped authorization. It never changes the browser controller.
 * Revocation aborts active callers before exposing the revoked event. */
export class TaskAuthorizations {
  private grants = new Map<string, TaskAuthorization>();
  private active = new Map<string, Set<AbortController>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private sequence = 0;
  private events: TaskEvent[] = [];
  constructor(private readonly changed: () => void = () => {}) {}
  async issue(scope: TaskScope, input: { origins: string[]; pages: TaskAuthorization['pages']; capabilities: TaskCapability[]; durationMs: number; maxOperations: number }): Promise<TaskAuthorization> {
    if (this.grants.size >= 128) reject('AUTHORIZATION_LIMIT', 'This application instance has reached its authorization limit', 429);
    if (!Array.isArray(input.capabilities) || !input.capabilities.length || input.capabilities.some(value => !TASK_CAPABILITIES.includes(value))) reject('AUTHORIZATION_CAPABILITY', 'Unknown task capability');
    const browser = input.capabilities.some(value => ['page-read', 'page-act', 'page-create', 'execute'].includes(value));
    if (!scope.projectId || browser && (!scope.sessionId || !scope.profileId)) reject('AUTHORIZATION_SCOPE', 'Browser capabilities require a current project, session and profile');
    if (input.capabilities.includes('execute') && !scope.directory) reject('DIRECTORY_REQUIRED', 'Execution requires a registered workflow directory');
    if (!Array.isArray(input.origins) || browser && input.origins.length < 1 || input.origins.length > 32) reject('AUTHORIZATION_SCOPE', 'Authorize up to 32 exact origins; browser access requires at least one');
    if (!Array.isArray(input.pages) || browser && input.pages.length < 1 || input.pages.length > 32 || input.pages.some(p => !p.pageId || !p.targetId)) reject('AUTHORIZATION_SCOPE', 'Authorize up to 32 managed pages; browser access requires at least one');
    if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 1000 || input.durationMs > 8 * 60 * 60 * 1000 || !Number.isSafeInteger(input.maxOperations) || input.maxOperations < 1 || input.maxOperations > 10000) reject('AUTHORIZATION_BUDGET', 'Use a task duration from 1 second to 8 hours and one to 10000 operations');
    const directory = scope.directory ? await normalizedTaskDirectory(scope.directory) : undefined, issued = Date.now();
    const grant: TaskAuthorization = { authorizationId: randomUUID(), projectId: scope.projectId, sessionId: scope.sessionId, profileId: scope.profileId, directory,
      origins: [...new Set(input.origins.map(taskOrigin))], pages: structuredClone(input.pages), capabilities: [...new Set(input.capabilities)], issuedAt: new Date(issued).toISOString(), expiresAt: new Date(issued + input.durationMs).toISOString(),
      maxOperations: input.maxOperations, remainingOperations: input.maxOperations, issuer: 'human', status: 'active' };
    this.grants.set(grant.authorizationId, grant);
    const timer = setTimeout(() => this.revoke(grant.authorizationId, 'Task authorization expired', 'expired'), input.durationMs); timer.unref(); this.timers.set(grant.authorizationId, timer);
    this.publish(grant.projectId, 'authorization-issued', { authorizationId: grant.authorizationId });
    return structuredClone(grant);
  }
  get(id: string): TaskAuthorization {
    const grant = this.grants.get(id); if (!grant) reject('AUTHORIZATION_REQUIRED', 'Use an active task authorization issued by the trusted client');
    if (grant.status === 'active' && Date.now() >= Date.parse(grant.expiresAt)) this.revoke(id, 'Task authorization expired', 'expired');
    return structuredClone(grant);
  }
  list(projectId: string): TaskAuthorization[] { return [...this.grants.values()].filter(item => item.projectId === projectId).map(item => this.get(item.authorizationId)); }
  async check(id: string, capability: TaskCapability, scope: Pick<TaskScope, 'projectId'> & Partial<TaskScope>): Promise<TaskAuthorization> {
    const grant = this.get(id);
    if (grant.status !== 'active') reject('AUTHORIZATION_REVOKED', `Task authorization is ${grant.status}`);
    if (!grant.capabilities.includes(capability) || grant.projectId !== scope.projectId) reject('AUTHORIZATION_SCOPE', 'The requested capability or project is outside task authorization');
    for (const key of ['sessionId', 'profileId'] as const) if (scope[key] !== undefined && scope[key] !== grant[key]) reject('AUTHORIZATION_SCOPE', 'The browser session or profile differs from task authorization');
    if (scope.directory !== undefined && await normalizedTaskDirectory(scope.directory) !== grant.directory) reject('AUTHORIZATION_DIRECTORY', 'The registered workflow directory changed or resolves outside the authorized directory');
    if (scope.pageId !== undefined && !grant.pages.some(p => p.pageId === scope.pageId && p.targetId === scope.targetId)) reject('AUTHORIZATION_PAGE', 'The page/target is outside task authorization');
    if (scope.url !== undefined && scope.url !== 'about:blank') {
      let origin: string; try { origin = new URL(scope.url).origin; } catch { return reject('AUTHORIZATION_ORIGIN', 'Invalid destination URL'); }
      if (!grant.origins.includes(origin)) reject('AUTHORIZATION_ORIGIN', 'The page or destination origin is outside task authorization');
    }
    // Directory resolution is asynchronous; a revoke during it must win.
    if (this.get(id).status !== 'active') reject('AUTHORIZATION_REVOKED', 'Task authorization was revoked');
    return grant;
  }
  async run<T>(id: string, capability: TaskCapability, scope: Pick<TaskScope, 'projectId'> & Partial<TaskScope>, operation: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    await this.check(id, capability, scope); external?.throwIfAborted();
    const grant = this.grants.get(id)!;
    // The caller's await creates another microtask boundary after check's last
    // check. Registering the operation must be atomic with this final decision.
    if (this.get(id).status !== 'active') reject('AUTHORIZATION_REVOKED', 'Task authorization was revoked before operation registration');
    if (grant.remainingOperations < 1) { this.revoke(id, 'Task operation budget exhausted', 'exhausted'); reject('AUTHORIZATION_BUDGET', 'Task operation budget exhausted', 429); }
    grant.remainingOperations--;
    const controller = new AbortController(), group = this.active.get(id) ?? new Set(); group.add(controller); this.active.set(id, group);
    const abort = () => controller.abort(external?.reason); external?.addEventListener('abort', abort, { once: true });
    try { controller.signal.throwIfAborted(); return await operation(controller.signal); }
    finally { external?.removeEventListener('abort', abort); group.delete(controller); if (!group.size) this.active.delete(id); }
  }
  addPage(id: string, page: TaskAuthorization['pages'][number]): void {
    const grant = this.grants.get(id); if (!grant || this.get(id).status !== 'active' || !grant.capabilities.includes('page-create') || grant.pages.length >= 32) reject('AUTHORIZATION_PAGE', 'Task may not create another page');
    if (!grant.pages.some(item => item.pageId === page.pageId)) grant.pages.push(structuredClone(page));
  }
  revoke(id: string, reason = 'Revoked by the human controller', status: 'revoked' | 'expired' | 'exhausted' = 'revoked'): TaskAuthorization {
    const grant = this.grants.get(id); if (!grant) reject('AUTHORIZATION_REQUIRED', 'Unknown task authorization', 404);
    if (grant.status === 'active') {
      grant.status = status; grant.reason = reason; clearTimeout(this.timers.get(id)); this.timers.delete(id);
      for (const controller of this.active.get(id) ?? []) controller.abort(new StudioError(403, 'AUTHORIZATION_REVOKED', reason));
      this.publish(grant.projectId, 'authorization-revoked', { authorizationId: id, reason });
    }
    return structuredClone(grant);
  }
  publish(projectId: string, type: string, reference: Record<string, string>): void {
    this.events.push({ sequence: ++this.sequence, occurredAt: new Date().toISOString(), projectId, type, reference });
    if (this.events.length > 512) this.events.shift(); this.changed();
  }
  changes(projectId: string, after = 0, limit = 50) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) reject('INVALID_CURSOR', 'Use a nonnegative event cursor and limit from one to 100', 422);
    if (after > this.sequence || after && after < (this.events[0]?.sequence ?? 1) - 1) reject('CURSOR_EXPIRED', 'Event cursor is unavailable; refresh the fixed material and task indexes', 409);
    const available = this.events.filter(event => event.projectId === projectId && event.sequence > after), items = available.slice(0, limit);
    return { items: structuredClone(items), nextCursor: available.length > items.length ? items.at(-1)!.sequence : this.sequence, outputTruncated: available.length > items.length };
  }
  close(): void { for (const grant of this.grants.values()) this.revoke(grant.authorizationId, 'Application instance closed'); }
}
