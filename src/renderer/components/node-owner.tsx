import React, { useEffect, useRef, useState } from 'react';
import type { NodeOwnerIdentity, NodeOwnerSessionIdentity, NodeOwnerInput, NodeOwnerMethod, NodeOwnerOutput, NodeOwnerState } from '@/contracts/node-owner';
import { WorkbenchHeader, WorkbenchShell } from './workbench-shell';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { NativeSelect } from './ui/native-select';

class OwnerError extends Error {
  constructor(message:string, readonly status=0) { super(message); }
}
type OwnerSession = { token:string; expiresAt:number; instanceId:string };
/** This surface owns only short-lived local lifecycle controls. Materials and
 * validation results remain in the same shared browser workbench components. */
export function NodeOwner({ instanceId, fetcher=fetch, pollMs=1000 }: { instanceId:string; fetcher?:typeof fetch; pollMs?:number }) {
  const auth=useRef<OwnerSession|null>(null), alive=useRef(true), epoch=useRef(0), readId=useRef(0);
  const pending=useRef(false), reading=useRef(false), readAbort=useRef<AbortController|null>(null);
  const stopping=useRef(false);
  const recoveryPending=useRef(false);
  const [recovering,setRecovering]=useState(false);
  const [connected,setConnected]=useState(false), [busy,setBusy]=useState(false), [fresh,setFresh]=useState(false);
  const [pendingMethod,setPendingMethod]=useState<NodeOwnerMethod|null>(null);
  const [state,setState]=useState<NodeOwnerState|null>(null), [ticket,setTicket]=useState('');
  const [error,setError]=useState(''), [notice,setNotice]=useState(''), [expiresAt,setExpiresAt]=useState(0);
  const [connectionError,setConnectionError]=useState('');
  const [lifecycleWarning,setLifecycleWarning]=useState('');
  const [projectId,setProjectId]=useState(''), [profileId,setProfileId]=useState('');
  const [projectName,setProjectName]=useState(''), [objective,setObjective]=useState(''), [scriptDirectory,setScriptDirectory]=useState('');
  const [profileName,setProfileName]=useState(''), [url,setUrl]=useState('about:blank');
  const [checkpointKey,setCheckpointKey]=useState(''), [checkpointTitle,setCheckpointTitle]=useState(''), [description,setDescription]=useState('');
  const [revision,setRevision]=useState(''), [hash,setHash]=useState(''), [input,setInput]=useState('{}');
  const [mode,setMode]=useState<'current-page-test'|'from-start-validation'>('from-start-validation');
  const [executionId,setExecutionId]=useState(''), [pairing,setPairing]=useState<{ticket:string;expiresAt:number}|null>(null);
  const [datasets,setDatasets]=useState<NodeOwnerOutput<'executionDatasets'>['items']>([]);
  const [datasetOwner,setDatasetOwner]=useState(''), [selectedDatasets,setSelectedDatasets]=useState<string[]>([]);
  const datasetKey=(item:{attemptId:string;datasetId:string})=>JSON.stringify([item.attemptId,item.datasetId]);
  const detach=(message='本页授权已清除')=>{
    ++epoch.current; ++readId.current; readAbort.current?.abort(); auth.current=null;
    pending.current=false;reading.current=false;
    if(alive.current){setConnected(false);setBusy(false);setPendingMethod(null);setFresh(false);setState(null);setPairing(null);setTicket('');setExpiresAt(0);setDatasets([]);setDatasetOwner('');setSelectedDatasets([]);setConnectionError('');setLifecycleWarning('');setNotice(message);}
  };
  async function request<T>(route:string, body:unknown, token?:string, signal?:AbortSignal):Promise<T> {
    const response=await fetcher(route,{method:'POST',mode:'same-origin',credentials:'omit',cache:'no-store',redirect:'error',signal,
      headers:{'content-type':'application/json','x-workbench-instance':instanceId,...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
    const reader=response.body?.getReader();let text='',bytes=0;
    if(reader){const decoder=new TextDecoder();try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>2*1024*1024){await reader.cancel();throw new OwnerError('控制台响应过大');}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}}
    let value:any;try{value=JSON.parse(text);}catch{throw new OwnerError('控制台响应无法解析',response.status);}
    if(!response.ok){
      const diagnosticId=value?.error?.diagnosticId;
      const suffix=typeof diagnosticId==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(diagnosticId)?`（诊断编号 ${diagnosticId}）`:'';
      throw new OwnerError((typeof value?.error?.message==='string'?value.error.message:'请求失败，请重新读取状态后核对')+suffix,response.status);
    }
    return value as T;
  }
  async function rpc<M extends NodeOwnerMethod>(method:M,body:NodeOwnerInput<M>,signal?:AbortSignal):Promise<NodeOwnerOutput<M>>{
    const session=auth.current;
    if(!session||session.expiresAt<=Date.now())throw new OwnerError('授权已到期，请重新启动授权入口',401);
    return request('/owner/rpc',{instanceId,method,body},session.token,signal);
  }
  async function refresh(force=false){
    if(!auth.current||reading.current&&!force)return;
    // State reads remain available during a pending mutation so a crash and its
    // current lease can be discovered. Post-action reads supersede any older poll.
    if(force){++readId.current;readAbort.current?.abort();reading.current=false;}
    const current=epoch.current,id=++readId.current,controller=new AbortController();
    reading.current=true;readAbort.current=controller;
    try{
      const next=await rpc('state',{},controller.signal);
      if(!alive.current||current!==epoch.current||id!==readId.current)return;
      if(next.instanceId!==instanceId||next.backendKind!=='node'||next.runtimeProvider!=='chromium')throw new OwnerError('实例或运行时身份不匹配');
      setState(next);setFresh(true);setConnectionError('');
    }catch(failure){
      if(!alive.current||current!==epoch.current||id!==readId.current||controller.signal.aborted)return;
      setFresh(false);setConnectionError(failure instanceof OwnerError?failure.message:'连接中断，当前资料可能已过时；写入已暂停');
      if(failure instanceof OwnerError&&(failure.status===401||failure.status===403))detach('授权已失效，请重新授权');
    }finally{if(id===readId.current){reading.current=false;readAbort.current=null;}}
  }
  useEffect(()=>{
    alive.current=true;
    const timer=setInterval(()=>{if(auth.current&&auth.current.expiresAt<=Date.now())detach('授权已到期');else void refresh();},pollMs);
    return()=>{alive.current=false;++epoch.current;++readId.current;readAbort.current?.abort();auth.current=null;clearInterval(timer);};
  },[instanceId,fetcher,pollMs]);
  const connect=async()=>{
    if(pending.current||!ticket.trim())return;
    pending.current=true;setBusy(true);setError('');setConnectionError('');const current=++epoch.current, secret=ticket.trim();setTicket('');
    try{
      const session=await request<OwnerSession>('/owner/session',{instanceId,ticket:secret});
      if(!alive.current||current!==epoch.current)return;
      if(session.instanceId!==instanceId||typeof session.token!=='string'||!Number.isFinite(session.expiresAt)||session.expiresAt<=Date.now())throw new OwnerError('授权响应身份或有效期无效');
      auth.current=session;setConnected(true);setExpiresAt(session.expiresAt);setNotice('已连接本次 Node 实例');await refresh(true);
    }catch(failure){if(alive.current&&current===epoch.current)setError(failure instanceof OwnerError?failure.message:'连接失败；票据可能已被使用，请核对启动器状态');}
    finally{if(alive.current&&current===epoch.current){pending.current=false;setBusy(false);}}
  };
  async function act<M extends NodeOwnerMethod>(method:M,body:NodeOwnerInput<M>,success?: (result:NodeOwnerOutput<M>)=>void|string){
    if(pending.current||recoveryPending.current||!fresh||!auth.current)return;
    pending.current=true;setBusy(true);setPendingMethod(method);setError('');setNotice('');
    ++readId.current;readAbort.current?.abort();reading.current=false;
    const current=epoch.current;
    try{
      const result=await rpc(method,body);
      if(!alive.current||current!==epoch.current)return;
      if(method==='shutdown'){detach('后端正在退出');return;}
      if(method==='revokeOwner'){detach('本次授权及工作台授权已撤销，执行已停止');return;}
      const feedback=success?.(result);setNotice(typeof feedback==='string'?feedback:method==='saveProfile'?'环境数据由 Chromium 管理，请正常关闭会话完成持久化':'操作已完成');await refresh(true);
    }catch(failure){
      if(alive.current&&current===epoch.current){setFresh(false);setError((failure instanceof OwnerError?failure.message:'未收到确定回执；操作可能已经执行')+'。请先刷新状态核对，不会自动重试写入。');}
    }finally{if(alive.current&&current===epoch.current){pending.current=false;setBusy(false);setPendingMethod(null);}}
  }
  // Stop is intentionally independent of the normal mutation lane: a pending
  // startup/checkpoint must never disable the user's cancellation control.
  async function stopExecution(sessionId:string){
    if(stopping.current||!auth.current)return;
    stopping.current=true;const current=epoch.current;
    try{await rpc('stopRunner',{sessionId});if(alive.current&&current===epoch.current){setNotice('已请求停止执行');await refresh(true);}}
    catch(failure){if(alive.current&&current===epoch.current)setError(failure instanceof OwnerError?failure.message:'停止执行未取得确定回执，请刷新核对');}
    finally{stopping.current=false;}
  }
  async function endOwner(method:'revokeOwner'|'shutdown'){
    if(stopping.current||!auth.current)return;
    stopping.current=true;const current=epoch.current;
    try{await rpc(method,{});if(alive.current&&current===epoch.current)detach(method==='shutdown'?'后端正在退出':'本次授权及工作台授权已撤销，执行已停止');}
    catch(failure){if(alive.current&&current===epoch.current)setError(failure instanceof OwnerError?failure.message:'退出操作未取得确定回执，请核对启动器状态');}
    finally{stopping.current=false;}
  }
  async function recoverInterrupted(identity:NodeOwnerSessionIdentity){
    if(recoveryPending.current||!auth.current)return;
    recoveryPending.current=true;setRecovering(true);
    // The recovery route may settle a previously pending startup. Its late
    // response must not restore obsolete UI state after explicit interruption.
    const current=++epoch.current;++readId.current;readAbort.current?.abort();reading.current=false;
    pending.current=false;setBusy(false);setPendingMethod(null);setFresh(false);setError('');setNotice('正在结束整个中断会话并保留原件');
    try{
      const result=await rpc('endInterruptedSession',identity);
      if(!alive.current||current!==epoch.current)return;
      setNotice(`中断会话已结束，原件按中断状态保留${result.cleanupFailures?`；${result.cleanupFailures} 项清理未完整完成，详情已记录`:''}`);
      await refresh(true);
    }catch(failure){if(alive.current&&current===epoch.current)setError((failure instanceof OwnerError?failure.message:'中断恢复未取得确定回执')+'。请刷新状态核对，不会自动重试。');}
    finally{recoveryPending.current=false;if(alive.current)setRecovering(false);}
  }
  const session=state?.session, page=session?.pages.find(item=>item.pageId===session.selectedPageId);
  const sessionIdentity:NodeOwnerSessionIdentity|undefined=session?{projectId:session.projectId,profileId:session.profileId,sessionId:session.sessionId,leaseEpoch:session.leaseEpoch}:undefined;
  const identity:NodeOwnerIdentity|undefined=session&&page?{projectId:session.projectId,profileId:session.profileId,sessionId:session.sessionId,leaseEpoch:session.leaseEpoch,pageId:page.pageId,targetId:page.targetId,generation:page.generation}:undefined;
  const project=state?.projects.find(item=>item.id===projectId), profiles=state?.profiles.filter(item=>item.projectId===projectId)??[];
  const providerFailed=state?.providerStatus==='disconnected'||state?.providerStatus==='renderer-failed';
  const writable=connected&&fresh&&!busy&&!recovering, browserReady=writable&&state?.providerStatus==='connected'&&!!identity, humanReady=browserReady&&session?.controller==='human'&&!session?.locked;
  const sessionReady=writable&&state?.providerStatus==='connected'&&!!sessionIdentity&&session?.controller==='human'&&!session?.locked;
  const cooperative=state?.capabilities.executionMode==='cooperative-dev-test';
  const automationActive=!!state?.validationStarting||pendingMethod==='startValidation'||session?.controller==='agent';
  const command=(command:Exclude<NodeOwnerInput<'browserCommand'>['command'],'new'>,extra:Partial<NodeOwnerIdentity>&{url?:string}={})=>identity&&void act('browserCommand',{...identity,command,...extra});
  const startValidation=()=>{
    if(!identity||!cooperative)return;
    let value:unknown;try{value=JSON.parse(input);}catch{setError('执行输入必须是有效 JSON');return;}
    void act('startValidation',{...identity,materialRevisionId:revision.trim(),materialContentHash:hash.trim(),executionMode:mode,input:value,...(mode==='from-start-validation'?{startUrl:url}:{})});
  };
  const chooseExecution=(id:string)=>{setExecutionId(id);setDatasets([]);setDatasetOwner('');setSelectedDatasets([]);};
  return <WorkbenchShell browser><WorkbenchHeader><span className="host-label">Node · 独立 Chromium 控制台</span></WorkbenchHeader>
    <main className="browser-workbench-content">
      {connected&&cooperative&&<section aria-label="开发测试输入模式" style={{gridColumn:'1 / -1',alignSelf:'start'}} className="sticky top-0 z-20 rounded-md border border-amber-400 bg-amber-50 p-3 text-amber-950">
        <strong>开发／测试模式 · 人工输入不会被拦截</strong>
        <p className="text-sm">仅能检测部分目标或导航异常，不能保证识别每次人工点击、输入。验证结果不证明运行期间无人干扰；执行中可视人工接管暂不支持。</p>
        {automationActive&&<div className="button-row"><p role="status">自动化运行中，请勿操作受控浏览器；如需操作，请先停止执行。</p><Button disabled={!session} onClick={()=>session&&void stopExecution(session.sessionId)}>停止当前自动化</Button></div>}
      </section>}
      <section className="browser-connection form-stack" aria-label="Node 实例连接"><h1>本地运行控制</h1><p>实例：<code>{instanceId}</code></p>
        <p className="hint">浏览器在独立窗口中运行。下载与弹出窗口被拒绝；本页只提供运行控制，资料编辑、历史回放和结果查看使用共享工作台。</p>
        {!connected&&<form className="form-stack" autoComplete="off" onSubmit={event=>{event.preventDefault();void connect();}}><Label>启动器一次性票据<Input type="password" aria-label="启动器一次性票据" autoComplete="off" spellCheck={false} maxLength={128} value={ticket} disabled={busy} onChange={event=>setTicket(event.target.value)}/></Label><Button type="submit" disabled={busy||!ticket.trim()}>连接 Node 实例</Button></form>}
        {connected&&<><p role="status">{fresh?'已连接 · 当前状态':'状态待恢复 · 写入暂停'}{busy?' · 操作中':''}</p><p className="hint">本次授权到期：{new Date(expiresAt).toLocaleTimeString('zh-CN',{hour12:false})}；刷新页面不会保留授权</p><div className="button-row"><Button onClick={()=>void refresh(true)}>刷新运行状态</Button><Button onClick={()=>void endOwner('revokeOwner')}>撤销授权并停止执行</Button><Button onClick={()=>detach('本页凭据已清除；后端任务可能仍在运行，可在启动器中退出')}>清除本页凭据</Button><Button onClick={()=>void endOwner('shutdown')}>退出此后端</Button></div></>}
        {connectionError&&<p role="alert">{connectionError}</p>}{error&&<div><p role="alert">{error}</p><Button onClick={()=>setError('')}>已查看此操作错误</Button></div>}{lifecycleWarning&&<div><p role="alert">{lifecycleWarning}</p><Button onClick={()=>setLifecycleWarning('')}>已查看环境持久化提示</Button></div>}{notice&&<p role="status">{notice}</p>}
      </section>
      {connected&&state&&<>
        <section className="browser-project form-stack" aria-label="项目与 Chromium 环境"><h2>项目与环境</h2>
          <Label>当前项目<NativeSelect aria-label="当前项目" value={projectId} disabled={!writable} onChange={event=>{setProjectId(event.target.value);setProfileId('');setPairing(null);}}><option value="">选择项目</option>{state.projects.map(item=><option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}</NativeSelect></Label>
          <details><summary>新建项目</summary><div className="form-stack"><Label>项目名称<Input aria-label="项目名称" value={projectName} onChange={event=>setProjectName(event.target.value)} maxLength={200}/></Label><Label>项目说明<Input aria-label="项目说明" value={objective} onChange={event=>setObjective(event.target.value)} maxLength={4000}/></Label><Button disabled={!writable||!projectName.trim()} onClick={()=>void act('createProject',{name:projectName,objective,operationId:crypto.randomUUID()},result=>{setProjectId(result.id);setProfileId('');setProjectName('');})}>创建项目</Button></div></details>
          <Label>Chromium 环境<NativeSelect aria-label="Chromium 环境" disabled={!writable} value={profileId} onChange={event=>setProfileId(event.target.value)}><option value="">选择环境</option>{profiles.map(item=><option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}</NativeSelect></Label>
          <Label>目标网址<Input aria-label="目标网址" value={url} onChange={event=>setUrl(event.target.value)} maxLength={4096}/></Label>
          <details><summary>新建 Chromium 环境</summary><div className="form-stack"><Label>环境名称<Input aria-label="环境名称" value={profileName} onChange={event=>setProfileName(event.target.value)} maxLength={120}/></Label><Button disabled={!writable||!projectId||!profileName.trim()} onClick={()=>void act('createProfile',{projectId,name:profileName,entryUrl:url,operationId:crypto.randomUUID()},result=>{setProfileId(result.id);setProfileName('');})}>创建 Chromium 环境</Button></div></details>
          <div className="button-row"><Button disabled={!writable||!profileId||!!session} onClick={()=>void act('openEnvironment',{projectId,profileId})}>打开环境</Button><Button disabled={!writable||!profileId||!!state.active||providerFailed||!!session&&(session.projectId!==projectId||session.profileId!==profileId)} onClick={()=>void act('startRun',{projectId,profileId,expectedSessionId:session?.sessionId??null,...(session?{leaseEpoch:session.leaseEpoch}:{}),url})}>{session?'开始录制当前页面':'开始录制并导航'}</Button></div>
        </section>
        {session&&<section className="browser-project form-stack" aria-label="受控浏览器"><h2>受控浏览器</h2><p>会话：<code>{session.sessionId}</code> · 流程控制方 {session.controller} · {providerFailed?(state.providerStatus==='renderer-failed'?'浏览器页面已崩溃':'浏览器已断开'):session.locked||session.controller!=='human'?'工作台流程操作受限；不代表物理输入被拦截':'人工操作阶段'}</p><p>录制：{state.active?.id??'未录制'} · {state.active?.capture??'idle'}</p>
          {providerFailed&&<div className="form-stack"><p role="alert">{state.providerStatus==='renderer-failed'?'后端确认受控页面已崩溃。':'受控 Chromium 已断开。'}结束中断会话将关闭整个受控浏览器及其所有页面，保留已采集的原件并标记中断，不会将不完整录制伪装成封存来源。完成后可重新打开环境。</p><Button disabled={!connected||!sessionIdentity||recovering} onClick={()=>sessionIdentity&&void recoverInterrupted(sessionIdentity)}>结束中断会话</Button></div>}
          <Label>受控页面<NativeSelect aria-label="受控页面" value={session.selectedPageId} disabled={!humanReady} onChange={event=>{const selected=session.pages.find(item=>item.pageId===event.target.value);if(selected)command('select',{pageId:selected.pageId,targetId:selected.targetId,generation:selected.generation});}}>{session.pages.map(item=><option key={item.pageId} value={item.pageId}>{item.title||item.url} · {item.pageId}</option>)}</NativeSelect></Label>
          <p className="hint">{page?.url} · target {page?.targetId} · generation {page?.generation}</p>{session.notice&&<p role="status">{session.notice}</p>}{page?.loadError&&<p role="alert">{page.loadError.message}</p>}
          <div className="button-row"><Button disabled={!humanReady} onClick={()=>command('navigate',{url})}>导航目标网址</Button><Button disabled={!sessionReady} onClick={()=>sessionIdentity&&void act('browserCommand',{...sessionIdentity,command:'new',url})}>新建受控页面</Button><Button disabled={!humanReady||!page?.canGoBack} onClick={()=>command('back')}>后退</Button><Button disabled={!humanReady||!page?.canGoForward} onClick={()=>command('forward')}>前进</Button><Button disabled={!humanReady} onClick={()=>command('reload')}>重新加载</Button><Button disabled={!humanReady} onClick={()=>command('close')}>关闭当前页面</Button></div>
          <Label>保存点键<Input aria-label="保存点键" value={checkpointKey} onChange={event=>setCheckpointKey(event.target.value)}/></Label><Label>保存点标题<Input aria-label="保存点标题" value={checkpointTitle} onChange={event=>setCheckpointTitle(event.target.value)}/></Label><Label>保存点说明<Input aria-label="保存点说明" value={description} onChange={event=>setDescription(event.target.value)}/></Label>
          <div className="button-row"><Button disabled={!humanReady||!state.active||!checkpointKey.trim()} onClick={()=>identity&&void act('checkpoint',{...identity,key:checkpointKey,title:checkpointTitle,description})}>采集保存点</Button><Button disabled={!sessionReady||!state.active} onClick={()=>sessionIdentity&&void act('seal',sessionIdentity)}>停止录制并封存</Button><Button disabled={!sessionReady} onClick={()=>sessionIdentity&&void act('saveProfile',sessionIdentity)}>保存环境状态</Button><Button disabled={!sessionReady||!!state.active} onClick={()=>sessionIdentity&&void act('closeSession',sessionIdentity,result=>{if(result.profilePersistence==='flushed')return '浏览器会话已正常关闭';setLifecycleWarning(result.warning??'浏览器已结束，但环境数据的完整持久化未经确认；请检查本次关闭诊断后再使用。');return '浏览器会话已结束，请查看环境持久化提示';})}>关闭浏览器会话</Button></div>
        </section>}
        <section className="browser-project form-stack" aria-label="共享工作台授权"><h2>资料与历史回放</h2><p>为所选项目明确授权资料编辑、只读结果与隔离历史回放，然后在共享工作台输入票据。</p><div className="button-row"><Button disabled={!writable||!projectId} onClick={()=>void act('pairWorkbench',{projectId},result=>setPairing(result))}>生成工作台配对票据</Button><Button disabled={!writable} onClick={()=>void act('revokeWorkbench',{},()=>setPairing(null))}>撤销工作台授权</Button><a href="./browser.html" target="_blank" rel="noopener noreferrer">打开共享工作台</a></div>{pairing&&<div><Label>工作台一次性票据<Input aria-label="工作台一次性票据" type="password" readOnly value={pairing.ticket} autoComplete="off" onFocus={event=>event.target.select()}/></Label><p className="hint">票据到期：{new Date(pairing.expiresAt).toLocaleTimeString('zh-CN',{hour12:false})}，仅在当前页面内存中保留</p></div>}</section>
        <section className="browser-project form-stack" style={{gridColumn:'1 / -1'}} aria-label="固定版本执行"><h2>执行与核验</h2><p className="hint">脚本目录属于所选项目。仅运行你确认的本地项目代码；执行使用填写的固定版本身份。</p><Label>工作流目录<Input aria-label="工作流目录" value={scriptDirectory} onChange={event=>setScriptDirectory(event.target.value)} maxLength={4096}/></Label><Button disabled={!writable||!project||!scriptDirectory.trim()} onClick={()=>project&&void act('registerWorkflow',{projectId:project.id,expectedRevision:project.revision??0,scriptDirectory,operationId:crypto.randomUUID()})}>登记工作流目录</Button>
          {!cooperative&&<p role="status">此实例未启用开发执行。请在本地启动时明确传入 --dev-cooperative-input；不能在浏览器请求中提升此能力。</p>}
          <Label>固定版本 ID<Input aria-label="固定版本 ID" value={revision} onChange={event=>setRevision(event.target.value)}/></Label><Label>固定版本内容 Hash<Input aria-label="固定版本内容 Hash" value={hash} onChange={event=>setHash(event.target.value)}/></Label><Label>执行模式<NativeSelect aria-label="执行模式" value={mode} onChange={event=>setMode(event.target.value as typeof mode)}><option value="from-start-validation">从入口核验</option><option value="current-page-test">当前页面测试</option></NativeSelect></Label><Label>执行输入 JSON<textarea className="w-full rounded-md border p-2" aria-label="执行输入 JSON" rows={4} value={input} onChange={event=>setInput(event.target.value)}/></Label>
          <div className="button-row"><Button disabled={!cooperative||!humanReady||!revision.trim()||!hash.trim()||!!state.validationStarting} onClick={startValidation}>启动固定版本执行</Button><Button disabled={!connected||!session} onClick={()=>session&&void stopExecution(session.sessionId)}>停止执行</Button></div>
          <p role="status">{state.validationStarting?'正在启动执行':state.active?.execution??'无活动执行'}</p>
          <Label>执行 ID<Input aria-label="执行 ID" value={executionId} onChange={event=>chooseExecution(event.target.value)}/></Label>
          <Button disabled={!writable||!projectId||!executionId.trim()} onClick={()=>{const owner=JSON.stringify([projectId,executionId]);void act('executionDatasets',{projectId,executionId},result=>{setDatasets(result.items);setDatasetOwner(owner);setSelectedDatasets([]);});}}>读取执行数据集</Button>
          {datasetOwner===JSON.stringify([projectId,executionId])&&<fieldset disabled={!writable}><legend>明确选择用于验收的数据集尝试</legend>{datasets.map(item=><Label key={datasetKey(item)} className="flex flex-wrap items-center gap-2"><input type="checkbox" aria-label={`用于验收 ${item.datasetId} ${item.attemptId}`} checked={selectedDatasets.includes(datasetKey(item))} onChange={event=>setSelectedDatasets(previous=>event.target.checked?[...previous,datasetKey(item)]:previous.filter(key=>key!==datasetKey(item)))}/>{item.datasetId} · attempt {item.attemptId} · {item.status} · {item.committedRecords} 条记录{item.diagnostic&&<span>{item.diagnostic.message}</span>}</Label>)}</fieldset>}
          <Button disabled={!writable||!projectId||!executionId.trim()||datasetOwner!==JSON.stringify([projectId,executionId])||selectedDatasets.length===0} onClick={()=>void act('assessExecution',{projectId,executionId,datasetIdentities:datasets.filter(item=>selectedDatasets.includes(datasetKey(item))).map(({executionId,attemptId,datasetId})=>({executionId,attemptId,datasetId}))})}>生成执行核验报告</Button>
          <ul>{state.validations.filter(item=>item.projectId===projectId).map(item=><li key={item.id}><span>{item.status} · {item.executionId??item.id}</span>{item.executionId&&<Button size="sm" disabled={!writable} onClick={()=>chooseExecution(item.executionId!)}>选择此执行</Button>}</li>)}</ul>
        </section>
      </>}
    </main><footer className="statusbar"><span>纯 Node 后端 · 独立 Chromium · {cooperative?'协作式开发／测试':'短期本地授权'}</span><span>核验结果不证明无人干扰</span></footer>
  </WorkbenchShell>;
}
