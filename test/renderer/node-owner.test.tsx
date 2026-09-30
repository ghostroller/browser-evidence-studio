/** @vitest-environment jsdom */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { NodeOwner } from '@/renderer/components/node-owner';
import type { NodeOwnerState } from '@/contracts/node-owner';

afterEach(()=>{cleanup();vi.restoreAllMocks();});
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const state=():NodeOwnerState=>({instanceId:'instance',backendKind:'node',runtimeProvider:'chromium',providerStatus:'not-open',capabilities:{executionMode:'cooperative-dev-test',inputIsolation:'none',physicalInputExclusive:false,interferenceDetection:'partial',humanHandoff:'unsupported',nativeEmbedding:false,nativeDialogs:false,downloads:'denied',popups:'rejected',persistentProfiles:true},projects:[{id:'project',name:'Project',objective:'',createdAt:'2026-09-30',revision:1}],profiles:[],session:null,active:null,runs:[],validations:[],validationStarting:null});
function fixture(){
  let value=state(),stateFailure=false;
  let mutation:(method:string)=>Promise<unknown>=async()=>({id:'new',name:'New',objective:'',createdAt:'2026-09-30',revision:1});
  const fetcher=vi.fn(async(route:string|URL|Request,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body));
    if(route==='/owner/session')return json({instanceId:'instance',token:'secret-bearer',expiresAt:Date.now()+900000});
    if(body.method==='state'){if(stateFailure)throw new Error('offline');return json(value);}
    return json(await mutation(body.method));
  });
  render(<NodeOwner instanceId="instance" fetcher={fetcher as typeof fetch} pollMs={60000}/>);
  const connect=async()=>{fireEvent.change(screen.getByLabelText('启动器一次性票据'),{target:{value:'ticket-secret'}});fireEvent.click(screen.getByRole('button',{name:'连接 Node 实例'}));await screen.findByText('已连接 · 当前状态');};
  return{fetcher,connect,setState:(next:NodeOwnerState)=>{value=next;},stateFailure:()=>{stateFailure=true;},mutate:(next:typeof mutation)=>{mutation=next;}};
}
test('owner bootstrap keeps credentials in memory and excludes them from RPC body, URL and visible text',async()=>{
  const storage=vi.spyOn(Storage.prototype,'setItem');const f=fixture();await f.connect();
  const calls=f.fetcher.mock.calls;
  expect(calls[0][0]).toBe('/owner/session');expect(JSON.parse(String(calls[0][1]?.body))).toEqual({instanceId:'instance',ticket:'ticket-secret'});
  const read=calls.find(([,init])=>JSON.parse(String(init?.body)).method==='state')!;
  expect(read[1]).toMatchObject({credentials:'omit',mode:'same-origin',cache:'no-store',redirect:'error',headers:{Authorization:'Bearer secret-bearer','x-workbench-instance':'instance'}});
  expect(String(read[1]?.body)).not.toContain('secret');expect(document.body.textContent).not.toContain('secret');expect(storage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'清除本页凭据'}));expect(screen.queryByRole('heading',{name:'项目与环境'})).toBeNull();expect((screen.getByLabelText('启动器一次性票据')as HTMLInputElement).value).toBe('');
});
test('duplicate create clicks issue one mutation and a lost receipt disables writing without retry',async()=>{
  const f=fixture();await f.connect();let reject!:(failure:Error)=>void;
  f.mutate(()=>new Promise((_resolve,fail)=>{reject=fail;}));
  fireEvent.change(screen.getByLabelText('项目名称'),{target:{value:'New project'}});
  const button=screen.getByRole('button',{name:'创建项目'});fireEvent.click(button);fireEvent.click(button);
  await waitFor(()=>expect(reject).toBeTypeOf('function'));reject(new Error('lost receipt'));
  await screen.findByRole('alert');
  expect(f.fetcher.mock.calls.filter(([,init])=>JSON.parse(String(init?.body)).method==='createProject')).toHaveLength(1);
  expect((button as HTMLButtonElement).disabled).toBe(true);expect(screen.getByRole('alert').textContent).toContain('不会自动重试');
  fireEvent.click(screen.getByRole('button',{name:'刷新运行状态'}));await screen.findByText('已连接 · 当前状态');
  expect(screen.getByRole('alert').textContent).toContain('不会自动重试');
  fireEvent.click(screen.getByRole('button',{name:'已查看此操作错误'}));expect(screen.queryByRole('alert')).toBeNull();
});
test('failed state reads suspend mutations',async()=>{
  const f=fixture();await f.connect();f.stateFailure();fireEvent.click(screen.getByRole('button',{name:'刷新运行状态'}));await screen.findByRole('alert');
  expect((screen.getByRole('button',{name:'生成工作台配对票据'})as HTMLButtonElement).disabled).toBe(true);expect(screen.getByText('状态待恢复 · 写入暂停')).toBeTruthy();
});
test('dataset attempts must be explicitly selected and are submitted with their exact identity',async()=>{
  const f=fixture();await f.connect();fireEvent.change(screen.getByLabelText('当前项目'),{target:{value:'project'}});fireEvent.change(screen.getByLabelText('执行 ID'),{target:{value:'execution'}});
  f.mutate(async method=>method==='executionDatasets'?{items:[{executionId:'execution',attemptId:'attempt',datasetId:'orders',status:'committed',committedRecords:1,committedBatches:1}]}:{});
  fireEvent.click(screen.getByRole('button',{name:'读取执行数据集'}));const choice=await screen.findByLabelText('用于验收 orders attempt');
  await waitFor(()=>expect((screen.getByRole('button',{name:'读取执行数据集'})as HTMLButtonElement).disabled).toBe(false));
  expect((choice as HTMLInputElement).checked).toBe(false);expect((screen.getByRole('button',{name:'生成执行核验报告'})as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(choice);fireEvent.click(screen.getByRole('button',{name:'生成执行核验报告'}));
  await waitFor(()=>expect(f.fetcher.mock.calls.some(([,init])=>JSON.parse(String(init?.body)).method==='assessExecution')).toBe(true));
  const call=f.fetcher.mock.calls.map(([,init])=>JSON.parse(String(init?.body))).find(value=>value.method==='assessExecution');
  expect(call.body).toEqual({projectId:'project',executionId:'execution',datasetIdentities:[{executionId:'execution',attemptId:'attempt',datasetId:'orders'}]});
});
test('stop execution stays actionable while execution startup has a pending response',async()=>{
  const f=fixture(),value=state();value.providerStatus='connected';value.session={sessionId:'session',projectId:'project',profileId:'profile',controller:'human',leaseEpoch:1,locked:false,selectedPageId:'page',closedPageCount:0,downloads:[],pages:[{provider:'chromium',browserInstanceId:'browser',pageId:'page',targetId:'target',generation:1,url:'http://127.0.0.1/',title:'Target',inspecting:false,canGoBack:false,canGoForward:false,loading:false,zoomFactor:1}]};f.setState(value);await f.connect();
  let release!:(value:unknown)=>void;f.mutate(async method=>method==='startValidation'?new Promise(done=>{release=done;}):{});
  fireEvent.change(screen.getByLabelText('固定版本 ID'),{target:{value:'revision'}});fireEvent.change(screen.getByLabelText('固定版本内容 Hash'),{target:{value:'hash'}});fireEvent.click(screen.getByRole('button',{name:'启动固定版本执行'}));
  await waitFor(()=>expect(release).toBeTypeOf('function'));const stop=screen.getByRole('button',{name:'停止执行'});expect((stop as HTMLButtonElement).disabled).toBe(false);fireEvent.click(stop);
  expect(screen.getByText('自动化运行中，请勿操作受控浏览器；如需操作，请先停止执行。')).toBeTruthy();
  await waitFor(()=>expect(f.fetcher.mock.calls.some(([,init])=>JSON.parse(String(init?.body)).method==='stopRunner')).toBe(true));release({});
});
test('a session with no pages can be closed without inventing page identity',async()=>{
  const f=fixture(),value=state();value.providerStatus='connected';value.session={sessionId:'session',projectId:'project',profileId:'profile',controller:'human',leaseEpoch:7,locked:false,selectedPageId:'',closedPageCount:1,downloads:[],pages:[]};f.setState(value);await f.connect();
  const close=screen.getByRole('button',{name:'关闭浏览器会话'});expect((close as HTMLButtonElement).disabled).toBe(false);expect((screen.getByRole('button',{name:'新建受控页面'})as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(close);await waitFor(()=>expect(f.fetcher.mock.calls.some(([,init])=>JSON.parse(String(init?.body)).method==='closeSession')).toBe(true));
  const call=f.fetcher.mock.calls.map(([,init])=>JSON.parse(String(init?.body))).find(value=>value.method==='closeSession');expect(call.body).toEqual({projectId:'project',profileId:'profile',sessionId:'session',leaseEpoch:7});
});
test('explicit owner revocation clears data after server acknowledgment',async()=>{
  const f=fixture();await f.connect();f.mutate(async()=>({revoked:true}));fireEvent.click(screen.getByRole('button',{name:'撤销授权并停止执行'}));await screen.findByText('本次授权及工作台授权已撤销，执行已停止');expect(screen.queryByRole('heading',{name:'项目与环境'})).toBeNull();
});
test('owner revoke stays actionable during initial startup before any browser session exists',async()=>{
  const f=fixture();await f.connect();let release!:(value:unknown)=>void;
  f.mutate(async method=>method==='createProject'?new Promise(done=>{release=done;}):{revoked:true});
  fireEvent.change(screen.getByLabelText('项目名称'),{target:{value:'Pending'}});fireEvent.click(screen.getByRole('button',{name:'创建项目'}));await waitFor(()=>expect(release).toBeTypeOf('function'));
  const revoke=screen.getByRole('button',{name:'撤销授权并停止执行'}),shutdown=screen.getByRole('button',{name:'退出此后端'});expect((revoke as HTMLButtonElement).disabled).toBe(false);expect((shutdown as HTMLButtonElement).disabled).toBe(false);fireEvent.click(revoke);
  await screen.findByText('本次授权及工作台授权已撤销，执行已停止');release({id:'late',name:'Late'});expect(screen.queryByRole('heading',{name:'项目与环境'})).toBeNull();
});
test('backend-confirmed disconnected provider offers explicit interrupted recovery with only session identity',async()=>{
  const f=fixture(),value=state();value.providerStatus='disconnected';value.session={sessionId:'session',projectId:'project',profileId:'profile',controller:'agent',leaseEpoch:9,locked:true,selectedPageId:'',closedPageCount:1,downloads:[],pages:[]};f.setState(value);await f.connect();
  f.mutate(async()=>({closed:true,sessionId:'session',status:'interrupted',cleanupFailures:1}));
  expect((screen.getByRole('button',{name:'新建受控页面'})as HTMLButtonElement).disabled).toBe(true);expect((screen.getByRole('button',{name:'关闭浏览器会话'})as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByRole('button',{name:'结束中断会话'}));await screen.findByText('中断会话已结束，原件按中断状态保留；1 项清理未完整完成，详情已记录');
  const call=f.fetcher.mock.calls.map(([,init])=>JSON.parse(String(init?.body))).find(value=>value.method==='endInterruptedSession');expect(call.body).toEqual({projectId:'project',profileId:'profile',sessionId:'session',leaseEpoch:9});
});
test('cooperative mode explains physical non-exclusion and does not label logical lock as native input lock',async()=>{
  const f=fixture(),value=state();value.providerStatus='connected';value.session={sessionId:'session',projectId:'project',profileId:'profile',controller:'agent',leaseEpoch:9,locked:true,selectedPageId:'',closedPageCount:0,downloads:[],pages:[]};f.setState(value);await f.connect();
  expect(screen.getByText('开发／测试模式 · 人工输入不会被拦截')).toBeTruthy();
  expect(screen.getByText(/不能保证识别每次人工点击、输入/)).toBeTruthy();
  expect(screen.getByText(/不代表物理输入被拦截/)).toBeTruthy();
  expect(screen.queryByText('页面输入已锁定')).toBeNull();
  expect((screen.getByRole('button',{name:'停止当前自动化'})as HTMLButtonElement).disabled).toBe(false);
});
test('disabled execution capability cannot be elevated by owner UI',async()=>{
  const f=fixture(),value=state();value.capabilities.executionMode='disabled';value.providerStatus='connected';value.session={sessionId:'session',projectId:'project',profileId:'profile',controller:'human',leaseEpoch:1,locked:false,selectedPageId:'page',closedPageCount:0,downloads:[],pages:[{provider:'chromium',browserInstanceId:'browser',pageId:'page',targetId:'target',generation:1,url:'http://127.0.0.1/',title:'Target',inspecting:false,canGoBack:false,canGoForward:false,loading:false,zoomFactor:1}]};f.setState(value);await f.connect();
  fireEvent.change(screen.getByLabelText('固定版本 ID'),{target:{value:'revision'}});fireEvent.change(screen.getByLabelText('固定版本内容 Hash'),{target:{value:'hash'}});
  const button=screen.getByRole('button',{name:'启动固定版本执行'});expect((button as HTMLButtonElement).disabled).toBe(true);fireEvent.click(button);
  expect(f.fetcher.mock.calls.some(([,init])=>JSON.parse(String(init?.body)).method==='startValidation')).toBe(false);
  expect(screen.getByText(/明确传入 --dev-cooperative-input/)).toBeTruthy();
});
test('confirmed renderer failure has whole-session recovery independent of an ordinary pending action',async()=>{
  const f=fixture(),value=state();value.providerStatus='renderer-failed';value.session={sessionId:'session',projectId:'project',profileId:'profile',controller:'human',leaseEpoch:9,locked:false,selectedPageId:'',closedPageCount:0,downloads:[],pages:[]};f.setState(value);await f.connect();
  expect(screen.getByText(/关闭整个受控浏览器及其所有页面/)).toBeTruthy();
  expect((screen.getByRole('button',{name:'新建受控页面'})as HTMLButtonElement).disabled).toBe(true);
  let release!:(value:unknown)=>void;
  f.mutate(async method=>method==='createProject'?new Promise(done=>{release=done;}):{closed:true,sessionId:'session',status:'interrupted',cleanupFailures:0});
  fireEvent.change(screen.getByLabelText('项目名称'),{target:{value:'Pending'}});fireEvent.click(screen.getByRole('button',{name:'创建项目'}));await waitFor(()=>expect(release).toBeTypeOf('function'));
  const recover=screen.getByRole('button',{name:'结束中断会话'});expect((recover as HTMLButtonElement).disabled).toBe(false);fireEvent.click(recover);
  await screen.findByText('中断会话已结束，原件按中断状态保留');release({id:'late',name:'Late'});
  await waitFor(()=>expect(screen.getByText('中断会话已结束，原件按中断状态保留')).toBeTruthy());
  expect(f.fetcher.mock.calls.filter(([,init])=>JSON.parse(String(init?.body)).method==='endInterruptedSession')).toHaveLength(1);
});
test('state refresh discovers renderer failure after an operation starts and recovery does not need its receipt',async()=>{
  const f=fixture(),value=state();value.providerStatus='connected';value.session={sessionId:'session',projectId:'project',profileId:'profile',controller:'human',leaseEpoch:1,locked:false,selectedPageId:'',closedPageCount:0,downloads:[],pages:[]};f.setState(value);await f.connect();
  let release!:(value:unknown)=>void;
  f.mutate(async method=>method==='createProject'?new Promise(done=>{release=done;}):{closed:true,sessionId:'session',status:'interrupted',cleanupFailures:0});
  fireEvent.change(screen.getByLabelText('项目名称'),{target:{value:'Pending'}});fireEvent.click(screen.getByRole('button',{name:'创建项目'}));await waitFor(()=>expect(release).toBeTypeOf('function'));expect(screen.queryByRole('button',{name:'结束中断会话'})).toBeNull();
  value.providerStatus='renderer-failed';value.session.leaseEpoch=3;f.setState(value);
  const refresh=screen.getByRole('button',{name:'刷新运行状态'});expect((refresh as HTMLButtonElement).disabled).toBe(false);fireEvent.click(refresh);
  const recover=await screen.findByRole('button',{name:'结束中断会话'});expect((recover as HTMLButtonElement).disabled).toBe(false);fireEvent.click(recover);
  await screen.findByText('中断会话已结束，原件按中断状态保留');
  const call=f.fetcher.mock.calls.map(([,init])=>JSON.parse(String(init?.body))).find(value=>value.method==='endInterruptedSession');expect(call.body.leaseEpoch).toBe(3);release({id:'late',name:'Late'});
});
test('forced close persistence warning survives session removal and later successful state reads',async()=>{
  const f=fixture(),value=state();value.providerStatus='connected';value.session={sessionId:'session',projectId:'project',profileId:'profile',controller:'human',leaseEpoch:1,locked:false,selectedPageId:'',closedPageCount:0,downloads:[],pages:[]};f.setState(value);await f.connect();
  f.mutate(async()=>{f.setState({...value,session:null,providerStatus:'not-open'});return{closed:true,sessionId:'session',profilePersistence:'unconfirmed',warning:'受控进程被强制终止，环境数据持久化未经确认'};});
  fireEvent.click(screen.getByRole('button',{name:'关闭浏览器会话'}));await screen.findByText('受控进程被强制终止，环境数据持久化未经确认');await waitFor(()=>expect(screen.queryByRole('heading',{name:'受控浏览器'})).toBeNull());
  fireEvent.click(screen.getByRole('button',{name:'刷新运行状态'}));await screen.findByText('已连接 · 当前状态');expect(screen.getByRole('alert').textContent).toContain('持久化未经确认');
  fireEvent.click(screen.getByRole('button',{name:'已查看环境持久化提示'}));expect(screen.queryByRole('alert')).toBeNull();
});
test('disconnect discards a delayed mutation result and cannot restore the old session',async()=>{
  const f=fixture();await f.connect();let resolve!:(value:unknown)=>void;f.mutate(()=>new Promise(done=>{resolve=done;}));
  fireEvent.change(screen.getByLabelText('项目名称'),{target:{value:'Late'}});fireEvent.click(screen.getByRole('button',{name:'创建项目'}));await waitFor(()=>expect(resolve).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button',{name:'清除本页凭据'}));resolve({id:'late',name:'Late',objective:'',createdAt:'2026-09-30'});
  await waitFor(()=>expect(screen.getByRole('button',{name:'连接 Node 实例'})).toBeTruthy());expect(screen.queryByRole('heading',{name:'项目与环境'})).toBeNull();
});

test('legacy and disabled profiles remain visible but cannot start an incompatible browser', async () => {
  const f=fixture(), value=state();
  value.profiles=[{id:'legacy',projectId:'project',name:'Legacy login',storageRef:'persist:unchanged',loginStatus:'unknown'},
    {id:'disabled',projectId:'project',name:'Disabled Chromium',provider:'chromium',lifecycle:'disabled',loginStatus:'unknown'},
    {id:'supported',projectId:'project',name:'Supported Chromium',provider:'chromium',loginStatus:'unknown'}];
  f.setState(value); await f.connect(); fireEvent.change(screen.getByLabelText('当前项目'),{target:{value:'project'}});
  const options=Array.from((screen.getByLabelText('Chromium 环境') as HTMLSelectElement).options);
  expect(options.find(option=>option.value==='legacy')?.disabled).toBe(true);
  expect(options.find(option=>option.value==='legacy')?.textContent).toContain('Electron');
  expect(options.find(option=>option.value==='disabled')?.disabled).toBe(true);
  expect(options.find(option=>option.value==='supported')?.disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Chromium 环境'),{target:{value:'legacy'}});
  fireEvent.click(screen.getByRole('button',{name:'打开环境'})); fireEvent.click(screen.getByRole('button',{name:'开始录制并导航'}));
  expect(f.fetcher.mock.calls.some(([,init])=>['openEnvironment','startRun'].includes(JSON.parse(String(init?.body)).method))).toBe(false);
  fireEvent.change(screen.getByLabelText('Chromium 环境'),{target:{value:'supported'}});
  expect((screen.getByRole('button',{name:'打开环境'}) as HTMLButtonElement).disabled).toBe(false);
  value.projects[0].lifecycle='archived'; f.setState(value); fireEvent.click(screen.getByRole('button',{name:'刷新运行状态'}));
  await waitFor(()=>expect((screen.getByRole('button',{name:'打开环境'}) as HTMLButtonElement).disabled).toBe(true));
});
