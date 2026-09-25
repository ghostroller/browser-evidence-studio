export interface CapturedRequest {
  requestId: string;
  key: string;
  occurrence: number;
  url: string;
  mime: string;
  hop: number;
  frameId?: string;
  startedAt: string;
  streaming?: boolean;
}

export interface RequestBodyRead {
  invalidated?: string;
  release(): void;
}

/**
 * CDP callbacks update this identity ledger synchronously, before awaiting any
 * disk write. Returned records remain stable after redirects/removal.
 */
export class RequestLedger {
  private readonly active = new Map<string, CapturedRequest>();
  private readonly bodyReads = new Map<string, RequestBodyRead>();
  private readonly responseReads = new Map<string, RequestBodyRead>();
  private sequence = 0;
  constructor(private readonly sessionId: string, private readonly targetId: string, private readonly capacity = 4096) {}

  begin(input: { requestId: string; url: string; frameId?: string; redirect: boolean }): {
    current: CapturedRequest; previous?: CapturedRequest; evicted?: CapturedRequest;
  } {
    const previous = this.active.get(input.requestId);
    this.invalidateBodyRead(input.requestId, input.redirect ? 'request-redirected-during-body-read' : 'request-id-reused-during-body-read');
    this.invalidateResponseRead(input.requestId, 'request-id-reused-before-response-read-completed');
    const occurrence = previous && input.redirect ? previous.occurrence : ++this.sequence;
    const hop = previous && input.redirect ? previous.hop + 1 : 0;
    const current: CapturedRequest = {
      requestId: input.requestId,
      key: `${this.sessionId}/${this.targetId}/${input.requestId}/${occurrence}/${hop}`,
      occurrence, hop, url: input.url, mime: '', frameId: input.frameId, startedAt: new Date().toISOString(),
    };
    let evicted: CapturedRequest | undefined;
    if (!previous && this.active.size >= this.capacity) {
      const oldest = this.active.keys().next().value as string;
      evicted = this.active.get(oldest);
      this.active.delete(oldest);
      this.invalidateBodyRead(oldest, 'request-evicted-during-body-read');
    }
    this.active.set(input.requestId, current);
    return { current, previous, evicted };
  }

  response(requestId: string, mime: string): CapturedRequest | undefined {
    const current = this.active.get(requestId);
    if (current) { current.mime = mime; current.streaming = /event-stream/i.test(mime); }
    return current;
  }

  finish(requestId: string): CapturedRequest | undefined {
    const current = this.active.get(requestId);
    this.active.delete(requestId);
    return current;
  }

  /** A completed request can still return its body, until its ID is reused or capture resets. */
  acquireBodyRead(request: CapturedRequest): RequestBodyRead {
    const read: RequestBodyRead = {
      ...(this.active.get(request.requestId) !== request ? { invalidated: 'request-identity-unavailable-before-body-read' } : {}),
      release: () => { if (this.bodyReads.get(request.requestId) === read) this.bodyReads.delete(request.requestId); },
    };
    if (!read.invalidated) {
      this.invalidateBodyRead(request.requestId, 'request-body-read-replaced');
      this.bodyReads.set(request.requestId, read);
    }
    return read;
  }

  private invalidateBodyRead(requestId: string, reason: string): void {
    const read = this.bodyReads.get(requestId);
    if (read) { read.invalidated = reason; this.bodyReads.delete(requestId); }
  }

  /** Acquire synchronously at loadingFinished, BEFORE removing the active
   * request or queueing a deferred CDP body read. */
  acquireResponseRead(requestId: string): RequestBodyRead {
    this.invalidateResponseRead(requestId, 'response-read-replaced');
    const read: RequestBodyRead = {
      ...(!this.active.has(requestId) ? { invalidated: 'response-identity-not-observed' } : {}),
      release: () => { if (this.responseReads.get(requestId) === read) this.responseReads.delete(requestId); },
    };
    if (!read.invalidated) this.responseReads.set(requestId, read);
    return read;
  }
  private invalidateResponseRead(requestId: string, reason: string): void {
    const read = this.responseReads.get(requestId);
    if (read) { read.invalidated = reason; this.responseReads.delete(requestId); }
  }

  reset(): CapturedRequest[] {
    const unfinished = [...this.active.values()];
    this.active.clear();
    for (const requestId of this.bodyReads.keys()) this.invalidateBodyRead(requestId, 'capture-reset-during-body-read');
    for (const requestId of this.responseReads.keys()) this.invalidateResponseRead(requestId, 'capture-reset-before-response-read-completed');
    return unfinished;
  }

  get size(): number { return this.active.size; }
}
