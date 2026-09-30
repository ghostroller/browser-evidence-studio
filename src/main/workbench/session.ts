import { createHash, randomBytes } from 'node:crypto';
import type { BrowserWorkbenchGrant, BrowserWorkbenchSession, BrowserWorkbenchTicket } from '../../contracts/browser-workbench';
import { WorkbenchError } from './errors';
import { identifier } from './validation';

export interface WorkbenchSessionContext {
  readonly instanceId: string;
  readonly projectId: string;
  readonly expiresAt: number;
  readonly grant: BrowserWorkbenchGrant;
  readonly issuerEpoch: number;
}
interface TicketRecord { projectId: string; grant: BrowserWorkbenchGrant; expiresAt: number; issuerEpoch: number }
interface SessionRecord { context: WorkbenchSessionContext; listeners: Set<() => void> }
export interface WorkbenchSessionOptions {
  instanceId: string;
  now?: () => number;
  ticketTtlMs?: number;
  sessionTtlMs?: number;
  maxTickets?: number;
  maxSessions?: number;
  maxExchangeAttempts?: number;
  attemptWindowMs?: number;
}
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const validToken = (token: unknown): token is string => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
function limit(value: number | undefined, fallback: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new TypeError('Invalid workbench limit');
  return result;
}

/** Trusted-owner object. No disk, refresh, public begin/revoke route or Agent token.
 * A ticket is atomically consumed before a session is issued, even at capacity.
 */
export class WorkbenchSessions {
  readonly instanceId: string;
  private readonly now: () => number;
  private readonly ticketTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly maxTickets: number;
  private readonly maxSessions: number;
  private readonly maxExchangeAttempts: number;
  private readonly attemptWindowMs: number;
  private readonly tickets = new Map<string, TicketRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly identities = new WeakMap<WorkbenchSessionContext, string>();
  private issuerEpoch = 1;
  private windowStart: number;
  private attempts = 0;
  private destroyed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: WorkbenchSessionOptions) {
    this.instanceId = identifier(options.instanceId);
    this.now = options.now ?? Date.now;
    this.ticketTtlMs = limit(options.ticketTtlMs, 60_000, 60_000);
    this.sessionTtlMs = limit(options.sessionTtlMs, 300_000, 900_000);
    this.maxTickets = limit(options.maxTickets, 8, 64);
    this.maxSessions = limit(options.maxSessions, 8, 64);
    this.maxExchangeAttempts = limit(options.maxExchangeAttempts, 32, 256);
    this.attemptWindowMs = limit(options.attemptWindowMs, 60_000, 300_000);
    this.windowStart = this.now();
  }

  begin(projectId: string, grant: BrowserWorkbenchGrant = 'project-metadata'): BrowserWorkbenchTicket {
    this.ensureLive();
    identifier(projectId);
    if (grant !== 'project-metadata' && grant !== 'project-materials' && grant !== 'project-workbench' && grant !== 'project-replay') throw new WorkbenchError('invalid_request');
    this.sweep();
    if (this.tickets.size >= this.maxTickets) throw new WorkbenchError('busy');
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ticketTtlMs;
    this.tickets.set(digest(ticket), { projectId, grant, expiresAt, issuerEpoch: this.issuerEpoch });
    this.schedule();
    return { ticket, expiresAt, instanceId: this.instanceId };
  }

  exchange(ticket: unknown, instanceId: string): BrowserWorkbenchSession {
    this.ensureLive();
    this.sweep();
    const now = this.now();
    if (now - this.windowStart >= this.attemptWindowMs) { this.windowStart = now; this.attempts = 0; }
    if (this.attempts >= this.maxExchangeAttempts) throw new WorkbenchError('busy');
    this.attempts++;
    if (instanceId !== this.instanceId || !validToken(ticket)) throw new WorkbenchError('unauthorized');
    const key = digest(ticket);
    const entry = this.tickets.get(key);
    if (!entry || entry.issuerEpoch !== this.issuerEpoch) throw new WorkbenchError('unauthorized');
    this.tickets.delete(key);
    if (this.sessions.size >= this.maxSessions) { this.schedule(); throw new WorkbenchError('busy'); }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + this.sessionTtlMs;
    const context = Object.freeze({ instanceId: this.instanceId, projectId: entry.projectId, grant: entry.grant, expiresAt, issuerEpoch: this.issuerEpoch });
    const tokenKey = digest(token);
    this.sessions.set(tokenKey, { context, listeners: new Set() });
    this.identities.set(context, tokenKey);
    this.schedule();
    return { token, expiresAt, instanceId: this.instanceId, projectId: entry.projectId, grant: entry.grant };
  }

  authenticate(token: unknown, instanceId: string): WorkbenchSessionContext {
    this.ensureLive();
    this.sweep();
    if (instanceId !== this.instanceId || !validToken(token)) throw new WorkbenchError('unauthorized');
    const context = this.sessions.get(digest(token))?.context;
    if (!context) throw new WorkbenchError('unauthorized');
    this.assertActive(context);
    return context;
  }

  assertActive(context: WorkbenchSessionContext): void {
    this.ensureLive();
    this.sweep();
    const key = this.identities.get(context);
    if (!key || this.sessions.get(key)?.context !== context || context.issuerEpoch !== this.issuerEpoch) {
      throw new WorkbenchError('unauthorized');
    }
  }

  onInvalidated(context: WorkbenchSessionContext, listener: () => void): () => void {
    this.assertActive(context);
    const entry = this.sessions.get(this.identities.get(context)!)!;
    if (entry.listeners.size >= 16) throw new WorkbenchError('busy');
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }

  revokeProject(projectId: string): void {
    identifier(projectId);
    for (const [key, entry] of this.tickets) if (entry.projectId === projectId) this.tickets.delete(key);
    for (const [key, entry] of this.sessions) if (entry.context.projectId === projectId) this.removeSession(key);
    this.schedule();
  }

  revokeIssuer(): void {
    this.issuerEpoch++;
    this.tickets.clear();
    for (const key of this.sessions.keys()) this.removeSession(key);
    this.schedule();
  }

  dispose(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.revokeIssuer();
  }

  /** Also usable with an injected clock; expiry never depends solely on timers. */
  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.tickets) if (entry.expiresAt <= now) this.tickets.delete(key);
    for (const [key, entry] of this.sessions) if (entry.context.expiresAt <= now) this.removeSession(key);
    this.schedule();
  }

  get counts(): { tickets: number; sessions: number; listeners: number } {
    this.sweep();
    return { tickets: this.tickets.size, sessions: this.sessions.size,
      listeners: [...this.sessions.values()].reduce((sum, entry) => sum + entry.listeners.size, 0) };
  }
  private ensureLive(): void { if (this.destroyed) throw new WorkbenchError('unavailable'); }
  private removeSession(key: string): void {
    const entry = this.sessions.get(key);
    if (!entry) return;
    this.sessions.delete(key);
    for (const listener of entry.listeners) { try { listener(); } catch { /* Owner cleanup must not prevent revocation. */ } }
    entry.listeners.clear();
  }
  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.destroyed) return;
    let next = Infinity;
    for (const entry of this.tickets.values()) next = Math.min(next, entry.expiresAt);
    for (const entry of this.sessions.values()) next = Math.min(next, entry.context.expiresAt);
    if (Number.isFinite(next)) {
      this.timer = setTimeout(() => this.sweep(), Math.max(1, next - this.now()));
      this.timer.unref();
    }
  }
}
