import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
export async function fileTreeHashes(root){const output={};async function walk(dir){for(const entry of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const p=path.join(dir,entry.name);if(entry.isDirectory())await walk(p);else if(entry.isFile())output[path.relative(root,p)]=createHash('sha256').update(await fs.readFile(p)).digest('hex');else throw Error('Unexpected nonregular file in synthetic source')}}await walk(root);return output;}
export async function recordingFacts(root){
 const records=[];for(const f of(await fs.readdir(path.join(root,'raw','rrweb'))).sort())if(f.endsWith('.jsonl'))for(const line of(await fs.readFile(path.join(root,'raw','rrweb',f),'utf8')).split('\n').filter(Boolean)){const row=JSON.parse(line);if(row.payload?.kind==='rrweb')records.push(row.payload)}
 const findAmount=snapshot=>{let found;const visit=n=>{if(n.attributes?.id==='amount')found=n;for(const child of n.childNodes??[])visit(child)};visit(snapshot.event.data.node);return found};
 const baseline=records.find(r=>r.event.type===2&&findAmount(r));assert(baseline,'Actual source full snapshot');const sourceNode=findAmount(baseline);assert(sourceNode,'Original source amount node');
 const metadata=baseline.metadata?.find(m=>m.nodeId===sourceNode.id)??baseline.sourceMetadata?.find(m=>m.nodeId===sourceNode.id);
 const stream=records.filter(r=>['recordingId','pageId','documentId','streamEpoch'].every(k=>r.position[k]===baseline.position[k]));
 const mutation=value=>stream.find(r=>r.event.type===3&&r.event.data.source===0&&((r.event.data.texts??[]).some(t=>t.value===value)||(r.event.data.adds??[]).some(a=>a.parentId===sourceNode.id&&a.node.textContent===value)));
 const thirteen=mutation('13.00'),fourteen=mutation('14.00'),missing=stream.find(r=>r.event.type===3&&r.event.data.source===0&&(r.event.data.adds??[]).some(a=>a.node.attributes?.id==='known-missing'));
 assert(missing,'Actual missing-resource DOM insertion');assert(thirteen&&fourteen,'Both actual source changes');assert(thirteen.position.eventSeq<fourteen.position.eventSeq);
 return{records,baseline:baseline.position,thirteen:thirteen.position,fourteen:fourteen.position,missing:missing.position,sourceNodeId:sourceNode.id,metadata,sourceFrameId:baseline.frameId,sourceMirrorScopeId:baseline.mirrorScopeId};
}

/** Bounded read-only runtime proof: this test workflow never changes the amount.
 * Require a real captured full snapshot of the exact sample node and reject any
 * later mutation of that node/subtree rather than inventing replay semantics. */
export async function runtimeAmountEvidence(root,target){
 const records=[];for(const f of(await fs.readdir(path.join(root,'raw','rrweb'))).sort())if(f.endsWith('.jsonl'))for(const line of(await fs.readFile(path.join(root,'raw','rrweb',f),'utf8')).split('\n').filter(Boolean)){const row=JSON.parse(line);if(row.payload?.kind==='rrweb')records.push(row.payload)}
 const stream=records.filter(r=>['recordingId','pageId','documentId','streamEpoch'].every(k=>r.position[k]===target.position[k])&&r.position.eventSeq<=target.position.eventSeq).sort((a,b)=>a.position.eventSeq-b.position.eventSeq);
 let snapshot,node;
 for(const row of stream)if(row.event.type===2){let candidate;const visit=n=>{if(n.id===target.nodeId)candidate=n;for(const child of n.childNodes??[])visit(child)};visit(row.event.data.node);if(candidate){snapshot=row;node=candidate}}
 assert(snapshot&&node,'Exact runtime target exists in captured full snapshot');assert.equal(node.attributes?.id,'amount');assert.equal(node.attributes?.['data-field'],'amount');
 const ids=new Set(),text=[];const visit=n=>{ids.add(n.id);if(typeof n.textContent==='string')text.push(n.textContent);for(const child of n.childNodes??[])visit(child)};visit(node);
 for(const row of stream)if(row.position.eventSeq>snapshot.position.eventSeq&&row.event.type===3&&row.event.data.source===0){const data=row.event.data;assert(!(data.texts??[]).some(x=>ids.has(x.id))&&!(data.adds??[]).some(x=>ids.has(x.parentId))&&!(data.removes??[]).some(x=>ids.has(x.id)||ids.has(x.parentId)),'Read-only amount has no unhandled intervening subtree mutation')}
 assert.equal(text.join(''),'14.00');return{snapshotPosition:snapshot.position,samplePosition:target.position,nodeId:target.nodeId,rawText:text.join(''),checkedEvents:stream.length};
}
