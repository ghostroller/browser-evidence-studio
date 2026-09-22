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

/**
 * CDP callbacks update this identity ledger synchronously, before awaiting any
 * disk write. Returned records remain stable after redirects/removal.
 */
export class RequestLedger {
  private readonly active = new Map<string, CapturedRequest>();
  private sequence = 0;
  constructor(private readonly sessionId: string, private readonly targetId: string, private readonly capacity = 4096) {}

  begin(input: { requestId: string; url: string; frameId?: string; redirect: boolean }): {
    current: CapturedRequest; previous?: CapturedRequest; evicted?: CapturedRequest;
  } {
    const previous = this.active.get(input.requestId);
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

  reset(): CapturedRequest[] {
    const unfinished = [...this.active.values()];
    this.active.clear();
    return unfinished;
  }

  get size(): number { return this.active.size; }
}
