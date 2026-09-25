import type { record } from 'rrweb';
import type { eventWithTime, serializedNodeWithId } from '@rrweb/types';
import type { PresentationSample, SourceMetadata } from './recording-types';
import type { HistoricalElementRef, ReplayPosition, SourcePresentation, SourceValue } from '@/contracts/recording';

export interface RecorderConfiguration {
  binding: string;
  recordingId: string;
  pageId: string;
  checkoutEveryNms: number;
  checkoutEveryNth: number;
}

/** Serialized into the isolated observer world. Keep runtime dependencies local.
 * Same-origin frames reuse rrweb's shared mirror; cross-origin plugin IDs are
 * deliberately not enabled until an explicit frame transform is available. */
export function installSourceRecorder(config: RecorderConfiguration, urlPrivacy: (value: string, base?: string) => boolean): void {
  interface Mirror { getId(node: Node): number; getNode(id: number): Node | null }
  const w = window as unknown as Window & {
    rrweb: { record: typeof record };
    __besSourceHook: (node: Node, mirror: Mirror) => void;
    __besStopSource?: () => void;
    __besSourceHealth?: () => { failedEmits: number; lastSourceSeq: number; pendingMetadata: number; metadataComplete: boolean };
    __besRecorderReady?: boolean;
    __besSamplePresentation?: (ref: HistoricalElementRef) => Promise<PresentationSample>;
    __besSampleSelectedNode?: (node: Element) => Promise<PresentationSample>;
    [key: string]: unknown;
  };
  // randomUUID is restricted to secure contexts, while a recorder must also
  // initialize on about:blank and HTTP documents. getRandomValues is available
  // there and still gives each injection independent cryptographic identities.
  function uuid():string {
    const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&0x0f)|0x40;bytes[8]=(bytes[8]&0x3f)|0x80;
    const hex=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  const documentId = uuid(), streamEpoch = uuid();
  const pending = new Map<number, SourceMetadata>();
  let seq = 0, pendingBytes = 0, metadataComplete = true, failedEmits = 0;
  let pendingSample: { nodeId: number; observation: SourceValue<Omit<SourcePresentation, 'sampledAt'>>; result?: PresentationSample } | undefined;
  const credential = /password|passwd|passphrase|token|secret|authorization|cookie|credential|api[_-]?key/i;
  const present = <T>(value: T): SourceValue<T> => ({ status: 'present', value });
  const redacted = (): SourceValue<string> => ({ status: 'redacted', reason: 'capture-privacy-policy' });
  function privateUrl(value: string): boolean {
    return urlPrivacy(value, document.baseURI);
  }
  function privateAttribute(name: string, value: string, element: Element): boolean {
    return masked(element) && name !== 'class' || credential.test(name) || name === 'value' && /^(input|textarea|select|option)$/i.test(element.localName) || privateUrl(value);
  }
  function masked(element: Element): boolean {
    let current: Element | null = element;
    while (current) {
      if (current.matches('.rr-mask,.rr-block')) return true;
      const root: Node = current.getRootNode();
      current = current.parentElement ?? ('host' in root ? (root as ShadowRoot).host : null);
    }
    return false;
  }
  w.__besSourceHook = (node, mirror) => {
    if (node.nodeType !== 1) return;
    const el = node as Element, nodeId = mirror.getId(el);
    if (nodeId < 0 || el.closest('.rr-block')) return;
    const rootId = mirror.getId(el.ownerDocument);
    if (rootId < 0) { metadataComplete = false; return; }
    const attributes: SourceMetadata['attributes'] = Object.create(null) as SourceMetadata['attributes'];
    for (const attr of el.attributes) attributes[attr.name] = privateAttribute(attr.name, attr.value, el) ? redacted() : present(attr.value);
    const properties: SourceMetadata['properties'] = {};
    // Constructors differ across frames; use names after the Element check.
    if (/^(input|textarea|select|option)$/.test(el.localName)) properties.value = redacted();
    if (el.localName === 'input') properties.checked = present((el as HTMLInputElement).checked);
    if (el.localName === 'option') properties.selected = present((el as HTMLOptionElement).selected);
    const shadowHostIds: number[] = [];
    let root = el.getRootNode();
    while ('host' in root) {
      shadowHostIds.unshift(mirror.getId((root as ShadowRoot).host));
      root = (root as ShadowRoot).host.getRootNode();
    }
    const frameHost = el.ownerDocument.defaultView?.frameElement;
    const metadata: SourceMetadata = {
      nodeId, rootId, frameId: el.ownerDocument === document ? 'top' : `document-${rootId}`,
      mirrorScopeId: `${streamEpoch}:document-${rootId}`, ...(frameHost ? { frameHostId: mirror.getId(frameHost) } : {}), shadowHostIds,
      tagName: el.localName, namespaceURI: el.namespaceURI, attributes, properties,
      documentUrl: privateUrl(el.ownerDocument.URL) ? redacted() : present(el.ownerDocument.URL),
      baseURI: privateUrl(el.baseURI) ? redacted() : present(el.baseURI), metadataComplete: true,
    };
    const bytes = JSON.stringify(metadata).length * 2;
    const previous = pending.get(nodeId);
    const nextBytes = pendingBytes + bytes - (previous ? JSON.stringify(previous).length * 2 : 0);
    if (nextBytes > 8 * 1024 * 1024) { metadataComplete = false; return; }
    pending.set(nodeId, metadata); pendingBytes = nextBytes;
  };
  function redactTree(node: serializedNodeWithId): void {
    if (node.type === 2) {
      const element = w.rrweb.record.mirror.getNode(node.id) as Element | null;
      for (const [name, value] of Object.entries(node.attributes)) {
        if (element?.nodeType === 1 && masked(element) && name !== 'class' || credential.test(name) || name === 'value' && /^(input|textarea|select|option)$/.test(node.tagName) || typeof value === 'string' && privateUrl(value)) node.attributes[name] = '[redacted]';
      }
    }
    if ('textContent' in node && privateUrl(node.textContent)) node.textContent = '[redacted credential URL]';
    if ('childNodes' in node) node.childNodes.forEach(redactTree);
  }
  const stop = w.rrweb.record({
    maskAllInputs: true, recordCanvas: false, collectFonts: false, inlineStylesheet: false,
    recordCrossOriginIframes: false, checkoutEveryNms: config.checkoutEveryNms,
    checkoutEveryNth: config.checkoutEveryNth, sampling: { mousemove: 100, scroll: 100 },
    plugins: [{ name: 'bes-capture-privacy-v1', options: {}, eventProcessor: original => {
      const event = JSON.parse(JSON.stringify(original)) as eventWithTime;
      if (event.type === 4 && privateUrl(event.data.href)) event.data.href = '[redacted]';
      if (event.type === 2) redactTree(event.data.node);
      if (event.type === 3 && event.data.source === 0) {
        event.data.adds.forEach(entry => redactTree(entry.node));
        for (const change of event.data.texts) if (typeof change.value === 'string' && privateUrl(change.value)) change.value = '[redacted credential URL]';
        for (const change of event.data.attributes) {
          const node = w.rrweb.record.mirror.getNode(change.id) as Element | null;
          for (const [name, value] of Object.entries(change.attributes)) {
            if (typeof value === 'string' && (credential.test(name) || node?.nodeType === 1 && privateAttribute(name, value, node))) change.attributes[name] = '[redacted]';
          }
        }
      }
      if (event.type === 3 && event.data.source === 5) event.data.text = '[redacted]';
      return event;
    } }],
    hooks: { input: change => {
      const mirror = w.rrweb.record.mirror, node = mirror.getNode(change.id);
      if (node) {
        w.__besSourceHook(node, mirror);
        if (node.nodeType === 1 && (node as Element).localName === 'select') for (const option of (node as HTMLSelectElement).options) w.__besSourceHook(option, mirror);
      }
    } },
    emit: event => {
      const position: ReplayPosition = { recordingId: config.recordingId, pageId: config.pageId, documentId, streamEpoch, eventSeq: seq++, sourceTimeMs: event.timestamp };
      if (event.type === 5 && event.data.tag === 'bes-source-presentation' && pendingSample) {
        const metadata = pending.get(pendingSample.nodeId);
        if (!metadata) { metadataComplete = false; }
        else {
          const presentation: SourceValue<SourcePresentation> = pendingSample.observation.status === 'present'
            ? present({ ...pendingSample.observation.value, sampledAt: { ...position } }) : pendingSample.observation;
          metadata.presentation = presentation;
          pendingSample.result = { ref: { kind: 'dom-node', position, nodeId: metadata.nodeId, frameId: metadata.frameId, mirrorScopeId: metadata.mirrorScopeId }, presentation };
        }
      }
      const rootId = w.rrweb.record.mirror.getId(document);
      const errors: string[] = [];
      if (!metadataComplete) errors.push('source-metadata-byte-budget');
      if (failedEmits) errors.push(`observer-binding-failed:${failedEmits}`);
      const payload = { kind: 'rrweb', isTop: true, formatVersion: 2, position, frameId: 'top', mirrorScopeId: `${streamEpoch}:document-${rootId}`, event,
        metadata: [...pending.values()], metadataComplete: metadataComplete && !failedEmits,
        viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
        sourceClock: { timeOrigin: performance.timeOrigin, monotonicMs: performance.now() }, errors };
      pending.clear(); pendingBytes = 0; metadataComplete = true;
      try { (w[config.binding] as (value: string) => void)(JSON.stringify(payload)); failedEmits = 0; }
      catch { failedEmits++; w.__besRecorderReady = false; }
    },
    errorHandler: error => { metadataComplete = false; console.error('BES recorder error', error); return false; },
  });
  if (!stop) throw new Error('rrweb recorder did not start');
  w.__besRecorderReady = true;
  function observation(el: Element): SourceValue<Omit<SourcePresentation, 'sampledAt'>> {
    // Do not read innerText for an entire private subtree and redact afterward.
    if (masked(el) || /^(input|textarea|select|option)$/i.test(el.localName) || el.querySelector('.rr-mask,.rr-block,input,textarea,select,option')) return { status: 'redacted', reason: 'capture-privacy-policy' };
    const view = el.ownerDocument.defaultView;
    if (!view) return { status: 'unsupported', reason: 'source-innerText-unavailable' };
    const text = (el as HTMLElement).innerText;
    if (typeof text !== 'string') return { status: 'unsupported', reason: 'source-innerText-unavailable' };
    if (text.length > 8192) return { status: 'missing', reason: 'presentation-text-budget' };
    if (privateUrl(text)) return { status: 'redacted', reason: 'credential-url-in-displayed-text' };
    const rect = el.getBoundingClientRect(), style = view.getComputedStyle(el);
    const basis = ['source-innerText', 'source-getBoundingClientRect', 'source-computedStyle', 'source-local-viewport'];
    let visibility: SourcePresentation['visibility'] = 'visible';
    const nativeVisible = typeof el.checkVisibility === 'function' ? el.checkVisibility({opacityProperty:true,visibilityProperty:true,contentVisibilityAuto:true}) : undefined;
    if(nativeVisible!==undefined)basis.push('source-checkVisibility');
    if (nativeVisible===false || !el.isConnected || !el.getClientRects().length || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) visibility = 'hidden';
    else if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= view.innerHeight || rect.left >= view.innerWidth) visibility = 'offscreen';
    else {
      const root = el.getRootNode() as Document | ShadowRoot;
      const x = Math.max(0, Math.min(view.innerWidth - 1, rect.x + rect.width / 2)), y = Math.max(0, Math.min(view.innerHeight - 1, rect.y + rect.height / 2));
      const hit = typeof root.elementFromPoint === 'function' ? root.elementFromPoint(x, y) : null;
      basis.push('source-center-hit-test');
      if (!hit) visibility = 'unknown';
      else if (hit !== el && !el.contains(hit)) visibility = style.pointerEvents === 'none' ? 'unknown' : 'occluded';
    }
    if (el.ownerDocument !== document) { basis.push('frame-ancestor-visibility-not-sampled'); if (visibility === 'visible') visibility = 'unknown'; }
    return present({ text, visibility, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, basis });
  }
  async function sample(el: Element, expected?: HistoricalElementRef): Promise<PresentationSample> {
    // MutationObserver work queued by the selecting task runs before this
    // continuation. Reading and emitting then happen in one JS task, with no
    // intervening site callback and without a per-node recursive innerText walk.
    await Promise.resolve();
    if (!w.__besRecorderReady || !el.isConnected) throw new Error('Source node is unavailable for presentation sampling');
    const mirror = w.rrweb.record.mirror, nodeId = mirror.getId(el), rootId = mirror.getId(el.ownerDocument);
    const frameId = el.ownerDocument === document ? 'top' : `document-${rootId}`, mirrorScopeId = `${streamEpoch}:document-${rootId}`;
    if (nodeId < 0 || rootId < 0 || expected && (expected.kind !== 'dom-node' || expected.position.recordingId !== config.recordingId || expected.position.pageId !== config.pageId || expected.position.documentId !== documentId || expected.position.streamEpoch !== streamEpoch || expected.nodeId !== nodeId || expected.frameId !== frameId || expected.mirrorScopeId !== mirrorScopeId)) throw new Error('Presentation target does not belong to the current source mirror');
    w.__besSourceHook(el, mirror);
    const sample = { nodeId, observation: observation(el) } as NonNullable<typeof pendingSample>;
    pendingSample = sample;
    try { w.rrweb.record.addCustomEvent('bes-source-presentation', { nodeId, frameId, mirrorScopeId }); }
    finally { pendingSample = undefined; }
    if (!sample.result || failedEmits) throw new Error('Presentation observation was not emitted');
    return sample.result;
  }
  w.__besSampleSelectedNode = node => sample(node);
  w.__besSamplePresentation = ref => {
    const node = w.rrweb.record.mirror.getNode(ref.nodeId);
    if (!node || node.nodeType !== 1) return Promise.reject(new Error('Presentation source element is unavailable'));
    return sample(node as Element, ref);
  };
  w.__besSourceHealth = () => ({ failedEmits, lastSourceSeq: seq - 1, pendingMetadata: pending.size, metadataComplete });
  w.__besStopSource = () => {
    // A final source baseline consumes pending attribute/property metadata at
    // rrweb's own boundary; the host reads health before and after this call.
    w.rrweb.record.takeFullSnapshot(); stop(); w.__besRecorderReady = false; delete w.__besSamplePresentation; delete w.__besSampleSelectedNode;
  };
}
