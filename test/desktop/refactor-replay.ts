import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow, session } from 'electron';
import type { eventWithTime } from '@rrweb/types';
import type { Replayer, record } from 'rrweb';
import rrwebSource from '../../node_modules/rrweb/dist/rrweb.umd.cjs?raw';
import { instrumentRrweb216ForSourcePrototype, prototypeLocators, reconstructPrototypeSource, type PrototypeSourceEvent, type PrototypeSourceMetadata, type PrototypeSourceNode } from '@/capture/source-prototype';
import type { Studio } from '@/main/services/studio';

interface PrototypeBrowser extends Window {
  rrweb: { record: typeof record; Replayer: typeof Replayer };
  __besS0SourceHook: (node: Node, mirror: { getId(node: Node): number }) => void;
  __besS0: { records: PrototypeSourceEvent[]; stop: () => void; errors: string[] };
  __besS0Replay: Replayer;
}

/** Serialized into a dedicated synthetic source page. No second DOM observer or
 * mirror is installed: metadata is read at rrweb's own serialization boundaries. */
function installPrototypeRecorder(): void {
  const w = window as unknown as PrototypeBrowser;
  const pending = new Map<number, PrototypeSourceMetadata>();
  const records: PrototypeSourceEvent[] = [], errors: string[] = [];
  w.__besS0SourceHook = (node, mirror) => {
    if (node.nodeType !== 1) return;
    const element = node as Element, nodeId = mirror.getId(node);
    if (nodeId < 0 || element.closest('.rr-block')) return;
    if (element.ownerDocument !== document || element.getRootNode() !== document) {
      errors.push('unsupported-frame-or-shadow-metadata'); return;
    }
    const attributes: Record<string, string> = {}, redactedAttributes: string[] = [];
    for (const attribute of element.attributes) {
      if (attribute.name === 'value' && /^(input|textarea|select|option)$/i.test(element.localName)) redactedAttributes.push(attribute.name);
      else attributes[attribute.name] = attribute.value;
    }
    const properties: PrototypeSourceMetadata['properties'] = {};
    if (element instanceof HTMLInputElement) { properties.checked = element.checked; properties.value = 'redacted'; }
    if (element instanceof HTMLOptionElement) properties.selected = element.selected;
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) properties.value = 'redacted';
    pending.set(nodeId, { nodeId, tagName: element.localName, namespaceURI: element.namespaceURI, attributes, redactedAttributes, properties, documentUrl: document.URL, baseURI: document.baseURI });
  };
  const stop = w.rrweb.record({
    maskAllInputs: true, inlineStylesheet: false, recordCanvas: false,
    hooks: { input: event => {
      const node = w.rrweb.record.mirror.getNode(event.id);
      if (node) w.__besS0SourceHook(node, w.rrweb.record.mirror);
    } },
    emit: (event: eventWithTime) => {
      records.push({ seq: records.length, event: JSON.parse(JSON.stringify(event)) as eventWithTime, metadata: [...pending.values()] });
      pending.clear();
    },
    // Preserve failures as evidence and let rrweb rethrow; never turn one into success.
    errorHandler: error => { errors.push(String(error)); return false; },
  });
  if (!stop) throw new Error('rrweb recorder did not start');
  w.__besS0 = { records, stop, errors };
}

function findSourceNode(root: PrototypeSourceNode, id: number): PrototypeSourceNode | undefined {
  if (root.id === id) return root;
  for (const child of root.children) { const result = findSourceNode(child, id); if (result) return result; }
  return undefined;
}

/** Uses independent DOM implementations to query the reconstructed source model
 * and the actual source HTML saved at each boundary. Neither is the replay DOM.
 * This function is serialized; keep it self-contained. */
function compareOriginalDocuments(args: { model: PrototypeSourceNode; originalHtml: string; nodeId: number; css: string; xpath: string }): Record<string, unknown> {
  const modelDocument = document.implementation.createHTMLDocument('source-model');
  const byId = new Map<number, Node>();
  function rebuild(node: PrototypeSourceNode): Node | null {
    let result: Node;
    if (node.type === 0) { for (const child of node.children) { const built = rebuild(child); if (built && built.nodeType !== 10) modelDocument.appendChild(built); } return modelDocument; }
    if (node.type === 1) return null;
    if (node.type === 2) {
      const element = modelDocument.createElementNS(node.namespaceURI || 'http://www.w3.org/1999/xhtml', node.tagName!);
      for (const [name, value] of Object.entries(node.attributes || {})) element.setAttribute(name, value);
      result = element;
    } else if (node.type === 3) result = modelDocument.createTextNode(node.textContent || '');
    else result = modelDocument.createComment(node.textContent || '');
    byId.set(node.id, result);
    for (const child of node.children) { const built = rebuild(child); if (built) result.appendChild(built); }
    return result;
  }
  // Detached documents never execute original scripts; the parent Electron
  // partition also refuses all network requests, including HTML parser loads.
  modelDocument.removeChild(modelDocument.documentElement);
  rebuild(args.model);
  const independent = new DOMParser().parseFromString(args.originalHtml, 'text/html');
  function query(doc: Document) {
    const css = [...doc.querySelectorAll(args.css)];
    const result = doc.evaluate(args.xpath, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const xpath = Array.from({ length: result.snapshotLength }, (_, index) => result.snapshotItem(index));
    return { cssCount: css.length, xpathCount: xpath.length, cssKey: css[0]?.getAttribute('data-key'), xpathKey: (xpath[0] as Element | undefined)?.getAttribute('data-key'), cssTarget: doc === modelDocument ? css[0] === byId.get(args.nodeId) : undefined, xpathTarget: doc === modelDocument ? xpath[0] === byId.get(args.nodeId) : undefined };
  }
  return { model: query(modelDocument), independentOriginal: query(independent) };
}

export async function runRefactorReplayPrototype(studio: Studio): Promise<Record<string, unknown>> {
  const windows: BrowserWindow[] = [];
  const sourcePartition = session.fromPartition(`s0-source-${process.pid}-${Date.now()}`);
  const replayPartition = session.fromPartition(`s0-replay-${process.pid}-${Date.now()}`);
  const blockedRequests: { context: string; url: string }[] = [];
  for (const [context, partition] of [['source', sourcePartition], ['replay', replayPartition]] as const) {
    partition.webRequest.onBeforeRequest((details, callback) => {
      if (/^https?:/i.test(details.url)) { blockedRequests.push({ context, url: details.url }); callback({ cancel: true }); }
      else callback({});
    });
  }
  const report: Record<string, unknown> = { schemaVersion: 1, passed: false, startedAt: new Date().toISOString(), versions: { electron: process.versions.electron, chromium: process.versions.chrome, rrweb: '2.1.6' }, rrwebBundleSha256: createHash('sha256').update(rrwebSource).digest('hex'), scope: 'S0 bounded synthetic single-document spike; production recorder unchanged', limitations: ['Cross-origin plugin IDs are not transformed by rrweb 2.1.6; no cross-frame metadata mapping claimed.', 'Frame/shadow paths, resource archival, long-history memory, eventSeq-exact same-millisecond seek, and cancellation generations remain A work.', 'Input values are redacted; selected/checked attributes and properties remain distinct.', 'No real account or live-site locator reliability claimed.'] };
  try {
    const source = new BrowserWindow({ show: false, webPreferences: { session: sourcePartition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    const replay = new BrowserWindow({ show: false, webPreferences: { session: replayPartition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    windows.push(source, replay);
    await Promise.all([source.loadURL('about:blank'), replay.loadURL('about:blank')]);
    const fixtureHtml = '<!doctype html><html><head><base href="https://source.invalid/catalog/"></head><body><main id="fixture"><a data-key="primary" href="/orders/42" data-state="old">Order 42</a><input data-key="choice" type="checkbox" checked="" value="synthetic-private-value"><input data-key="text" value="synthetic-private-text"><button data-key="danger" onclick="window.__websiteActionRan = true">Action</button><script data-key="original-script">window.__websiteScriptRan = true;</script><img src="https://source.invalid/missing.png"><ul data-key="list"><li data-key="first">First</li></ul></main></body></html>';
    await source.webContents.executeJavaScript(`document.documentElement.innerHTML=${JSON.stringify(fixtureHtml.replace(/^<!doctype html><html>|<\/html>$/g, ''))};document.querySelector('[data-key="choice"]').checked=false;true`);
    // Defining the hook before instrumented rrweb starts is required. Function
    // installation itself only defines functions; record starts at its end.
    await source.webContents.executeJavaScript(instrumentRrweb216ForSourcePrototype(rrwebSource));
    await source.webContents.executeJavaScript(`(${installPrototypeRecorder.toString()})()`);
    async function boundary(label: string) {
      return source.webContents.executeJavaScript(`(() => {const s=window.__besS0;const last=s.records.at(-1);return {label:${JSON.stringify(label)},seq:last.seq,timestamp:last.event.timestamp,originalHtml:document.documentElement.outerHTML,primaryId:window.rrweb.record.mirror.getId(document.querySelector('[data-key="primary"]')),choiceId:window.rrweb.record.mirror.getId(document.querySelector('[data-key="choice"]')),lateId:document.querySelector('[data-key="late"]')?window.rrweb.record.mirror.getId(document.querySelector('[data-key="late"]')):null};})()`);
    }
    const initial = await boundary('initial');
    // Keep the three measured states on distinct real clock ticks. The 2.1.6
    // public player seeks by time, so this spike cannot claim same-ms seq seeks.
    await source.webContents.executeJavaScript(`new Promise(resolve=>{function check(){if(Date.now()>${initial.timestamp})resolve(true);else setTimeout(check,0);}check();})`);
    const added = await source.webContents.executeJavaScript(`(async () => {const before=window.__besS0.records.length;const a=document.querySelector('[data-key="primary"]');a.setAttribute('href','../orders/43');a.setAttribute('data-empty','');a.removeAttribute('data-state');const late=document.createElement('a');late.setAttribute('data-key','late');late.setAttribute('href','/orders/late');late.textContent='Late node';document.querySelector('[data-key="list"]').append(late);document.querySelector('[data-key="choice"]').checked=true;document.querySelector('[data-key="choice"]').dispatchEvent(new Event('input',{bubbles:true}));await new Promise((resolve,reject)=>{const deadline=performance.now()+3000;function check(){if(window.__besS0.records.length>before&&window.__besS0.records.some(r=>r.event.type===3&&r.event.data.source===0&&r.event.data.adds.some(a=>a.node.attributes?.['data-key']==='late')))resolve();else if(performance.now()>deadline)reject(new Error('No actual rrweb late-node mutation'));else requestAnimationFrame(check);}check();});return true;})()`);
    assert.equal(added, true);
    const changed = await boundary('changed');
    // A real full snapshot supplies a new reconstruction baseline; nothing is
    // rewritten into old records or padded with manufactured replay events.
    await source.webContents.executeJavaScript(`new Promise(resolve=>{function check(){if(Date.now()>${changed.timestamp})resolve(true);else setTimeout(check,0);}check();})`);
    await source.webContents.executeJavaScript('window.rrweb.record.takeFullSnapshot();true');
    const checkout = await boundary('checkout');
    await source.webContents.executeJavaScript('window.__besS0.stop();true');
    const recording = await source.webContents.executeJavaScript('({records:window.__besS0.records,errors:window.__besS0.errors})') as { records: PrototypeSourceEvent[]; errors: string[] };
    assert.deepEqual(recording.errors, []);
    assert.ok(recording.records.some(entry => entry.event.type === 2));
    assert.ok(recording.records.length < 100, 'Bounded prototype accidentally recorded an expanding tree');
    assert.ok(!JSON.stringify(recording).includes('synthetic-private'), 'Metadata must not bypass input masking');
    report.eventCount = recording.records.length;
    report.sourceRecording = 's0-replay-source-recording.json';
    await writeFile(path.join(studio.root, 's0-replay-source-recording.json'), JSON.stringify(recording, null, 2));
    await replay.webContents.executeJavaScript('document.head.innerHTML=\'<meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; style-src &apos;unsafe-inline&apos;; img-src data:; font-src data:; frame-src &apos;self&apos; about:; form-action &apos;none&apos;">\';document.body.innerHTML=\'<div id="replay-root"></div>\';true');
    await replay.webContents.executeJavaScript(rrwebSource);
    await replay.webContents.executeJavaScript(`window.__besS0Replay=new window.rrweb.Replayer(${JSON.stringify(recording.records.map(entry => entry.event))},{root:document.querySelector('#replay-root'),mouseTail:false,UNSAFE_replayCanvas:false,showWarning:true});true`);
    const seeks: Record<string, unknown>[] = [];
    for (const at of [initial, changed, checkout, initial, changed, checkout]) {
      const model = reconstructPrototypeSource(recording.records, at.seq);
      const sourcePrimary = findSourceNode(model, at.primaryId)!;
      assert.ok(sourcePrimary);
      const locator = prototypeLocators(sourcePrimary);
      // rrweb synchronously applies events whose timestamp is strictly before
      // baselineTime. The half-ms offset includes this integer timestamp only.
      const selection = await replay.webContents.executeJavaScript(`(() => {const player=window.__besS0Replay;player.pause(${at.timestamp - recording.records[0].event.timestamp + 0.5});const frame=document.querySelector('#replay-root iframe');const node=frame.contentDocument.querySelector('[data-key="primary"]');const late=frame.contentDocument.querySelector('[data-key="late"]');const mirror=player.getMirror();return {nodeId:mirror.getId(node),roundTrip:mirror.getNode(mirror.getId(node))===node,href:node?.getAttribute('href'),lateId:late?mirror.getId(late):null,iframeCount:document.querySelectorAll('#replay-root iframe').length,sandbox:frame.getAttribute('sandbox'),scriptRan:frame.contentWindow.__websiteScriptRan===true};})()`);
      assert.equal(selection.nodeId, at.primaryId, `${at.label}: replay selection must resolve the original rrweb ID`);
      assert.equal(selection.roundTrip, true);
      assert.equal(selection.lateId, at.lateId, `${at.label}: late-node binding must follow seek state`);
      assert.equal(selection.sandbox, 'allow-same-origin');
      assert.equal(selection.iframeCount, 1);
      assert.equal(selection.scriptRan, false);
      assert.notEqual(selection.href, sourcePrimary.attributes!.href, 'Fixture must exercise real URL transformation');
      const comparison = await replay.webContents.executeJavaScript(`(${compareOriginalDocuments.toString()})(${JSON.stringify({ model, originalHtml: at.originalHtml, nodeId: at.primaryId, ...locator })})`);
      for (const value of [comparison.model, comparison.independentOriginal]) { assert.equal(value.cssCount, 1); assert.equal(value.xpathCount, 1); assert.equal(value.cssKey, 'primary'); assert.equal(value.xpathKey, 'primary'); }
      assert.equal(comparison.model.cssTarget, true); assert.equal(comparison.model.xpathTarget, true);
      const choice = findSourceNode(model, at.choiceId)!;
      assert.equal(choice.attributes!.checked, '');
      assert.equal(choice.properties!.checked, at.label !== 'initial', 'Original checked attribute is independent from runtime property');
      if (at.label !== 'initial') { assert.equal(sourcePrimary.attributes!['data-empty'], ''); assert.equal(Object.hasOwn(sourcePrimary.attributes!, 'data-state'), false); }
      seeks.push({ label: at.label, sourceSeq: at.seq, sourceTimeMs: at.timestamp, selection, originalHref: sourcePrimary.attributes!.href, locator, comparison, checkedAttribute: choice.attributes!.checked, checkedProperty: choice.properties!.checked });
    }
    // A missing metadata chunk must stop source locator reconstruction visibly.
    const withoutMetadata = recording.records.map(entry => ({ ...entry, metadata: [] }));
    assert.throws(() => reconstructPrototypeSource(withoutMetadata, changed.seq), /Metadata gap/);
    await replay.webContents.executeJavaScript(`(() => {const frame=document.querySelector('#replay-root iframe');frame.contentDocument.querySelector('[data-key="danger"]').click();return true;})()`);
    const actionRan = await replay.webContents.executeJavaScript(`document.querySelector('#replay-root iframe').contentWindow.__websiteActionRan===true`);
    assert.equal(actionRan, false, 'Selecting/replaying original inline handlers must not execute website code');
    await replay.webContents.executeJavaScript('window.__besS0Replay.destroy();delete window.__besS0Replay;true');
    assert.equal(await replay.webContents.executeJavaScript("document.querySelectorAll('#replay-root iframe').length"), 0);
    Object.assign(report, { passed: true, seeks, sourceMetadataGapRejected: true, originalWebsiteActionRan: actionRan, blockedRequests, networkPolicy: 'All HTTP(S) requests cancelled in separate nonpersistent source/replay partitions; replay CSP default-src none', completedAt: new Date().toISOString() });
    console.log('S0 replay/source PASS: actual rrweb record/replay, raw URL and attribute/property distinction, late-node Mirror identity, six seeks, independent CSS/XPath and metadata gap');
    return report;
  } catch (error) {
    report.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
    throw error;
  } finally {
    await writeFile(path.join(studio.root, 's0-replay-prototype-report.json'), JSON.stringify(report, null, 2));
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    sourcePartition.webRequest.onBeforeRequest(null); replayPartition.webRequest.onBeforeRequest(null);
  }
}
