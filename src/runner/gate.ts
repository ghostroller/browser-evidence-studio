/** The small public transport shape accepted by Puppeteer.connect(). */
export interface ProtocolTransport {
  send(message: string): void;
  close(): void;
  onmessage?: (message: string) => void;
  onclose?: () => void;
}

export type GateState = 'open' | 'quiescing' | 'quiesced' | 'failed' | 'closed';

export interface GateConflict {
  commandId: number;
  method: string;
  state: GateState;
  occurredAt: string;
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
 * Closing the gate rejects every new command, including unknown CDP methods.
 * quiesce() resolves only after all commands sent before closure have replied.
 * This cannot retract asynchronous page work started by an earlier command.
 */
export class GateTransport implements ProtocolTransport {
  onmessage?: (message: string) => void;
  onclose?: () => void;
  private state: GateState = 'open';
  private readonly pending = new Map<number, string>();
  private conflicts = 0;
  private draining?: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };

  constructor(
    private readonly transport: ProtocolTransport,
    private readonly options: { onConflict?: (conflict: GateConflict) => void } = {},
  ) {
    transport.onmessage = (message) => this.receive(message);
    transport.onclose = () => this.didClose();
  }

  send(message: string): void {
    const command = JSON.parse(message) as { id?: number; method?: string; sessionId?: string };
    if (!Number.isSafeInteger(command.id) || typeof command.method !== 'string') {
      throw new Error('Operation transport accepts only CDP commands with a numeric id and method');
    }
    const id = command.id as number;
    if (this.state !== 'open') {
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
    if (this.pending.has(id)) throw new Error(`Duplicate in-flight CDP command id ${id}`);
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

  snapshot(): { state: GateState; inFlight: number; pendingMethods: string[]; rejectedCommands: number } {
    return { state: this.state, inFlight: this.pending.size, pendingMethods: [...this.pending.values()], rejectedCommands: this.conflicts };
  }

  close(): void {
    if (this.state === 'closed') return;
    // Transition before delegating: some transports report close asynchronously.
    this.didClose();
    this.transport.close();
  }

  private receive(message: string): void {
    const reply = JSON.parse(message) as { id?: number };
    if (typeof reply.id === 'number') this.pending.delete(reply.id);
    this.onmessage?.(message);
    this.finishDrain();
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

  private didClose(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.draining) {
      clearTimeout(this.draining.timer);
      this.draining.reject(new GateDrainError('Operation connection closed before drain completed', [...this.pending.values()]));
      this.draining = undefined;
    }
    this.pending.clear();
    this.onclose?.();
  }
}
