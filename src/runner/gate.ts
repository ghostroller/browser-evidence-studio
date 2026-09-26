import { transportCloseInfo, type TransportCloseInfo } from './transport-diagnostics';

/** The small public transport shape accepted by Puppeteer.connect(). */
export interface ProtocolTransport {
  send(message: string): void;
  close(): void;
  onmessage?: (message: string) => void;
  onclose?: (details?: TransportCloseInfo) => void;
}

export type GateState = 'open' | 'quiescing' | 'quiesced' | 'failed' | 'closed';

export interface GateConflict {
  commandId: number;
  method: string;
  state: GateState;
  occurredAt: string;
}

interface ProtocolCommand { id?: number; method?: string; sessionId?: string; params?: Record<string, unknown>; }

export interface GateCloseDiagnostic {
  trigger: 'host' | 'worker' | 'transport';
  transport: TransportCloseInfo;
  gateStateBeforeClose: GateState;
  inFlight: number;
  pendingMethods: string[];
  pendingMethodsTruncated: boolean;
  rejectedCommands: number;
  maintenanceCommands: number;
}

export class GateDrainError extends Error {
  constructor(message: string, readonly pendingMethods: string[]) {
    super(message);
    this.name = 'GateDrainError';
  }
}

/**
 * One revocable operation connection. Capture must use a DIFFERENT transport.
 *
 * Closing the gate rejects page operations, including unknown CDP methods.
 * A narrow set of connection housekeeping commands may still run for sessions
 * actually attached on this transport. Otherwise Puppeteer's auto-attach can
 * pause a site's own worker during human input and mistake its resume for a write.
 * quiesce() resolves only after all commands sent before closure have replied.
 * This cannot retract asynchronous page work started by an earlier command.
 */
export class GateTransport implements ProtocolTransport {
  onmessage?: (message: string) => void;
  onclose?: (details?: TransportCloseInfo) => void;
  private closedWith?: GateCloseDiagnostic;
  get closeDiagnostic(): GateCloseDiagnostic | undefined { return this.closedWith; }
  private commandGuard?: () => void;
  /** Scoped host action guard, checked even inside Puppeteer's internal awaits. */
  setCommandGuard(guard?: () => void) { this.commandGuard=guard; }
  private state: GateState = 'open';
  private readonly pending = new Map<number, string>();
  private conflicts = 0;
  private maintenanceCommands = 0;
  private readonly sessions = new Map<string, { parent?: string }>();
  private draining?: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };

  constructor(
    private readonly transport: ProtocolTransport,
    private readonly options: { onConflict?: (conflict: GateConflict) => void; onClosed?: (details: GateCloseDiagnostic) => void } = {},
  ) {
    transport.onmessage = (message) => this.receive(message);
    transport.onclose = details => this.didClose('transport', details);
  }

  send(message: string): void {
    const command = JSON.parse(message) as ProtocolCommand;
    if (!Number.isSafeInteger(command.id) || typeof command.method !== 'string') {
      throw new Error('Operation transport accepts only CDP commands with a numeric id and method');
    }
    const id = command.id as number;
    const maintenance = (this.state === 'quiescing' || this.state === 'quiesced') && this.isMaintenance(command);
    if (this.state !== 'open' && !maintenance) {
      this.conflicts += 1;
      const conflict: GateConflict = {
        commandId: id, method: command.method, state: this.state, occurredAt: new Date().toISOString(),
      };
      // Deliver a real protocol error so Puppeteer's pending callback is settled.
      queueMicrotask(() => this.onmessage?.(JSON.stringify({
        id,
        ...(command.sessionId ? { sessionId: command.sessionId } : {}),
        error: { code: -32001, message: `Operation gate is ${conflict.state}; command rejected` },
      })));
      this.options.onConflict?.(conflict);
      return;
    }
    if(this.state==='open'&&!this.isMaintenance(command))this.commandGuard?.();
    if (this.pending.has(id)) throw new Error(`Duplicate in-flight CDP command id ${id}`);
    if (maintenance) this.maintenanceCommands += 1;
    this.pending.set(id, command.method);
    try {
      this.transport.send(message);
    } catch (error) {
      this.pending.delete(id);
      this.finishDrain();
      throw error;
    }
  }

  /** Atomically close to new commands before beginning the bounded drain. */
  quiesce(timeoutMs = 5_000): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return Promise.reject(new Error('Invalid drain timeout'));
    if (this.state === 'quiesced') return Promise.resolve();
    if (this.draining) return this.draining.promise;
    if (this.state !== 'open') return Promise.reject(new GateDrainError(`Cannot drain a ${this.state} gate`, [...this.pending.values()]));
    this.state = 'quiescing';
    if (this.pending.size === 0) {
      this.state = 'quiesced';
      return Promise.resolve();
    }
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => {
      this.state = 'failed';
      this.draining = undefined;
      reject(new GateDrainError('Operation connection did not drain; stop the runner before human takeover', [...this.pending.values()]));
    }, timeoutMs);
    this.draining = { promise, resolve, reject, timer };
    return promise;
  }

  resume(): void {
    if (this.state !== 'quiesced') throw new Error(`Cannot resume a ${this.state} operation gate`);
    this.state = 'open';
  }

  snapshot(): { state: GateState; inFlight: number; pendingMethods: string[]; rejectedCommands: number; maintenanceCommands: number } {
    return { state: this.state, inFlight: this.pending.size, pendingMethods: [...this.pending.values()], rejectedCommands: this.conflicts, maintenanceCommands: this.maintenanceCommands };
  }

  close(trigger: 'host' | 'worker' = 'host'): void {
    if (this.state === 'closed') return;
    // Transition before delegating: some transports report close asynchronously.
    this.didClose(trigger, transportCloseInfo('local'));
    this.transport.close();
  }

  private receive(message: string): void {
    if (this.state === 'closed') return;
    const reply = JSON.parse(message) as ProtocolCommand;
    if (typeof reply.id === 'number') this.pending.delete(reply.id);
    if (reply.method === 'Target.attachedToTarget' && typeof reply.params?.sessionId === 'string') {
      this.sessions.set(reply.params.sessionId, { parent: reply.sessionId });
    } else if (reply.method === 'Target.detachedFromTarget' && typeof reply.params?.sessionId === 'string') {
      this.sessions.delete(reply.params.sessionId);
    }
    this.onmessage?.(message);
    this.finishDrain();
  }

  private isMaintenance(command: ProtocolCommand): boolean {
    const params = command.params ?? {};
    const keys = Object.keys(params);
    // Detaching affects only this connection, never the underlying page/worker.
    if (command.method === 'Target.detachFromTarget') {
      const session = typeof params.sessionId === 'string' ? this.sessions.get(params.sessionId) : undefined;
      return keys.length === 1 && !!session && session.parent === command.sessionId;
    }
    if (!command.sessionId || !this.sessions.has(command.sessionId)) return false;
    switch (command.method) {
      case 'Runtime.runIfWaitingForDebugger': return keys.length === 0;
      case 'Runtime.releaseObject': return keys.length === 1 && typeof params.objectId === 'string';
      case 'Target.setAutoAttach':
        return keys.length === 4 && params.autoAttach === true && params.flatten === true && params.waitForDebuggerOnStart === true &&
          Array.isArray(params.filter) && params.filter.length === 1 && params.filter[0] !== null &&
          typeof params.filter[0] === 'object' && !Array.isArray(params.filter[0]) && Object.keys(params.filter[0]).length === 0;
      default: return false;
    }
  }

  private finishDrain(): void {
    if (this.state !== 'quiescing' || this.pending.size !== 0) return;
    const draining = this.draining;
    this.draining = undefined;
    this.state = 'quiesced';
    if (draining) {
      clearTimeout(draining.timer);
      draining.resolve();
    }
  }

  private didClose(trigger: GateCloseDiagnostic['trigger'], details = transportCloseInfo('unknown')): void {
    if (this.state === 'closed') return;
    const methods = [...new Set(this.pending.values())];
    this.closedWith = {trigger, transport: details, gateStateBeforeClose: this.state, inFlight: this.pending.size,
      pendingMethods: methods.slice(0, 16).map(method => method.slice(0, 128)),
      pendingMethodsTruncated: methods.length > 16 || methods.some(method => method.length > 128),
      rejectedCommands: this.conflicts, maintenanceCommands: this.maintenanceCommands};
    this.state = 'closed';
    if (this.draining) {
      clearTimeout(this.draining.timer);
      this.draining.reject(new GateDrainError('Operation connection closed before drain completed', [...this.pending.values()]));
      this.draining = undefined;
    }
    this.pending.clear();
    this.sessions.clear();
    this.options.onClosed?.(this.closedWith);
    this.onclose?.(details);
  }
}
