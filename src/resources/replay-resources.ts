import type { eventWithTime, serializedNodeWithId } from '@rrweb/types';
import type { ReplayPosition } from '@/contracts/recording';
import { ResourceArchive } from './archive';
import { OFFLINE_CSP, rewriteCssUrls, rewriteSrcset } from './rewrite';
import type { RecordingEnvelope } from '@/capture/recording-types';
import type { ArchivedResource } from './archive';
import { RecordingArchive } from '@/replay/archive';
import { SourceModel } from '@/replay/source-model';

export const resourceUrl = (id: string): string => `bes-resource://archive/${id}`;
/** Data bytes are already literal source content in the recorded event/CSS.
 * Only small raster/font encodings may cross the offline presentation boundary. */
function inlineDataResource(url: string): boolean {
  if (url.length > 350_000) return false;
  const match = /^data:(image\/(?:png|jpeg|gif|webp)|font\/(?:woff2?|ttf));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url);
  if (!match) return false;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > 256 * 1024 || bytes.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) return false;
  const mime = match[1].toLowerCase();
  return mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8
    : mime === 'image/gif' ? bytes.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/) !== null
    : mime === 'image/webp' ? bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    : mime === 'font/woff' ? bytes.subarray(0, 4).toString('ascii') === 'wOFF'
    : mime === 'font/woff2' ? bytes.subarray(0, 4).toString('ascii') === 'wOF2'
    : mime === 'font/ttf' ? bytes.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0]))
    : false;
}
type ElementContext = { tagName?: string; rel?: string };
type ResourceUseSite = { nodeId: number; attribute: string };
function loadableAttribute(name: string, context: ElementContext): boolean {
  const tag = context.tagName?.toLowerCase();
  if (name === 'src' || name === 'rr_src') return ['img', 'audio', 'video', 'source', 'track', 'embed', 'input'].includes(tag ?? '');
  if (name === 'srcset') return tag === 'img' || tag === 'source';
  if (name === 'poster') return tag === 'video';
  if (name === 'background') return ['body', 'table', 'td', 'th'].includes(tag ?? '');
  if (name === 'href' && tag === 'link') return /\b(stylesheet|icon|preload)\b/i.test(context.rel ?? '');
  if (name === 'href' || name === 'xlink:href') return tag === 'image' || tag === 'use';
  return false;
}
/** Presentation copy only. Original URLs and SourceMetadata remain untouched. */
export function rewriteReplayEvent(original: eventWithTime, resolve: (url: string, frameId?:string, site?:ResourceUseSite) => string,
  frameForNode?: (nodeId:number)=>string|undefined, frameForStyle?: (styleId:number)=>string|undefined,
  elementForNode?: (nodeId:number)=>ElementContext|undefined, frameForStyleText?: (nodeId:number)=>string|undefined): eventWithTime {
  const event = structuredClone(original);
  function attributes(attributes: Record<string, unknown>,nodeId:number,element?:ElementContext): void {
    const resolveNode=(url:string,attribute:string)=>resolve(url,frameForNode?frameForNode(nodeId):'top',{nodeId,attribute});
    const context={...elementForNode?.(nodeId),...element};
    const rel=typeof attributes.rel==='string'?attributes.rel:context.rel;
    for (const [name, value] of Object.entries(attributes)) {
      if (name.startsWith('on') || ['action', 'formaction', 'srcdoc', 'ping'].includes(name)) { delete attributes[name]; continue; }
      if (typeof value !== 'string') continue;
      if (name === '_cssText' || name === 'style') attributes[name] = rewriteCssUrls(value, url=>resolveNode(url,name));
      else if (name === 'srcset') attributes[name] = loadableAttribute(name,context) ? rewriteSrcset(value, url=>resolveNode(url,name)) : 'about:blank';
      else if (['src', 'href', 'poster', 'xlink:href', 'background', 'rr_src'].includes(name)) {
        attributes[name] = loadableAttribute(name,{...context,rel}) ? (value.startsWith('#') ? value : resolveNode(value,name)) : 'about:blank';
      }
    }
  }
  function tree(node: serializedNodeWithId): void {
    if (node.type === 2) {
      attributes(node.attributes,node.id,{tagName:node.tagName,rel:typeof node.attributes.rel==='string'?node.attributes.rel:undefined});
      if (node.tagName === 'style') for (const child of node.childNodes) if (child.type === 3) child.textContent = rewriteCssUrls(child.textContent, url=>resolve(url,frameForNode?frameForNode(node.id):'top'));
      if (node.tagName === 'iframe') { delete node.attributes.src; delete node.attributes.rr_src; }
    }
    if ('childNodes' in node) node.childNodes.forEach(tree);
  }
  if (event.type === 2) tree(event.data.node);
  if (event.type === 4) event.data.href = 'about:blank';
  if (event.type === 3) {
    if (event.data.source === 0) { event.data.adds.forEach(addition => tree(addition.node)); event.data.attributes.forEach(change => attributes(change.attributes,change.id));event.data.texts.forEach(change=>{const frame=frameForStyleText?.(change.id);if(frame&&change.value!==null)change.value=rewriteCssUrls(change.value,url=>resolve(url,frame));}); }
    if (event.data.source === 8) {
      const frame = event.data.id !== undefined ? frameForNode?.(event.data.id) : event.data.styleId !== undefined ? frameForStyle?.(event.data.styleId) : undefined;
      const css = (url: string) => resolve(url, frame);
      event.data.adds?.forEach(addition => { addition.rule = rewriteCssUrls(addition.rule, css); });
      if (event.data.replace !== undefined) event.data.replace = rewriteCssUrls(event.data.replace, css);
      if (event.data.replaceSync !== undefined) event.data.replaceSync = rewriteCssUrls(event.data.replaceSync, css);
    }
    if (event.data.source === 13 && event.data.set?.value != null) {
      const frame = event.data.id !== undefined ? frameForNode?.(event.data.id) : event.data.styleId !== undefined ? frameForStyle?.(event.data.styleId) : undefined;
      event.data.set.value = rewriteCssUrls(event.data.set.value, url => resolve(url, frame));
    }
    if (event.data.source === 15) { const frame=frameForNode?.(event.data.id);event.data.styles?.forEach(style => style.rules.forEach(rule => { rule.rule = rewriteCssUrls(rule.rule, url => resolve(url, frame)); })); }
  }
  return event;
}

/** Advance original per-node frame scopes alongside the source event stream;
 * callers bind the URL lookup to that logical frame, never to the live profile. */
export function rewriteReplayRecords(records:RecordingEnvelope[],resolve:(url:string,frameId:string|undefined,position:ReplayPosition,site?:ResourceUseSite)=>string):RecordingEnvelope[]{
  const frames=new Map<number,string>(),styles=new Map<number,string>(),elements=new Map<number,ElementContext>(),styleTexts=new Map<number,string>();
  return records.map(record=>{
    if(record.event.type===2){frames.clear();styles.clear();elements.clear();styleTexts.clear();}
    for(const metadata of record.metadata){
      frames.set(metadata.nodeId,metadata.frameId);
      elements.set(metadata.nodeId,{tagName:metadata.tagName,rel:metadata.attributes.rel?.status==='present'?metadata.attributes.rel.value:undefined});
    }
    const event = record.event;
    const observeTree=(node:serializedNodeWithId,styleFrame?:string):void=>{
      const frame=node.type===2&&node.tagName==='style'?frames.get(node.id):styleFrame;
      if(node.type===3&&frame)styleTexts.set(node.id,frame);
      if('childNodes' in node)node.childNodes.forEach(child=>observeTree(child,frame));
    };
    if(event.type===2)observeTree(event.data.node);
    if(event.type===3&&event.data.source===0){
      for(const addition of event.data.adds){const parentFrame=styleTexts.get(addition.parentId)??(elements.get(addition.parentId)?.tagName==='style'?frames.get(addition.parentId):undefined);observeTree(addition.node,parentFrame);}
      for(const removal of event.data.removes)styleTexts.delete(removal.id);
    }
    if(event.type===3&&event.data.source===15){const frame=frames.get(event.data.id);if(frame)for(const style of event.data.styles??[])styles.set(style.styleId,frame);}
    return{...record,event:rewriteReplayEvent(record.event,(url,frame,site)=>resolve(url,frame,record.position,site),id=>frames.get(id),id=>styles.get(id),id=>elements.get(id),id=>styleTexts.get(id))};
  });
}

export interface ReplayResourceDiagnostic {
  url: string; frameId?: string; position: ReplayPosition;
  /** For pending references activated by a later recorded structural event. */
  resolvedAt?: ReplayPosition;
  status: 'pending' | 'missing' | 'excluded' | 'unsupported' | 'read-failed'; reason: string;
}
function observedMs(value?:string):number|undefined { const parsed=value===undefined?NaN:Date.parse(value);return Number.isFinite(parsed)?parsed:undefined; }
function status(reference:ArchivedResource|undefined):ReplayResourceDiagnostic['status'] {
  return reference?.status==='redacted'?'excluded':reference?.status==='unsupported'?'unsupported':'missing';
}
async function previousSourceWindow(archive:ResourceArchive,first:ReplayPosition):Promise<RecordingEnvelope[]|undefined>{
  if(first.eventSeq===0)return undefined;
  const source=new RecordingArchive(archive.runDir),start=(await source.positions(first,1,0)).items[0]?.position;
  if(!start||start.eventSeq>=first.eventSeq)return undefined;
  const windows:RecordingEnvelope[][]=[];let cursor=first,totalBytes=0,totalEvents=0;
  // A stable link may survive several full snapshots. Walk only bounded,
  // immediately preceding source windows; never choose a recording-wide latest.
  for(let depth=0;depth<8&&cursor.eventSeq>start.eventSeq;depth++){
    let low=0,high=cursor.eventSeq-start.eventSeq,previous:ReplayPosition|undefined;
    while(low<=high){
      const middle=Math.floor((low+high)/2),item=(await source.positions(first,1,middle)).items[0]?.position;
      if(item&&item.eventSeq<cursor.eventSeq){previous=item;low=middle+1;}else high=middle-1;
    }
    if(!previous)break;
    let window;try{window=await source.window(previous);}catch{break;}
    if(!window.records.length||window.records[0].position.eventSeq>=cursor.eventSeq)break;
    totalBytes+=window.readBytes;totalEvents+=window.records.length;
    if(totalBytes>REPLAY_MAX_PRIOR_BYTES||totalEvents>4096)return undefined;
    windows.unshift(window.records);cursor=window.records[0].position;
  }
  return windows.length?windows.flat():undefined;
}
const REPLAY_MAX_PRIOR_BYTES=64*1024*1024;
function sameSourceAttribute(a:ReturnType<SourceModel['attribute']>,b:ReturnType<SourceModel['attribute']>):boolean{
  return a.status==='present'&&b.status==='present'&&a.value===b.value;
}
/** Shared production/test preparation. Availability is established at the CDP
 * callback, never at the later resource write or a URL's original DOM use. */
export async function prepareArchivedReplay(records: RecordingEnvelope[], archive: ResourceArchive,
  urlForResource: (id: string, position: ReplayPosition) => string): Promise<{ records: RecordingEnvelope[]; diagnostics: ReplayResourceDiagnostic[] }> {
  const uses = new Map<string, { url: string; frameId?: string; position: ReplayPosition; site?:ResourceUseSite }>();
  const key = (url: string, frameId: string | undefined, position: ReplayPosition, site?:ResourceUseSite) => JSON.stringify([url, frameId, position.recordingId, position.pageId, position.documentId, position.streamEpoch, position.eventSeq,site?.nodeId,site?.attribute]);
  rewriteReplayRecords(records, (url, frameId, position,site) => { uses.set(key(url, frameId, position,site), { url, frameId, position,site }); return url; });
  const replacements = new Map<string, string>(), diagnostics: ReplayResourceDiagnostic[] = [];
  const activations=new Map<number,Array<{nodeId:number;attribute:string;url:string}>>();
  const scheduledStylesheets=new Set<string>();let inspectedCssBytes=0;
  const scheduleStylesheetDependencies=async(use:{url:string;frameId?:string;position:ReplayPosition;site?:ResourceUseSite},reference:ArchivedResource,useIndex:number)=>{
    if(use.site?.attribute!=='href'||!use.frameId||!/^text\/css(?:;|$)/i.test(reference.mediaType)||reference.originalUrl.status!=='present'||!reference.requestStartedAt||!reference.availableObservedAt)return;
    const checked=`${reference.id}/${use.site.nodeId}/${use.position.eventSeq}`;if(scheduledStylesheets.has(checked))return;scheduledStylesheets.add(checked);
    const parentStart=observedMs(reference.requestStartedAt),parentAvailable=observedMs(reference.availableObservedAt);
    if(parentStart===undefined||parentAvailable===undefined)return;
    const {bytes}=await archive.read(reference.id);inspectedCssBytes+=bytes.length;
    if(inspectedCssBytes>32*1024*1024)throw new Error('Stylesheet replay dependency byte budget exceeded');
    const urls=new Set<string>();rewriteCssUrls(bytes.toString('utf8'),url=>{urls.add(url);return url;});
    if(urls.size>1000)throw new Error('Stylesheet dependency count exceeds budget');
    const parents=await archive.history(reference.originalUrl.value,use.position,use.frameId);
    const nextParentStart=parents.map(item=>observedMs(item.requestStartedAt)).filter((value):value is number=>value!==undefined&&value>parentStart).sort((a,b)=>a-b)[0];
    for(const value of urls){
      if(value.startsWith('#')||value.startsWith('data:')||value.startsWith('blob:'))continue;
      let absolute:string;try{absolute=new URL(value,reference.originalUrl.value).href;}catch{continue;}
      const versions=(await archive.history(absolute,use.position,use.frameId)).filter(item=>{const started=observedMs(item.requestStartedAt);return started!==undefined&&started>parentStart&&(nextParentStart===undefined||started<nextParentStart);});
      if(versions.length!==1)continue;
      const available=observedMs(versions[0].availableObservedAt);
      if(available===undefined||available<=parentAvailable)continue;
      const next=records.findIndex((record,index)=>index>useIndex&&record.event.type===3&&record.event.data.source===0&&observedMs(record.observedAt)!>available);
      if(next<0||records.slice(useIndex+1,next+1).some(record=>record.event.type===2||record.event.type===3&&record.event.data.source===0&&(record.event.data.attributes.some(item=>item.id===use.site!.nodeId&&'href' in item.attributes)||record.event.data.removes.some(item=>item.id===use.site!.nodeId))))continue;
      const activation=activations.get(next)??[],url=urlForResource(reference.id,records[next].position);
      if(!activation.some(item=>item.nodeId===use.site!.nodeId&&item.attribute==='href'&&item.url===url))activation.push({nodeId:use.site.nodeId,attribute:'href',url});
      activations.set(next,activation);
    }
  };
  if (uses.size > 5000) throw new Error('Replay resource use budget exceeded');
  const groupKey=(use:{url:string;frameId?:string;position:ReplayPosition})=>JSON.stringify([use.url,use.frameId,use.position.recordingId,use.position.pageId,use.position.documentId,use.position.streamEpoch]);
  const groups=new Map<string,Array<{identity:string;use:{url:string;frameId?:string;position:ReplayPosition;site?:ResourceUseSite}}>>();
  for(const [identity,use] of uses){const group=groupKey(use),members=groups.get(group)??[];members.push({identity,use});groups.set(group,members);}
  const histories=new Map<string,ArchivedResource[]>(),bindings=new Map<string,{reference?:ArchivedResource;reason?:string}>();
  const inherited=new Map<string,ArchivedResource>();
  if(records[0]?.event.type===2){
    try{
      const priorRecords=await previousSourceWindow(archive,records[0].position);
      if(priorRecords?.length&&priorRecords.at(-1)!.position.eventSeq<records[0].position.eventSeq&&priorRecords.every(record=>record.metadataComplete&&!record.gaps.some(gap=>gap.category==='structure'||gap.category==='metadata'))&&records[0].metadataComplete){
        const before=new SourceModel(priorRecords),after=new SourceModel([records[0]]);
        const priorUses:Array<{url:string;frameId?:string;position:ReplayPosition;site?:ResourceUseSite}>=[];
        rewriteReplayRecords(priorRecords,(url,frameId,position,site)=>{priorUses.push({url,frameId,position,site});return url;});
        for(const [identity,use] of uses){
          if(use.position.eventSeq!==records[0].position.eventSeq||use.site?.attribute!=='href'||!use.frameId)continue;
          const oldNode=before.nodes.get(use.site.nodeId),newNode=after.nodes.get(use.site.nodeId);
          if(!oldNode?.metadata||!newNode?.metadata||oldNode.parentId!==newNode.parentId||oldNode.metadata.tagName!=='link'||newNode.metadata.tagName!=='link'||oldNode.metadata.frameId!==use.frameId||newNode.metadata.frameId!==use.frameId||oldNode.metadata.mirrorScopeId!==newNode.metadata.mirrorScopeId||!sameSourceAttribute(before.attribute(oldNode,'href'),after.attribute(newNode,'href')))continue;
          const sameLink=(model:SourceModel)=>[...model.nodes.values()].filter(node=>node.metadata?.tagName==='link'&&node.metadata.frameId===use.frameId&&sameSourceAttribute(model.attribute(node,'href'),model.attribute(newNode,'href'))).length;
          if(sameLink(before)!==1||sameLink(after)!==1)continue;
          const related=priorUses.filter(item=>item.url===use.url&&item.frameId===use.frameId&&item.site?.attribute===use.site?.attribute);
          const last=related.filter(item=>item.site?.nodeId===use.site?.nodeId).at(-1);
          if(!last)continue;
          const snapshotAt=observedMs(records[0].observedAt);
          if(snapshotAt===undefined)continue;
          const history=await archive.history(use.url,use.position,use.frameId);
          const requests=history.filter(item=>!!item.requestId&&observedMs(item.requestStartedAt)!==undefined);
          const useTimes=related.map(item=>observedMs(priorRecords.find(record=>record.position.eventSeq===item.position.eventSeq)?.observedAt));
          const preceding=related.map((_,index)=>requests.filter(item=>{const started=observedMs(item.requestStartedAt)!;return useTimes[index]!==undefined&&started<=useTimes[index]!&&(index===0||useTimes[index-1]!==undefined&&started>useTimes[index-1]!);}));
          const reserved=new Set(preceding.flat().map(item=>item.id));
          let retained:ArchivedResource|undefined;
          for(let index=0;index<=related.indexOf(last);index++){
            const matches=preceding[index];
            if(matches.length>1){retained=undefined;continue;}
            if(matches.length===1){retained=matches[0];continue;}
            const current=useTimes[index],next=useTimes[index+1];
            const after=current===undefined?[]:requests.filter(item=>{const started=observedMs(item.requestStartedAt)!;return started>current&&(next===undefined||started<next)&&!reserved.has(item.id);});
            if(after.length>1){retained=undefined;continue;}
            if(after.length===1)retained=after[0];
          }
          const available=observedMs(retained?.availableObservedAt);
          if(retained&&available!==undefined&&available<snapshotAt)inherited.set(identity,retained);
        }
      }
    }catch{/* Missing or corrupt prior source evidence cannot authorize a version. */}
  }
  for(const [group,members] of groups){
    const first=members[0].use;if(!first.frameId)continue;
    if(first.url.startsWith('data:'))continue;
    const history=await archive.history(first.url,first.position,first.frameId);histories.set(group,history);
    const requests=history.filter(item=>!!item.requestId&&observedMs(item.requestStartedAt)!==undefined);
    const useTimes=members.map(member=>observedMs(records.find(record=>record.position.eventSeq===member.use.position.eventSeq)?.observedAt));
    const preceding=members.map((_,index)=>requests.filter(item=>{const start=observedMs(item.requestStartedAt)!;return useTimes[index]!==undefined&&start<=useTimes[index]!&&(index===0||useTimes[index-1]!==undefined&&start>useTimes[index-1]!);}));
    const reserved=new Set(preceding.flat().map(item=>item.id));
    let retained:ArchivedResource|undefined;
    for(let index=0;index<members.length;index++){
      const carry=inherited.get(members[index].identity);
      if(carry){retained=carry;bindings.set(members[index].identity,{reference:carry});continue;}
      const matches=preceding[index];
      if(matches.length>1){bindings.set(members[index].identity,{reason:'same-url-request-version-ambiguous'});retained=undefined;continue;}
      if(matches.length===1){retained=matches[0];bindings.set(members[index].identity,{reference:retained});continue;}
      const current=useTimes[index],next=useTimes[index+1];
      const after=current===undefined?[]:requests.filter(item=>{const start=observedMs(item.requestStartedAt)!;return start>current&&(next===undefined||start<next)&&!reserved.has(item.id);});
      if(after.length>1){bindings.set(members[index].identity,{reason:'same-url-request-version-ambiguous'});retained=undefined;continue;}
      if(after.length===1){retained=after[0];bindings.set(members[index].identity,{reference:retained});continue;}
      if(retained)bindings.set(members[index].identity,{reference:retained});
    }
  }
  for (const [identity, use] of uses) {
    const { url, frameId, position,site } = use;
    if (url.startsWith('#') || url === 'about:blank') { replacements.set(identity, url); continue; }
    if (url.startsWith('data:')) { if(inlineDataResource(url)) replacements.set(identity,url); else {diagnostics.push({...use,url:'[data-url omitted]',status:'unsupported',reason:'inline-data-media-or-byte-budget'});replacements.set(identity,'about:blank');} continue; }
    if (!frameId) { diagnostics.push({ ...use, status: 'unsupported', reason: 'source-frame-unmapped' }); replacements.set(identity, 'about:blank'); continue; }
    try {
      const history=histories.get(groupKey(use))??[];
      const useIndex=records.findIndex(record=>record.position.eventSeq===position.eventSeq);
      const useAt=observedMs(records[useIndex]?.observedAt),endAt=observedMs(records.at(-1)?.observedAt);
      const bound=bindings.get(identity);
      if(bound?.reason){diagnostics.push({...use,status:'unsupported',reason:bound.reason});replacements.set(identity,'about:blank');continue;}
      // Old references have no callback request identity; they can only serve
      // a URL use when one immutable candidate is already anchored by then.
      const legacy=history.filter(item=>!item.requestStartedAt&&item.position.eventSeq<=position.eventSeq&&!(item.source.fromCache&&['failed','missing'].includes(item.status)));
      if(!bound?.reference&&legacy.length>1){diagnostics.push({...use,status:'unsupported',reason:'legacy-resource-version-ambiguous'});replacements.set(identity,'about:blank');continue;}
      const reference=bound?.reference??legacy[0];
      if(!reference){
        const future=history.some(item=>{const observed=observedMs(item.availableObservedAt);return observed!==undefined&&endAt!==undefined&&observed>=endAt;});
        diagnostics.push({...use,status:future?'pending':history.length?'unsupported':'missing',reason:future?'resource-response-not-yet-observed':history.length?'resource-availability-time-unrecorded':'resource-not-captured'});replacements.set(identity,'about:blank');continue;
      }
      const availableAt=observedMs(reference.availableObservedAt);
      if(availableAt!==undefined&&endAt!==undefined&&availableAt>=endAt){diagnostics.push({...use,status:'pending',reason:'resource-response-not-yet-observed'});replacements.set(identity,'about:blank');continue;}
      if(reference.availableObservedAt&&availableAt===undefined||reference.requestId&&availableAt===undefined&&reference.position.eventSeq>position.eventSeq){diagnostics.push({...use,status:'unsupported',reason:'resource-availability-time-unrecorded'});replacements.set(identity,'about:blank');continue;}
      if(availableAt!==undefined&&useAt===undefined){diagnostics.push({...use,status:'unsupported',reason:'url-use-observation-time-unrecorded'});replacements.set(identity,'about:blank');continue;}
      if(reference.status==='captured'&&availableAt!==undefined&&useAt!==undefined&&availableAt>=useAt){
        // Only a simple, still-live attribute can be activated without
        // inventing a source DOM mutation or rewriting original evidence.
        const next=records.findIndex((record,index)=>index>useIndex&&record.event.type===3&&record.event.data.source===0&&observedMs(record.observedAt)!>availableAt);
        const changed=next>=0&&site&&records.slice(useIndex+1,next+1).some(record=>record.event.type===2||record.event.type===3&&record.event.data.source===0&&(record.event.data.attributes.some(item=>item.id===site.nodeId&&site.attribute in item.attributes)||record.event.data.removes.some(item=>item.id===site.nodeId)));
        if(!site||!['src','rr_src','href','poster','background'].includes(site.attribute)||next<0||changed){diagnostics.push({...use,status:'unsupported',reason:'late-resource-activation-boundary-unavailable'});replacements.set(identity,'about:blank');continue;}
        const activation=activations.get(next)??[];activation.push({nodeId:site.nodeId,attribute:site.attribute,url:urlForResource(reference.id,records[next].position)});activations.set(next,activation);
        diagnostics.push({...use,status:'pending',reason:'resource-response-not-yet-observed',resolvedAt:records[next].position});replacements.set(identity,'about:blank');
        await scheduleStylesheetDependencies(use,reference,useIndex);continue;
      }
      if(reference.position.eventSeq>position.eventSeq&&availableAt===undefined){diagnostics.push({...use,status:'unsupported',reason:'legacy-resource-position-is-not-availability'});replacements.set(identity,'about:blank');continue;}
      if(reference.status==='captured'){replacements.set(identity,urlForResource(reference.id,position));await scheduleStylesheetDependencies(use,reference,useIndex);continue;}
      diagnostics.push({ ...use, status:status(reference),reason:reference.reason??`resource-${reference.status}` });
    } catch (error) {
      diagnostics.push({ ...use, status: 'read-failed', reason: error instanceof Error ? error.name : 'resource-read-error' });
    }
    replacements.set(identity, 'about:blank');
  }
  const rewritten=rewriteReplayRecords(records, (url, frameId, position,site) => replacements.get(key(url, frameId, position,site)) ?? 'about:blank');
  for(const [index,updates] of activations){const event=rewritten[index].event;if(event.type===3&&event.data.source===0)for(const update of updates)event.data.attributes.push({id:update.nodeId,attributes:{[update.attribute]:update.url}});}
  return { records: rewritten, diagnostics };
}

/** Protocol adapter contains no navigation/fetch. Caller must bind the archive
 * to the authorized replay view and refuse any ID outside that run. */
export class OfflineResourceService {
  constructor(private readonly archive: ResourceArchive) {}
  async response(id: string, position: ReplayPosition, urlForResource: (id:string)=>string = resourceUrl): Promise<{ bytes: Uint8Array; headers: Record<string, string>; diagnostics: ReplayResourceDiagnostic[] }> {
    const { reference, bytes } = await this.archive.read(id);
    if (reference.position.recordingId !== position.recordingId || reference.position.pageId !== position.pageId || reference.position.documentId !== position.documentId || reference.position.streamEpoch !== position.streamEpoch) throw new Error('Resource belongs to another historical position');
    const target=(await new RecordingArchive(this.archive.runDir).window(position)).records.at(-1);
    if(!target||target.position.eventSeq!==position.eventSeq)throw new Error('Resource target observation is unavailable');
    const targetAt=observedMs(target.observedAt),availableAt=observedMs(reference.availableObservedAt);
    if(reference.availableObservedAt){
      if(targetAt===undefined||availableAt===undefined||availableAt>=targetAt)throw new Error('Resource bytes were not observed before this historical position');
    }else if(reference.position.eventSeq>position.eventSeq)throw new Error('Legacy resource position does not establish availability at this historical position');
    let content: Uint8Array = bytes;
    const diagnostics: ReplayResourceDiagnostic[] = [];
    if (/^text\/css(?:;|$)/i.test(reference.mediaType) && reference.originalUrl.status === 'present') {
      const css = bytes.toString('utf8'), base = reference.originalUrl.value;
      const urls = new Set<string>(); rewriteCssUrls(css, url => { urls.add(url); return url; });
      if (urls.size > 1000) throw new Error('Stylesheet dependency count exceeds budget');
      const mapped = new Map<string, string>();
      for (const url of urls) {
        if (url.startsWith('#')) { mapped.set(url, url); continue; }
        if (url.startsWith('data:')) { const safe=inlineDataResource(url);mapped.set(url,safe?url:'about:blank');if(!safe)diagnostics.push({url:'[data-url omitted]',frameId:reference.frameId,position,status:'unsupported',reason:'inline-data-media-or-byte-budget'});continue; }
        let absolute: string; try { absolute = new URL(url, base).href; } catch { mapped.set(url, 'about:blank'); diagnostics.push({url,frameId:reference.frameId,position,status:'unsupported',reason:'invalid-css-resource-url'}); continue; }
        try {
          const history=await this.archive.history(absolute,position,reference.frameId);
          const parentStart=observedMs(reference.requestStartedAt);
          const parentHistory=reference.originalUrl.status==='present'?await this.archive.history(reference.originalUrl.value,position,reference.frameId):[];
          const laterParents=parentHistory.map(item=>observedMs(item.requestStartedAt)).filter((value):value is number=>value!==undefined&&parentStart!==undefined&&value>parentStart).sort((a,b)=>a-b);
          const nextParentStart=laterParents[0];
          const interval=history.filter(item=>{const start=observedMs(item.requestStartedAt);return parentStart!==undefined&&start!==undefined&&start>parentStart&&(nextParentStart===undefined||start<nextParentStart);});
          const versions=interval.filter(item=>{const observed=observedMs(item.availableObservedAt);return observed!==undefined&&targetAt!==undefined&&observed<targetAt;});
          const dependency=versions[0];
          if(versions.length>1){mapped.set(url,'about:blank');diagnostics.push({url:absolute,frameId:reference.frameId,position,status:'unsupported',reason:'same-url-css-dependency-version-ambiguous'});continue;}
          if(!dependency&&interval.some(item=>{const observed=observedMs(item.availableObservedAt);return observed!==undefined&&targetAt!==undefined&&observed>=targetAt;})){mapped.set(url,'about:blank');diagnostics.push({url:absolute,frameId:reference.frameId,position,status:'pending',reason:'css-dependency-response-not-yet-observed'});continue;}
          if(!dependency&&history.length){mapped.set(url,'about:blank');diagnostics.push({url:absolute,frameId:reference.frameId,position,status:'unsupported',reason:'css-dependency-request-interval-unproven'});continue;}
          const dependencyAt=observedMs(dependency?.availableObservedAt);
          if(dependency?.availableObservedAt&&(targetAt===undefined||dependencyAt===undefined)){mapped.set(url,'about:blank');diagnostics.push({url:absolute,frameId:reference.frameId,position,status:'unsupported',reason:'css-dependency-observation-time-unrecorded'});continue;}
          if(dependencyAt!==undefined&&targetAt!==undefined&&dependencyAt>=targetAt){mapped.set(url,'about:blank');diagnostics.push({url:absolute,frameId:reference.frameId,position,status:'pending',reason:'css-dependency-response-not-yet-observed'});continue;}
          if(dependency&&!dependency.availableObservedAt&&dependency.position.eventSeq>position.eventSeq){mapped.set(url,'about:blank');diagnostics.push({url:absolute,frameId:reference.frameId,position,status:'unsupported',reason:'legacy-css-dependency-availability-unrecorded'});continue;}
          if (dependency?.status === 'captured') mapped.set(url, urlForResource(dependency.id));
          else {
            mapped.set(url, 'about:blank');
            diagnostics.push({url:absolute,frameId:reference.frameId,position,status:dependency?.status === 'redacted' ? 'excluded' : dependency?.status === 'unsupported' ? 'unsupported' : 'missing',reason:dependency?.reason ?? 'css-resource-not-captured'});
          }
        } catch (error) {
          mapped.set(url, 'about:blank');diagnostics.push({url:absolute,frameId:reference.frameId,position,status:'read-failed',reason:error instanceof Error?error.name:'css-resource-read-error'});
        }
      }
      content = Buffer.from(rewriteCssUrls(css, url => mapped.get(url) ?? 'about:blank'));
    }
    return { bytes: content, diagnostics, headers: { 'content-type': reference.mediaType, 'content-security-policy': OFFLINE_CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } };
  }
}
