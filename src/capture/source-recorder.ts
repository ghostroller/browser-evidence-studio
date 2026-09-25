import type { record } from 'rrweb';
import type { eventWithTime, serializedNodeWithId } from '@rrweb/types';
import type { SourceMetadata } from './recording-types';
import type { ReplayPosition, SourceValue } from '@/contracts/recording';

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
  w.__besSourceHealth = () => ({ failedEmits, lastSourceSeq: seq - 1, pendingMetadata: pending.size, metadataComplete });
  w.__besStopSource = () => {
    // A final source baseline consumes pending attribute/property metadata at
    // rrweb's own boundary; the host reads health before and after this call.
    w.rrweb.record.takeFullSnapshot(); stop(); w.__besRecorderReady = false;
  };
}
