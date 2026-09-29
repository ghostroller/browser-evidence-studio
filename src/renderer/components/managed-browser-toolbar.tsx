import React,{useEffect,useRef,useState} from 'react';
import type { BrowserCommand, BrowserPageStatus, BrowserSessionStatus } from '@/main/browser/browser-controls';
import { Button } from './ui/button';
import { Input } from './ui/input';

export interface ManagedBrowserToolbarProps {
  session:BrowserSessionStatus|null;call:(method:string,body?:unknown)=>Promise<unknown>;refresh:()=>void|Promise<unknown>;
  disabled?:boolean;onSave?:()=>void;onCancel?:()=>void;
}
/** A projection of the current session; command receipts never replace context. */
export function ManagedBrowserToolbar({session,call,refresh,disabled=false,onSave,onCancel}:ManagedBrowserToolbarProps){
  const page=session?.pages.find(p=>p.pageId===session.selectedPageId),[url,setUrl]=useState(''),[editing,setEditing]=useState(false),[error,setError]=useState('');
  const [findOpen,setFindOpen]=useState(false),[query,setQuery]=useState(''),[downloadsOpen,setDownloadsOpen]=useState(false),[prompt,setPrompt]=useState('');
  const addressRef=useRef<HTMLInputElement>(null),findRef=useRef<HTMLInputElement>(null),lastAction=useRef(''),context=useRef('');
  const identity=session?`${session.sessionId}/${page?.pageId??''}`:'';context.current=identity;
  const canUse=!!session&&session.controller==='human'&&!session.locked&&!disabled;
  useEffect(()=>{setEditing(false);setUrl(page?.url??'');setError('');setFindOpen(false);setQuery('');},[identity]);
  useEffect(()=>{if(!editing)setUrl(page?.url??'');},[page?.url,editing]);
  useEffect(()=>{setPrompt(page?.dialog?.defaultValue??'');},[page?.dialog?.id]);
  const command=async(command:BrowserCommand['command'],extra:Partial<BrowserCommand>={},target:BrowserPageStatus|undefined=page)=>{
    if(!session)return;const started=context.current;
    const body:BrowserCommand={sessionId:session.sessionId,leaseEpoch:session.leaseEpoch,...(target?{pageId:target.pageId,targetId:target.targetId,generation:target.generation}:{}),...extra,command};
    setError('');try{await call('browserCommand',body);await refresh();}catch(failure){if(context.current===started)setError(String(failure));await refresh();}
  };
  const focusAddress=()=>{setEditing(true);addressRef.current?.focus();addressRef.current?.select();};
  useEffect(()=>{
    const action=session?.uiAction;if(!action||lastAction.current===action.id)return;lastAction.current=action.id;
    if(action.action==='save'){onSave?.();return;}if(action.action==='cancel'){setFindOpen(false);onCancel?.();return;}
    if(disabled||action.pageId!==(page?.pageId??''))return;
    if(action.action==='address')focusAddress();if(action.action==='find'){setFindOpen(true);requestAnimationFrame(()=>findRef.current?.focus());}
  },[session?.uiAction?.id,disabled,page?.pageId]);
  useEffect(()=>{
    const keyboard=(event:KeyboardEvent)=>{
      if(disabled||!session||event.altKey||(!event.ctrlKey&&!event.metaKey))return;
      const key=event.key.toLowerCase(),within=event.target instanceof Element&&!!event.target.closest('[data-browser-toolbar]');
      // Workspace form keys belong to their own editor. Only address/new-tab are global.
      if(!within&&!['l','t'].includes(key))return;
      if(!['l','t','w','r','f','+','=','-','0'].includes(key))return;event.preventDefault();event.stopPropagation();
      if(!canUse)return;
      if(key==='l')focusAddress();else if(key==='f'){setFindOpen(true);requestAnimationFrame(()=>findRef.current?.focus());}
      else if(key==='t')void command(event.shiftKey?'reopen':'new');else if(key==='w')void command('close');else if(key==='r')void command('reload');
      else void command('zoom',{zoomFactor:key==='0'?1:Math.min(3,Math.max(.25,(page?.zoomFactor??1)+(key==='-'?-.1:.1)))});
    };
    window.addEventListener('keydown',keyboard);return()=>window.removeEventListener('keydown',keyboard);
  });
  if(!session)return null;
  return <section data-browser-toolbar aria-label="实时浏览器工具栏" className="flex shrink-0 flex-col gap-2 border-b p-2 text-sm">
    <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="浏览器标签">
      {session.pages.map(tab=><div key={tab.pageId} className="flex max-w-64 items-center rounded border">
        <Button role="tab" aria-selected={tab.pageId===session.selectedPageId} variant={tab.pageId===session.selectedPageId?'secondary':'ghost'} size="sm" disabled={!canUse} onClick={()=>void command('select',{},tab)} className="min-w-0 truncate" title={tab.url}>{tab.loading?'加载中 · ':tab.loadError?'错误 · ':''}{tab.title||'新标签'}</Button>
        <Button aria-label={`关闭标签 ${tab.title||'新标签'}`} variant="ghost" size="sm" disabled={!canUse} onClick={()=>void command('close',{},tab)}>×</Button>
      </div>)}
      <Button size="sm" variant="outline" disabled={!canUse} onClick={()=>void command('new')}>新标签</Button>
      <Button size="sm" variant="ghost" disabled={!canUse||!session.closedPageCount} onClick={()=>void command('reopen')} title="恢复网址及环境，不恢复未保存的网页表单">恢复关闭的标签</Button>
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <Button size="sm" variant="outline" aria-label="后退" disabled={!canUse||!page?.canGoBack} onClick={()=>void command('back')}>←</Button>
      <Button size="sm" variant="outline" aria-label="前进" disabled={!canUse||!page?.canGoForward} onClick={()=>void command('forward')}>→</Button>
      <Button size="sm" variant="outline" disabled={!canUse||!page} onClick={()=>void command(page?.loading?'stop':'reload')}>{page?.loading?'停止加载':'刷新'}</Button>
      <form className="flex min-w-48 flex-1 gap-1" onSubmit={event=>{event.preventDefault();setEditing(false);void command('navigate',{url});}}>
        <Input ref={addressRef} aria-label="网页地址" value={url} disabled={!canUse||!page} onFocus={()=>setEditing(true)} onChange={event=>setUrl(event.target.value)} />
        <Button size="sm" variant="outline" type="submit" disabled={!canUse||!page}>前往</Button>
      </form>
      <Button size="sm" variant="ghost" disabled={!canUse||!page} onClick={()=>{setFindOpen(!findOpen);requestAnimationFrame(()=>findRef.current?.focus());}}>页内查找</Button>
      <Button size="sm" variant="ghost" disabled={!canUse||!page} aria-label="缩小页面" onClick={()=>void command('zoom',{zoomFactor:Math.max(.25,(page?.zoomFactor??1)-.1)})}>−</Button>
      <Button size="sm" variant="ghost" disabled={!canUse||!page} title="恢复 100%" onClick={()=>void command('zoom',{zoomFactor:1})}>{Math.round((page?.zoomFactor??1)*100)}%</Button>
      <Button size="sm" variant="ghost" disabled={!canUse||!page} aria-label="放大页面" onClick={()=>void command('zoom',{zoomFactor:Math.min(3,(page?.zoomFactor??1)+.1)})}>+</Button>
      <Button size="sm" variant="ghost" onClick={()=>setDownloadsOpen(!downloadsOpen)}>下载 {session.downloads.length||''}</Button>
    </div>
    {!session.pages.length&&<p>当前没有标签。点击“新标签”继续使用同一登录环境。</p>}
    {findOpen&&<form className="flex flex-wrap items-center gap-2" onSubmit={e=>{e.preventDefault();void command('find',{text:query});}}>
      <Input ref={findRef} className="max-w-60" aria-label="页内查找文字" value={query} onChange={e=>setQuery(e.target.value)} />
      <Button size="sm" disabled={!canUse||!query}>查找</Button><Button type="button" size="sm" variant="outline" disabled={!canUse||!query} onClick={()=>void command('find',{text:query,findNext:true,forward:false})}>上一处</Button><Button type="button" size="sm" variant="outline" disabled={!canUse||!query} onClick={()=>void command('find',{text:query,findNext:true})}>下一处</Button>
      <span aria-live="polite">{page?.find?`${page.find.activeMatchOrdinal} / ${page.find.matches}`:''}</span><Button type="button" variant="ghost" size="sm" onClick={()=>{setFindOpen(false);void command('find-close');}}>关闭查找</Button>
    </form>}
    {(error||page?.loadError)&&<div role="alert" className="flex flex-wrap items-center gap-2 text-destructive"><span className="break-all">{error||`${page?.loadError?.kind==='certificate'?'证书错误':page?.loadError?.kind==='denied'?'导航被拒绝':page?.loadError?.kind==='url'?'地址错误':'页面加载失败'}：${page?.loadError?.url} · ${page?.loadError?.message}`}</span><Button size="sm" variant="outline" disabled={!canUse||!page} onClick={()=>void command('reload')}>重试当前页</Button></div>}
    {session.notice&&<div role="status" className="flex items-center gap-2 break-all">{session.notice}<Button size="sm" variant="ghost" disabled={!canUse} onClick={()=>void command('notice-dismiss')}>知道了</Button></div>}
    {page?.dialog&&<div role="alert" className="flex flex-wrap items-center gap-2 rounded border p-2"><b>网站对话框 · {page.dialog.type}</b><span className="break-all">{page.dialog.message}</span>{page.dialog.type==='prompt'&&<Input aria-label="网站对话框输入" value={prompt} onChange={e=>setPrompt(e.target.value)} />}<Button size="sm" disabled={!canUse} onClick={()=>void command('dialog',{dialogId:page.dialog!.id,accept:false})}>取消</Button><Button size="sm" disabled={!canUse} onClick={()=>void command('dialog',{dialogId:page.dialog!.id,accept:true,text:prompt})}>确认</Button>{!canUse&&<span>先停止自动化并接管后处理</span>}</div>}
    <details className="text-xs"><summary>浏览器能力范围</summary><p>支持网站 alert、confirm 和离页确认。当前 Electron 不支持 prompt() 输入框；网站权限默认拒绝。文件选择使用系统窗口，下载不会自动执行。</p></details>
    {downloadsOpen&&<div aria-label="下载列表" className="max-h-40 overflow-y-auto rounded border p-2">{!session.downloads.length?'暂无下载':session.downloads.map(download=><div key={download.id} className="flex flex-wrap items-center gap-2 border-b py-1"><span>{download.filename} · {({progressing:'下载中',completed:'已完成',cancelled:'已取消',interrupted:'失败 / 中断'})[download.state]} · {download.receivedBytes.toLocaleString()} / {download.totalBytes||'?'} 字节</span>{download.evidence&&<span>录制证据：{({pending:'待导入',imported:'已导入',excluded:'未导入（已保留本地文件）',failed:'导入失败'})[download.evidence]}</span>}<span title={download.path} className="max-w-80 truncate">{download.path}</span>{['progressing','interrupted'].includes(download.state)?<Button size="sm" variant="ghost" disabled={!canUse} onClick={()=>void command('download-cancel',{downloadId:download.id})}>取消下载</Button>:download.state==='completed'&&<Button size="sm" variant="ghost" disabled={!canUse} onClick={()=>void command('download-show',{downloadId:download.id})}>显示位置</Button>}</div>)}</div>}
  </section>;
}
