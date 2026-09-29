import React, { useEffect, useRef, useState } from 'react';
import type { MaterialCatalog } from '@/contracts/workspace';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

interface RunEntry {id:string;status:string;createdAt?:string;kind?:string}
export function RecordingArchive({projectId,runs,onReplay,onDiagnostic,onRecovery}:{projectId:string;runs:RunEntry[];onReplay(id:string):Promise<unknown>;onDiagnostic(id:string):Promise<unknown>;onRecovery(id:string):void}) {
  const [catalog,setCatalog]=useState<MaterialCatalog|null>(null),[search,setSearch]=useState(''),[removed,setRemoved]=useState(false),[error,setError]=useState('');
  const [usage,setUsage]=useState<Record<string,{revisions:Array<{revisionId:string;displayNumber:number;cards:number}>;drafts:Array<{draftId:string;name:string;cards:number}>}>>({});
  const scope=useRef(projectId);scope.current=projectId;
  const call=(method:string,body:Record<string,unknown>={})=>window.studio.call(method,{projectId,...body});
  useEffect(()=>{let cancelled=false;setCatalog(null);setUsage({});void call('materialCatalog').then(value=>{if(!cancelled)setCatalog(value);}).catch(failure=>{if(!cancelled)setError(String(failure));});return()=>{cancelled=true;};},[projectId]);
  const run=(action:()=>Promise<unknown>)=>{void action().catch(failure=>setError(String(failure)));};
  const manage=async(id:string,patch:{hidden?:boolean;name?:string;note?:string})=>{if(!catalog)return;const updated=await call('manageMaterialCatalog',{kind:'recordings',id,expectedCatalogRevision:catalog.catalogRevision,...patch});if(scope.current===projectId)setCatalog(updated);};
  return <section aria-label="原始录制存档"><h3>原始录制</h3><p>连续来源资料；名称与隐藏状态保存在外部目录，原件保持不变。</p>
    {error&&<p role="alert">{error}</p>}<Label>搜索录制<Input value={search} onChange={event=>setSearch(event.target.value)}/></Label><Label><input type="checkbox" checked={removed} onChange={event=>setRemoved(event.target.checked)}/>显示已隐藏录制</Label>
    {runs.filter(item=>(removed||!catalog?.recordings[item.id]?.hidden)&&((catalog?.recordings[item.id]?.name||'')+item.id).includes(search)).map(item=><section key={item.id}><h4>{catalog?.recordings[item.id]?.name||`${item.kind==='validate'?'执行':'人工示范'}录制 · ${item.createdAt?new Date(item.createdAt).toLocaleString():item.id}`}</h4><p>{item.status==='recording'?'正在录制，尚未封存':item.status==='sealed'?'已封存':item.status} · {item.id}</p>
      <div className="material-actions"><Button onClick={()=>run(()=>onReplay(item.id))}>回放录制</Button><Button onClick={()=>run(async()=>{const result=await call('recordingUsage',{recordingId:item.id});if(scope.current===projectId)setUsage(current=>({...current,[item.id]:result}));})}>查看使用位置</Button></div>
      {usage[item.id]&&<div>{usage[item.id].revisions.map(value=><p key={value.revisionId}>存档 V{value.displayNumber} · {value.cards} 张保存点</p>)}{usage[item.id].drafts.map(value=><p key={value.draftId}>{value.name} · {value.cards} 张保存点</p>)}{!usage[item.id].revisions.length&&!usage[item.id].drafts.length&&<p>目前没有资料引用。</p>}</div>}
      <details><summary>录制管理与诊断</summary><Label>录制名称<Input defaultValue={catalog?.recordings[item.id]?.name??''} onBlur={event=>run(()=>manage(item.id,{name:event.target.value}))}/></Label><Label>备注<Input defaultValue={catalog?.recordings[item.id]?.note??''} onBlur={event=>run(()=>manage(item.id,{note:event.target.value}))}/></Label><Button onClick={()=>run(()=>manage(item.id,{hidden:!catalog?.recordings[item.id]?.hidden}))}>{catalog?.recordings[item.id]?.hidden?'恢复录制':'隐藏录制'}</Button><Button onClick={()=>run(()=>onDiagnostic(item.id))}>原件诊断</Button><Button onClick={()=>onRecovery(item.id)}>检查/重建索引</Button><p>隐藏可恢复；保留所有历史引用。此处不物理删除录制。</p></details>
    </section>)}{!runs.length&&<p>当前项目还没有原始录制。</p>}
  </section>;
}
