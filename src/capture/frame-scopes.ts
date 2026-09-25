import type { ReplayPosition } from '@/contracts/recording';
import { sameStream, type RecordingEnvelope } from './recording-types';

/** A small projection of already durable source metadata. CDP frame IDs must
 * independently resolve to the same host/document Mirror IDs before use. */
export class SourceFrameScopes {
  private stream?: ReplayPosition;
  private scopes = new Map<number, { rootId: number; frameId: string; position: ReplayPosition }>();
  private complete = true;
  append(record: RecordingEnvelope): void {
    if (!this.stream || !sameStream(record.position, this.stream) || record.event.type === 2) { this.scopes.clear(); this.complete = true; }
    this.stream = record.position;
    if (!record.metadataComplete) this.complete = false;
    if (record.event.type === 3 && record.event.data.source === 0) for (const removal of record.event.data.removes) this.scopes.delete(removal.id);
    for (const metadata of record.metadata) {
      if (metadata.frameHostId === undefined || metadata.frameId === 'top') continue;
      if (!this.scopes.has(metadata.frameHostId) && this.scopes.size >= 256) { this.complete = false; continue; }
      const existing=this.scopes.get(metadata.frameHostId);
      if(!existing||existing.rootId!==metadata.rootId||existing.frameId!==metadata.frameId)this.scopes.set(metadata.frameHostId, { rootId: metadata.rootId, frameId: metadata.frameId, position: record.position });
    }
  }
  resolve(frameHostId: number, rootId: number, position: ReplayPosition): string | undefined {
    if (!this.complete || !this.stream || !sameStream(this.stream, position)) return undefined;
    const scope = this.scopes.get(frameHostId);
    return scope && scope.rootId === rootId && scope.position.eventSeq <= position.eventSeq ? scope.frameId : undefined;
  }
}
