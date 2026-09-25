import type { HistoricalElementRef, ReadBudget, SourceNode, SourceValue } from '@/contracts/recording';
import { sameReplayPosition } from '@/contracts/recording';
import { SourceModel } from '@/replay/source-model';
import type { ArchiveReplayService } from '@/replay/service';
import type { SourceDocument, SourceReader, SourceScope } from './types';
import type { JsonValue } from '@/contracts/workflow';

export interface CapturedDomLocation { replay: ArchiveReplayService; target: HistoricalElementRef; scope: SourceScope }

/** locate must resolve a host-persisted sample reference and execution mapping.
 * It never accepts script-provided observations or fetches the current live page. */
export class CapturedDomSourceReader implements SourceReader {
  constructor(private readonly locate: (reference: string) => Promise<CapturedDomLocation | undefined>) {}
  async read(sourceRef: string, budget: ReadBudget): Promise<SourceDocument | undefined> {
    if (!Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 1024 || budget.maxBytes > 1024 * 1024 || !Number.isSafeInteger(budget.limit) || budget.limit < 1 || budget.cursor) throw new Error('Invalid source read budget');
    const located = await this.locate(sourceRef); if (!located) return undefined;
    const { replay } = located;
    const { target, scope } = structuredClone({ target: located.target, scope: located.scope });
    if (scope.recordingId !== target.position.recordingId) throw new Error('DOM sample recording scope differs from its target');
    const window = await replay.window(target.position);
    if (window.gaps.some(gap => gap.category === 'structure' || gap.category === 'metadata')) throw new Error('DOM sample source position is not reliable');
    const model = new SourceModel(window.records), node = model.node(target);
    const ancestors: Array<Pick<SourceNode, 'ref' | 'attributes'>> = [];
    const tree = model.nodes.get(target.nodeId)!;
    let parentId = tree.parentId;
    while (parentId !== undefined) {
      const parent = model.nodes.get(parentId);
      if (!parent?.metadata || parent.metadata.rootId !== tree.metadata?.rootId || parent.metadata.mirrorScopeId !== target.mirrorScopeId || JSON.stringify(parent.metadata.shadowHostIds) !== JSON.stringify(tree.metadata?.shadowHostIds)) break;
      if (ancestors.length >= 64) throw new Error('Source ancestry exceeds the bounded proof depth');
      const source = model.node({ ...target, nodeId: parent.id });
      if (!source.metadataComplete) throw new Error('Source ancestor metadata is incomplete');
      ancestors.push({ ref: source.ref, attributes: source.attributes }); parentId = parent.parentId;
    }
    const sample = node.presentation;
    const exact = sample?.status === 'present' && sameReplayPosition(sample.value.sampledAt, target.position);
    const content: SourceValue<JsonValue> = exact ? { status: 'present', value: sample.value.text }
      : sample && sample.status !== 'present' ? sample : { status: 'missing', reason: 'No source presentation sample at this exact event boundary' };
    const document: SourceDocument = { sourceRef, scope: structuredClone(scope), capturedAt: window.records.at(-1)!.receivedAt,
      ...(node.documentUrl.status === 'present' ? { requestUrl: node.documentUrl.value } : {}), content, representation: 'dom-text',
      display: exact && sample.value.visibility === 'visible' && sample.value.basis.length > 0 ? 'observed' : 'unknown', dom: { node, ancestors } };
    if (Buffer.byteLength(JSON.stringify(document)) > budget.maxBytes) throw new Error('DOM source response exceeds its explicit budget');
    return document;
  }
}
