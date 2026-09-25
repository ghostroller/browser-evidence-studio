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
import type { PresentationSample, RecordingEnvelope } from '@/capture/recording-types';
import type { HistoricalElementRef, ReplayPosition } from '@/contracts/recording';
import { CaptureBudget, DeferredBodyReads } from '@/capture/budget';
import { ResourceArchive, ResourceCapture, RESOURCE_MAX_BYTES } from '@/resources/archive';
import { redactHtml, responsePrivacy } from '@/capture/privacy';
import { rewriteCssUrls, rewriteSrcset } from '@/resources/rewrite';
import { captureError, captureMetadata, credentialUrl } from '@/capture/url-privacy';
import { RequestLedger } from '@/capture/request-ledger';
import { captureRequestBody, requestMetadata } from '@/capture/request-body';
import { prepareResponseBody, RESPONSE_CAPTURE_BYTES } from '@/capture/response-body';
import { EvidenceReader } from '@/evidence/reader';

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
  Object.defineProperty(dom.window.crypto,'randomUUID',{value:undefined});
  Object.assign(dom.window, { syntheticBinding: (payload: string) => { const parsed = JSON.parse(payload); records.push({ ...parsed, receivedAt: new Date().toISOString(), gaps: parsed.errors.map((reason: string) => ({ id: randomUUID(), from: parsed.position, category: 'metadata', reason })) }); } });
  const bundle = await fs.readFile(path.resolve('node_modules/rrweb/dist/rrweb.umd.cjs'), 'utf8');
  if(fixedTime)dom.window.Date.now=()=>fixedTime;
  dom.window.eval(instrumentRecorder(bundle));
  dom.window.eval(`(${installSourceRecorder.toString()})(${JSON.stringify({ binding: 'syntheticBinding', recordingId: 'recording', pageId: 'page', checkoutEveryNms: 30000, checkoutEveryNth: 500 })},${credentialUrl.toString()})`);
  await new Promise<void>(resolve => dom.window.setTimeout(resolve, 0));
  return { dom, records };
}
function target(records: RecordingEnvelope[], key = 'a'): HistoricalElementRef {
  const last = records.at(-1)!, model = new SourceModel(records.slice(records.findIndex(record => record.event.type === 2)));
  const node = [...model.nodes.values()].find(node => node.metadata?.tagName === key)!;
  return { kind: 'dom-node', position: last.position, nodeId: node.id, frameId: node.metadata!.frameId, mirrorScopeId: node.metadata!.mirrorScopeId };
}
describe('format-2 production recorder and bounded archive', () => {
  it('samples only an explicit source node at its own rrweb boundary and leaves unsampled history missing',async()=>{
    const {dom,records}=await source('<a id="sample">source structure text</a><p id="untouched">other node</p><input value="private-input"><div class="rr-mask" id="masked">private-mask</div>');
    const ref=target(records),before=new SourceModel(records.slice(records.findIndex(record=>record.event.type===2)));
    expect(before.node(ref).presentation).toEqual({status:'missing',reason:'no-source-presentation-observation'});
    let reads=0;const element=dom.window.document.querySelector('a')!;
    Object.defineProperty(element,'innerText',{get(){reads++;return 'source displayed value';}});
    Object.defineProperty(dom.window.document.querySelector('p'),'innerText',{get(){throw new Error('Must not recursively sample unrelated nodes');}});
    const sampler=(dom.window as unknown as {__besSamplePresentation(ref:HistoricalElementRef):Promise<PresentationSample>}).__besSamplePresentation;
    const sampled=await sampler(ref);expect(reads).toBe(1);expect(sampled.ref.position.eventSeq).toBeGreaterThan(ref.position.eventSeq);
    expect(sampled.presentation).toMatchObject({status:'present',value:{text:'source displayed value',sampledAt:sampled.ref.position}});
    const last=records.at(-1)!;expect(last.event).toMatchObject({type:5,data:{tag:'bes-source-presentation'}});expect(last.position).toEqual(sampled.ref.position);
    const evidence=await store(),writer=new RecordingIndexWriter(evidence);
    for(const record of records)await writer.append(record);await evidence.flush();
    expect((await new ArchiveReplayService(evidence.runDir).node(sampled.ref,{maxBytes:65536,limit:1})).presentation).toEqual(sampled.presentation);
    await expect(sampler({...ref,mirrorScopeId:'different-scope'})).rejects.toThrow('current source mirror');
    const input=target(records,'input');const privateSample=await sampler(input);expect(privateSample.presentation.status).toBe('redacted');
    expect(JSON.stringify(records)).not.toContain('private-input');expect(JSON.stringify(records)).not.toContain('private-mask');
  });
  it('excludes malformed JSON before saving bytes and retains safe diagnostic identity',()=>{
    const malformed=responsePrivacy(Buffer.from('{"token":"malformed-private"'),'application/json');
    expect(malformed.data).toBeUndefined();expect(malformed).toMatchObject({redacted:true,excludedReason:'response-json-privacy-unverifiable',privacyError:{name:'SyntaxError'}});
    expect(JSON.stringify(malformed)).not.toContain('malformed-private');
    expect(captureError(Object.assign(new Error('password=error-private'),{code:'ENOSPC'}))).toEqual({name:'Error',code:'ENOSPC',message:'[redacted credential-bearing error message]'});
    expect(captureError(Object.assign(new Error('Disk write failed'),{code:'ENOSPC'}))).toEqual({name:'Error',code:'ENOSPC',message:'Disk write failed'});
  });
  it('keeps captured bytes after a failed cache probe but preserves failure of an actual later request',async()=>{
    const evidence=await store(),capture=new ResourceCapture(evidence),archive=new ResourceArchive(evidence.runDir);
    const position:ReplayPosition={recordingId:'recording',pageId:'page',documentId:'document',streamEpoch:'epoch',sourceTimeMs:1,eventSeq:5};
    const input={position,frameId:'top',url:'https://source.invalid/font.woff',mediaType:'font/woff'};
    const captured=await capture.capture({...input,requestId:'request-first',data:Buffer.from('original-font')});
    const probe=await capture.capture({...input,status:'failed',reason:'browser-cached-resource-unavailable',source:{fromCache:true}});
    expect((await archive.resolve(input.url,position))?.id).toBe(captured.id);
    const changed=await capture.capture({...input,requestId:'request-new-version',position:{...position,eventSeq:6},status:'failed',reason:'observed-response-body-unavailable'});
    await capture.capture({...input,position:{...position,eventSeq:6},status:'failed',reason:'browser-cached-resource-unavailable',source:{fromCache:true}});
    expect((await archive.resolve(input.url,{...position,eventSeq:6}))?.id).toBe(changed.id);
    expect((await archive.reference(probe.id)).status).toBe('failed');await expect(archive.read(changed.id)).rejects.toThrow('failed');
  });
  it('persists a 9 MiB observed response as an 8 MiB prefix with measured original bytes and checks its private tail',async()=>{
    const bytes=9*1024*1024,text='{"rows":"'+'x'.repeat(bytes-11)+'"}';expect(Buffer.byteLength(text)).toBe(bytes);
    const prepared=prepareResponseBody({body:text,base64Encoded:false},'application/json');
    expect(prepared.observedBytes).toBe(bytes);expect(prepared.data?.length).toBe(RESPONSE_CAPTURE_BYTES);
    const evidence=await store(),artifact=await evidence.putArtifactPrefix({kind:'response-body',mediaType:'application/json',data:prepared.data,limitBytes:RESPONSE_CAPTURE_BYTES},prepared.observedBytes!);
    expect(artifact).toMatchObject({captureStatus:'truncated',capturedBytes:RESPONSE_CAPTURE_BYTES,originalBytes:bytes});
    const page=await new EvidenceReader(evidence.runDir).artifact(artifact.id,{maxBytes:1024});
    expect(typeof page.text).toBe('string');const readText=String(page.text);
    expect(readText.length).toBeGreaterThan(0);expect(readText).toBe(text.slice(0,readText.length));
    expect((await fs.stat(path.join(evidence.runDir,artifact.path!))).size).toBe(RESPONSE_CAPTURE_BYTES);
    const privateTail=prepareResponseBody({body:'x'.repeat(RESPONSE_CAPTURE_BYTES+1)+' https://a.invalid/?access_token=private-tail',base64Encoded:false},'text/plain');
    expect(privateTail.data).toBeUndefined();expect(privateTail.excludedReason).toBe('credential-bearing-large-response');
    const unicode=prepareResponseBody({body:'x'.repeat(RESPONSE_CAPTURE_BYTES-1)+'🙂'+'x'.repeat(1024),base64Encoded:false},'text/plain');
    expect(unicode.data?.length).toBe(RESPONSE_CAPTURE_BYTES-1);expect(unicode.observedBytes).toBe(RESPONSE_CAPTURE_BYTES+1027);
    await expect(evidence.putArtifactPrefix({kind:'response-body',mediaType:'text/plain',data:'abc',limitBytes:3},2)).rejects.toThrow('measured original bytes');
  });
  it('redacts credential URLs in every newly captured representation while preserving public URL literals',async()=>{
    const privateUrl='https://source.invalid/submit?access_token=synthetic-url-private',publicUrl='../orders/42?sort=descending&empty=';
    const html=`<a href="${privateUrl}">private link</a><img src="${privateUrl}"><form action="${privateUrl}"></form><a href="${publicUrl}">public link</a><p>${privateUrl}</p>`;
    const {records}=await source(html);expect(JSON.stringify(records)).not.toContain('synthetic-url-private');
    expect(redactHtml(html).text).not.toContain('synthetic-url-private');expect(redactHtml(`<a href="${publicUrl}">public</a>`).text).toBe(`<a href="${publicUrl}">public</a>`);
    const evidence=await store();const request={method:'GET',url:privateUrl,headers:{Referer:privateUrl}};
    const metadata=requestMetadata(request),artifact=await captureRequestBody(request,{source:{url:privateUrl},acquireRead:()=>({release(){}}),readPostData:async()=>({})});
    await evidence.appendRaw('cdp',metadata);await evidence.appendEvent({type:'navigation',source:'cdp',data:captureMetadata({url:privateUrl})});await evidence.putArtifact(artifact);await evidence.flush();
    const files=['artifacts.jsonl'];for(const directory of ['raw/cdp','journal'])for(const name of await fs.readdir(path.join(evidence.runDir,directory))){if(name.endsWith('.jsonl'))files.push(path.join(directory,name));}
    for(const file of files)expect(await fs.readFile(path.join(evidence.runDir,file),'utf8')).not.toContain('synthetic-url-private');
    expect(captureMetadata({url:publicUrl})).toEqual({url:publicUrl});expect(captureMetadata({url:privateUrl})).toMatchObject({capturePrivacy:{credentialUrls:'redacted'}});
    for(const url of ['https://user:private@source.invalid/', '/page#access_token=private','/page#/route?api_key=private','/page?%74oken=private'])expect(credentialUrl(url)).toBe(true);
    expect(responsePrivacy(Buffer.from(JSON.stringify(privateUrl)),'application/json').data?.toString()).not.toContain('synthetic-url-private');
    const resourceCapture = new ResourceCapture(evidence), position = records.at(-1)!.position;
    const resource = await resourceCapture.capture({position,frameId:'top',url:'https://source.invalid/public.css',mediaType:'text/css',data:Buffer.from(`a{background:url("${privateUrl}")}`)});
    expect(resource.status).toBe('redacted');expect(resource.blobHash).toBeUndefined();
  });
  it('invalidates queued and in-flight response reads when a request ID is reused',async()=>{
    const ledger=new RequestLedger('session','target'),queue=new DeferredBodyReads();let unblock!:()=>void;const blocker=new Promise<void>(resolve=>{unblock=resolve;});
    queue.add(()=>blocker,100);const first=ledger.begin({requestId:'same',url:'https://a.invalid/first',redirect:false}).current;
    const read=ledger.acquireResponseRead('same');expect(ledger.finish('same')).toBe(first);
    let acceptedBody=false;queue.add(async()=>{acceptedBody=!read.invalidated;read.release();},100);
    ledger.begin({requestId:'same',url:'https://a.invalid/second',redirect:false});unblock();await queue.flush();expect(acceptedBody).toBe(false);
    const second=ledger.acquireResponseRead('same');ledger.finish('same');expect(second.invalidated).toBeUndefined();ledger.reset();expect(second.invalidated).toContain('capture-reset');second.release();
  });
  it('keeps privacy across rrweb, raw metadata, HTML and JSON response representations',async()=>{
    const html='<input type="checkbox" checked value="private-checkbox"><textarea>private-textarea</textarea><div class="rr-mask" aria-label="private-label">private-visible-text</div><a __proto__="original-attribute" href="/safe">safe</a>';
    const {records}=await source(html);
    const raw=JSON.stringify(records);for(const secret of ['private-checkbox','private-textarea','private-visible-text','private-label'])expect(raw).not.toContain(secret);
    const redacted=redactHtml(html);expect(redacted.redacted).toBe(true);for(const secret of ['private-checkbox','private-textarea','private-visible-text'])expect(redacted.text).not.toContain(secret);
    expect(redacted.text).toContain('checked');
    const json=responsePrivacy(Buffer.from('{"accessToken":"private-token","rows":[{"id":1,"value":"public-value"}]}'),'application/json');expect(json.redacted).toBe(true);expect(json.data!.toString()).not.toContain('private-token');expect(json.data!.toString()).toContain('public-value');
    const model=new SourceModel(records.slice(records.findIndex(record=>record.event.type===2))),ref=target(records);
    expect(model.node(ref).attributes.__proto__).toEqual({status:'present',value:'original-attribute'});
    expect(model.attribute(model.nodes.get(ref.nodeId)!,'constructor')).toEqual({status:'absent'});
  });
  it('rewrites CSS URL tokens and srcset candidates without rewriting ordinary strings or comments',()=>{
    const seen:string[]=[];const resolve=(url:string)=>{seen.push(url);return 'bes-resource://archive/'+seen.length;};
    const css='/* url(ignored.png) */ @import "nested.css"; a {content:"url(ordinary-text)";background:url("im\\61 ge.png")}';
    const result=rewriteCssUrls(css,resolve);expect(seen).toEqual(['nested.css','image.png']);expect(result).toContain('url(ordinary-text)');expect(result).toContain('url(ignored.png)');
    const candidates:string[]=[];expect(rewriteSrcset('one.png 1x, two.png 2x',url=>{candidates.push(url);return 'offline:'+url;})).toBe('offline:one.png 1x, offline:two.png 2x');expect(candidates).toEqual(['one.png','two.png']);
  });
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
  it('queues a bounded number of lightweight descriptors and serializes concurrent large body reads',async()=>{
    const queue=new DeferredBodyReads(1024,3);let active=0,peak=0,release!:()=>void;const done:number[]=[];
    expect(queue.add(async()=>{active++;peak=Math.max(peak,active);await new Promise<void>(resolve=>{release=resolve;});done.push(1);active--;},256)).toBe(true);
    expect(queue.add(async()=>{active++;peak=Math.max(peak,active);done.push(2);active--;},256)).toBe(true);
    expect(queue.add(async()=>{active++;peak=Math.max(peak,active);done.push(3);active--;},256)).toBe(true);
    expect(queue.add(async()=>{throw new Error('Must not execute a rejected descriptor');},256)).toBe(false);
    await Promise.resolve();expect(active).toBe(1);release();await queue.flush();expect(done).toEqual([1,2,3]);expect(peak).toBe(1);expect(queue.metrics()).toMatchObject({queuedBytes:0,activeReads:0,peakDescriptorBytes:768,rejected:1});
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
