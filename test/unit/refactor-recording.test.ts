import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EvidenceStore } from '@/evidence/store';
import { RecordingArchive, RecordingIndexWriter } from '@/replay/archive';
import { SourceModel } from '@/replay/source-model';
import { ArchiveReplayService, ReplayViewSession } from '@/replay/service';
import { sourceLocators } from '@/replay/locators';
import { instrumentRecorder } from '@/capture/rrweb-adapter';
import { installSourceRecorder } from '@/capture/source-recorder';
import type { RecordingEnvelope } from '@/capture/recording-types';
import type { HistoricalElementRef, ReplayPosition } from '@/contracts/recording';
import { CaptureBudget } from '@/capture/budget';
import { ResourceArchive, ResourceCapture, RESOURCE_MAX_BYTES } from '@/resources/archive';

const stores: EvidenceStore[] = [], windows: JSDOM[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const window of windows.splice(0)) window.window.close(); });
async function store() {
  const root = path.resolve('output', 'refactor-a-tests', randomUUID());
  const store = await EvidenceStore.create(path.join(root, 'runs', 'recording'), { id: 'recording', projectId: 'synthetic', mode: 'synthetic', kind: 'demonstrate', objective: 'format-2 verification' }, { chunkBytes: 2048 });
  stores.push(store); return store;
}
async function source(html = '<main id="main"><a data-key="订单\'&quot;" href="../orders/42">first</a><input type="checkbox" value="synthetic-private" checked><select><option value="synthetic-option-private" selected>one</option><option>two</option></select><ul><li>first</li></ul></main>', fixedTime?: number) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url: 'https://source.invalid/catalog/', runScripts: 'dangerously', pretendToBeVisual: true });
  windows.push(dom); const records: RecordingEnvelope[] = [];
  Object.assign(dom.window, { syntheticBinding: (payload: string) => { const parsed = JSON.parse(payload); records.push({ ...parsed, receivedAt: new Date().toISOString(), gaps: parsed.errors.map((reason: string) => ({ id: randomUUID(), from: parsed.position, category: 'metadata', reason })) }); } });
  const bundle = await fs.readFile(path.resolve('node_modules/rrweb/dist/rrweb.umd.cjs'), 'utf8');
  if(fixedTime)dom.window.Date.now=()=>fixedTime;
  dom.window.eval(instrumentRecorder(bundle));
  dom.window.eval(`(${installSourceRecorder.toString()})(${JSON.stringify({ binding: 'syntheticBinding', recordingId: 'recording', pageId: 'page', checkoutEveryNms: 30000, checkoutEveryNth: 500 })})`);
  await new Promise<void>(resolve => dom.window.setTimeout(resolve, 0));
  return { dom, records };
}
function target(records: RecordingEnvelope[], key = 'a'): HistoricalElementRef {
  const last = records.at(-1)!, model = new SourceModel(records.slice(records.findIndex(record => record.event.type === 2)));
  const node = [...model.nodes.values()].find(node => node.metadata?.tagName === key)!;
  return { kind: 'dom-node', position: last.position, nodeId: node.id, frameId: node.metadata!.frameId, mirrorScopeId: node.metadata!.mirrorScopeId };
}
describe('format-2 production recorder and bounded archive', () => {
  it('captures actual rrweb source attributes, form privacy and independent original CSS/XPath matches', async () => {
    const { dom, records } = await source();
    expect(records.some(record => record.event.type === 2)).toBe(true);
    const a = dom.window.document.querySelector('a')!;
    a.setAttribute('href', '../orders/43'); a.setAttribute('data-empty', '');
    a.textContent = 'changed'; dom.window.document.querySelector('li')!.remove();
    const li = dom.window.document.createElement('li'); li.textContent = 'second'; dom.window.document.querySelector('ul')!.appendChild(li);
    const input = dom.window.document.querySelector('input')!; input.checked = false; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await new Promise<void>(resolve => dom.window.setTimeout(resolve, 20));
    const model = new SourceModel(records.slice(records.findIndex(record => record.event.type === 2)));
    const ref = target(records), original = model.node(ref);
    expect(original.attributes.href).toEqual({ status: 'present', value: '../orders/43' });
    expect(original.attributes['data-empty']).toEqual({ status: 'present', value: '' });
    expect(original.text).toEqual({ status: 'present', value: 'changed' });
    expect(JSON.stringify(records)).not.toContain('synthetic-private');
    expect(JSON.stringify(records)).not.toContain('synthetic-option-private');
    const inputRef = target(records, 'input');
    expect(model.node(inputRef).properties.checked).toEqual({ status: 'present', value: false });
    expect(model.node(inputRef).attributes.checked).toEqual({ status: 'present', value: '' });
    expect(model.node(inputRef).properties.value?.status).toBe('redacted');
    for (const candidate of sourceLocators(model, ref)) {
      const expression = candidate.steps.at(-1)!;
      if (expression.strategy === 'css') {
        const matches = [...dom.window.document.querySelectorAll(expression.expression)];
        expect(matches.length, expression.expression).toBe(candidate.historical.matchCount); expect(matches.includes(a)).toBe(true);
      } else {
        const matches = dom.window.document.evaluate(expression.expression, dom.window.document, null, dom.window.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        expect(matches.snapshotLength, expression.expression).toBe(candidate.historical.matchCount); expect(matches.snapshotItem(0)).toBe(a);
      }
    }
  });
  it('reads exact same-millisecond event boundaries, verifies raw bytes and rebuilds a corrupt index without modifying originals', async () => {
    const { dom, records } = await source(undefined,1790367000000);
    const full = records.find(record => record.event.type === 2)!;
    const index = records.indexOf(full); const initial = records.slice(index);
    // The source clock was frozen before loading rrweb, which retains Date.now.
    dom.window.document.querySelector('a')!.textContent = 'same-ms-1';
    await new Promise<void>(resolve => dom.window.setTimeout(resolve, 10));
    const first = records.at(-1)!;
    dom.window.document.querySelector('a')!.textContent = 'same-ms-2';
    await new Promise<void>(resolve => dom.window.setTimeout(resolve, 10));
    const second = records.at(-1)!;
    expect(first.position.sourceTimeMs).toBe(second.position.sourceTimeMs); expect(second.position.eventSeq).toBeGreaterThan(first.position.eventSeq);
    const evidence = await store(), writer = new RecordingIndexWriter(evidence);
    for (const record of records) await writer.append(record);
    const service = new ArchiveReplayService(evidence.runDir), firstWindow = await service.window(first.position), secondWindow = await service.window(second.position);
    const firstRef = target(firstWindow.records), secondRef = target(secondWindow.records);
    expect(new SourceModel(firstWindow.records).node(firstRef).text).toEqual({ status: 'present', value: 'same-ms-1' });
    expect(new SourceModel(secondWindow.records).node(secondRef).text).toEqual({ status: 'present', value: 'same-ms-2' });
    expect(firstWindow.readBytes).toBeLessThan(64 * 1024 * 1024);
    expect(initial.length).toBeGreaterThan(0);
    await evidence.seal();
    const rawPaths = (await fs.readdir(path.join(evidence.runDir, 'raw/rrweb'))).sort();
    const before = await Promise.all(rawPaths.map(file => fs.readFile(path.join(evidence.runDir, 'raw/rrweb', file), 'utf8')));
    const archive = new RecordingArchive(evidence.runDir), rebuilt = await archive.rebuild();
    expect(rebuilt.corruptCount).toBe(0); expect(rebuilt.records).toBe(records.length);
    expect(await Promise.all(rawPaths.map(file => fs.readFile(path.join(evidence.runDir, 'raw/rrweb', file), 'utf8')))).toEqual(before);
    expect((await archive.window(second.position)).records.at(-1)!.position).toEqual(second.position);
    await expect(service.node(secondRef, { maxBytes: 1, limit: 1 })).rejects.toMatchObject({ statusCode: 413 });
    await expect(service.window({ ...second.position, sourceTimeMs: second.position.sourceTimeMs + 1 })).rejects.toThrow();
  });
  it('does not let metadata gaps or index tampering hide source unreliability; a later full snapshot recovers', async () => {
    const { records, dom } = await source(); const evidence = await store(), writer = new RecordingIndexWriter(evidence);
    for (const record of records) await writer.append(record);
    dom.window.document.querySelector('a')!.setAttribute('href', '/gap'); await new Promise<void>(resolve => dom.window.setTimeout(resolve, 10));
    const lost = { ...records.at(-1)!, metadata: [], metadataComplete: false };
    await writer.append(lost);
    const archive = new RecordingArchive(evidence.runDir);
    expect((await archive.window(lost.position)).gaps.some(gap => gap.category === 'metadata')).toBe(true);
    const directories = await fs.readdir(path.join(evidence.runDir, 'replay-index'));
    const filename = path.join(evidence.runDir, 'replay-index', directories[0], `${lost.position.eventSeq}.json`);
    const index = JSON.parse(await fs.readFile(filename, 'utf8')); index.gaps = []; await fs.writeFile(filename, JSON.stringify(index));
    expect((await archive.window(lost.position)).gaps.some(gap => gap.category === 'metadata')).toBe(true);
    dom.window.eval('rrweb.record.takeFullSnapshot()'); const recovered = records.at(-1)!; await writer.append(recovered);
    expect((await archive.window(recovered.position)).gaps).toEqual([]);
    expect((await archive.window(lost.position)).gaps.some(gap => gap.category === 'metadata')).toBe(true);
  });
  it('reserves actual response working memory separately from structure and releases each generation', async () => {
    const budgets = new CaptureBudget(); const big = budgets.reserve('network', 32 * 1024 * 1024)!;
    expect(budgets.reserve('network', 16 * 1024 * 1024)).toBeNull();
    const structural = budgets.reserve('structure', 8 * 1024 * 1024)!; structural(); big();
    expect(budgets.snapshot().network?.activeBytes).toBe(0); expect(budgets.snapshot().network?.rejectedTasks).toBe(1);
    const view = new ReplayViewSession<string>(); let resolve!: (result: { value: string; dispose: () => void }) => void;
    let oldDisposed = false, currentDisposed = false;
    const old = view.seek(() => new Promise(done => { resolve = done; }));
    expect(await view.seek(async () => ({ value: 'new', dispose: () => { currentDisposed = true; } }))).toBe('new');
    resolve({ value: 'old', dispose: () => { oldDisposed = true; } }); expect(await old).toBeUndefined();
    expect(oldDisposed).toBe(true); view.dispose(); expect(currentDisposed).toBe(true);
  });
  it('archives different bytes for one URL, excludes credentials and bounds huge resources without fetching', async () => {
    const evidence = await store(), capture = new ResourceCapture(evidence), archive = new ResourceArchive(evidence.runDir);
    const position: ReplayPosition = { recordingId: 'recording', pageId: 'page', documentId: 'document', streamEpoch: 'epoch', sourceTimeMs: 1, eventSeq: 1 };
    const input = { position, frameId: 'top', url: 'https://source.invalid/style.css', mediaType: 'text/css' };
    const first = await capture.capture({ ...input, data: Buffer.from('body { color: red }') });
    const second = await capture.capture({ ...input, position: { ...position, eventSeq: 2 }, data: Buffer.from('body { color: blue }') });
    expect(first.blobHash).not.toBe(second.blobHash); expect((await archive.read(first.id)).bytes.toString()).toContain('red');
    const secret = await capture.capture({ ...input, url: input.url + '?token=synthetic-private', data: Buffer.from('secret') });
    expect(secret.status).toBe('redacted'); expect(JSON.stringify(secret)).not.toContain('synthetic-private');
    await expect(archive.read(secret.id)).rejects.toThrow('redacted');
    const oversized = await capture.capture({ ...input, data: new Uint8Array(RESOURCE_MAX_BYTES + 1) }); expect(oversized.reason).toBe('resource-byte-budget');
    await expect(archive.read('../manifest')).rejects.toThrow();
    expect((await archive.list(2)).nextCursor).toBeDefined();
  });
});
