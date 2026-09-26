import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Studio } from '@/main/services/studio';
import type { ReplayPosition } from '@/contracts/recording';

interface WorkbenchFixture { projectId: string; recordingId: string; replayPosition: ReplayPosition; executionId?: string; partialExecutionId?: string; brokenDatasetId?: string; targetSelector?: string }

/** Run only under the root desktop lock, after the A/B/C/E/F synthetic chain.
 * Every mutation below originates in the trusted React renderer. The native
 * input targets E's isolated ReplayHost, never the business page. */
export async function runRefactorWorkbenchUi(studio: Studio, fixture: WorkbenchFixture): Promise<void> {
  const ui = studio.window.window.webContents;
  const evaluate = <T>(source: string): Promise<T> => ui.executeJavaScript(source, true);
  const wait = async <T>(read: () => Promise<T>, valid: (value: T) => boolean, name: string): Promise<T> => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const value = await read(); if (valid(value)) return value; await delay(80); }
    const diagnostic = await evaluate<string>(`document.querySelector('.workspace-error')?.textContent || document.querySelector('.replay-workspace .error-inline')?.textContent || document.querySelector('.replay-status')?.textContent || document.querySelector('.overlay-body')?.textContent?.slice(0,300) || document.body.textContent?.slice(0,300) || ''`);
    const replayActive=(studio as any).replayHost?.active,host=replayActive?.state;
    const nativeSelection=host?.selecting ? await replayActive.view.webContents.executeJavaScript('window.__besReplay').catch(()=>null) : null;
    const nativePlayback=host?.status==='ready' ? await replayActive.view.webContents.executeJavaScript('({clock:window.__besPlayer?.getCurrentTime(),ended:window.__besPlaybackEnded,playerState:window.__besPlayer?.getPlayerState?.()})').catch(()=>null) : null;
    const playback=replayActive?.playback;
    const material=await evaluate(`({toolbar:document.querySelector('.material-toolbar')?.textContent,buttons:Array.from(document.querySelectorAll('.material-toolbar button')).map(button=>({text:button.textContent,disabled:button.disabled})),error:document.querySelector('.material-workbench .error-inline')?.textContent,notice:document.querySelector('.material-workbench .notice')?.textContent})`);
    throw new Error(`Workbench UI timed out: ${name}; ${diagnostic}; material=${JSON.stringify(material)}; host=${JSON.stringify({status:host?.status,error:host?.error,position:host?.position,resources:host?.resources,selecting:host?.selecting,selectionSequence:host?.selectionSequence,selectionError:host?.selectionError,selection:host?.selection,bridgeSequence:replayActive?.bridgeSequence,nativeSelection,nativePlayback,offsets:playback?.offsets?.slice(0,5),lastOffset:playback?.offsets?.at(-1)})}`);
  };
  const click = async (name: string, scope = 'document') => wait(() => evaluate<boolean>(`(() => {
    const root=${scope};const button=Array.from(root?.querySelectorAll('button')||[]).find(value=>value.textContent.trim()===${JSON.stringify(name)});
    if(!button||button.disabled)return false;button.focus();button.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0}));
    button.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,button:0}));button.click();return true;
  })()`), Boolean, `click ${name}`);
  const clickIncludes = async (name: string, scope = 'document') => wait(() => evaluate<boolean>(`(() => {
    const root=${scope};const button=Array.from(root?.querySelectorAll('button')||[]).find(value=>value.textContent.includes(${JSON.stringify(name)}));
    if(!button||button.disabled)return false;button.click();return true;
  })()`), Boolean, `click ${name}`);
  const fillLabel = async (name: string, value: string) => {
    const found = await evaluate<boolean>(`(() => {const label=Array.from(document.querySelectorAll('.material-editor label')).find(node=>node.textContent.trim().startsWith(${JSON.stringify(name)}));
      const input=label?.querySelector('input,textarea');if(!input)return false;
      const base=input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(base,'value').set.call(input,${JSON.stringify(value)});
      input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    assert(found, `UI labeled input missing: ${name}`);
  };
  const openRun = async (runId: string) => {
    await click('存档', `document.querySelector('.panel-tabs')`);
    const index = studio.runs.filter(run => run.projectId === fixture.projectId).findIndex(run => run.id === runId);
    assert(index >= 0, `Run ${runId} was not indexed in the project`);
    await wait(() => evaluate<number>(`document.querySelectorAll('.run-list .run-item').length`), count => count > index, 'project archive list');
    await evaluate<void>(`document.querySelectorAll('.run-list .run-item')[${index}].click()`);
    await wait(() => evaluate<string>(`document.querySelector('.archive-meta code')?.textContent || ''`), value => value === runId, 'requested run archive');
  };
  assert.equal(fixture.replayPosition.recordingId, fixture.recordingId);
  assert.equal(studio.active?.projectId, fixture.projectId, 'Fixture requires a human active run in the recorded project');
  assert.equal(studio.active?.controller, 'human');
  await wait(() => evaluate<string>(`document.querySelector('select[aria-label="项目"]')?.value || ''`), value => value === fixture.projectId, 'selected project');
  await openRun(fixture.recordingId);
  await click('回放此存档', `document.querySelector('.archive-meta')`);
  await wait(() => evaluate<string>(`document.querySelector('.replay-timeline')?.textContent || ''`), text => text.includes('event #'), 'native replay ready');
  const streamIndex=await wait(()=>evaluate<number>(`Array.from(document.querySelector('select[aria-label="历史页面流"]')?.options||[]).findIndex(option=>option.textContent.includes(${JSON.stringify(fixture.replayPosition.pageId.slice(0,12))})&&option.textContent.includes(${JSON.stringify(fixture.replayPosition.documentId.slice(0,12))}))`),value=>value>=0,'recorded page stream');
  await evaluate<void>(`(()=>{const select=document.querySelector('select[aria-label="历史页面流"]');if(select.value!==${JSON.stringify(String(streamIndex))}){select.value=${JSON.stringify(String(streamIndex))};select.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await wait(()=>evaluate<string>(`document.querySelector('select[aria-label="历史页面流"]')?.value||''`),value=>value===String(streamIndex),'selected page stream');
  await wait(async()=>(studio as any).replayHost?.active?.state,value=>value?.status==='ready'&&value.position?.pageId===fixture.replayPosition.pageId&&value.position?.documentId===fixture.replayPosition.documentId,'native source stream ready');
  const hostBefore=(studio as any).replayHost.active.state;
  await evaluate<void>(`(()=>{const select=document.querySelector('select[aria-label="播放速度"]');select.value='0.5';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await click('播放',`document.querySelector('.replay-controls')`);
  await wait(async()=>(studio as any).replayHost.active.state.playing,Boolean,'native continuous playback');
  await wait(async()=>(studio as any).replayHost.active.state.position.eventSeq,value=>value>hostBefore.position.eventSeq,'source clock advances to another event');
  await click('暂停',`document.querySelector('.replay-controls')`);
  const paused=await wait(async()=>(studio as any).replayHost.active.state, value=>value.playing===false&&value.position.eventSeq>hostBefore.position.eventSeq,'native playback pause');
  assert.ok(paused.rebuilds<=hostBefore.rebuilds+1,'A hundred source events must reuse one Replayer');
  await wait(()=>evaluate<string>(`document.querySelector('.replay-timeline')?.textContent||''`),value=>value.includes(`event #${paused.position.eventSeq}`),'paused React timeline');
  await click('下一步',`document.querySelector('.replay-timeline')`);
  await wait(async()=>(studio as any).replayHost.active.state.position.eventSeq,value=>value>paused.position.eventSeq,'forward exact seek');
  await click('上一步',`document.querySelector('.replay-timeline')`);
  await wait(async()=>(studio as any).replayHost.active.state.position.eventSeq,value=>value===paused.position.eventSeq,'backward exact seek');
  const sequence = fixture.replayPosition.eventSeq;
  for(let page=0;page<4;page++){
    const loaded=await evaluate<boolean>(`Array.from(document.querySelectorAll('.replay-sequence button')).some(button=>button.textContent.trim()===${JSON.stringify(`#${sequence}`)})`);
    if(loaded)break;
    const previous=await evaluate<number>(`document.querySelectorAll('.replay-sequence button').length`);
    await click('后续事件',`document.querySelector('.replay-sequence')`);
    await wait(()=>evaluate<number>(`document.querySelectorAll('.replay-sequence button').length`),value=>value>previous,'later source positions');
  }
  const alreadyAt = await evaluate<boolean>(`document.querySelector('.replay-timeline')?.textContent?.includes(${JSON.stringify(`event #${sequence}`)}) || false`);
  if (!alreadyAt) await click(`#${sequence}`, `document.querySelector('.replay-sequence')`);
  await wait(() => evaluate<string>(`document.querySelector('.replay-timeline')?.textContent || ''`), text => text.includes(`event #${sequence}`), 'exact replay position');
  await click('任务资料', `document.querySelector('.panel-tabs')`);
  await click('新建', `document.querySelector('.material-list')`);
  await wait(() => evaluate<boolean>(`!!document.querySelector('.material-editor .material-toolbar code')`), Boolean, 'new draft');
  await fillLabel('标题', 'D fixture checkpoint');
  await click('保存卡片草稿', `document.querySelector('.material-editor')`);
  await wait(() => evaluate<number>(`document.querySelectorAll('.material-card-list button').length`), count => count === 1, 'saved historical checkpoint');
  await clickIncludes('D fixture checkpoint', `document.querySelector('.material-card-list')`);
  await click('复制', `document.querySelector('.material-actions')`);
  await wait(() => evaluate<number>(`document.querySelectorAll('.material-card-list button').length`), count => count === 2, 'independent copied card');
  await fillLabel('需求说明', 'D fixture source requirement');
  await click('保存需求', `document.querySelector('.material-editor')`);
  await wait(() => evaluate<string>(`Array.from(document.querySelectorAll('.material-editor label')).find(node=>node.textContent.trim().startsWith('需求'))?.querySelector('select')?.value || ''`), Boolean, 'requirement saved and selected');
  await click('从历史页绑定元素', `document.querySelector('.material-editor')`);
  await wait(() => evaluate<boolean>(`!!document.querySelector('.replay-cancel-selection')`), Boolean, 'history inspection mode');
  await wait(async()=>(studio as any).replayHost?.active?.state?.selecting,Boolean,'native inspection active');
  const replay = (studio as any).replayHost?.active?.view?.webContents;
  assert(replay, 'The isolated native ReplayHost must exist during inspection');
  replay.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  replay.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await wait(() => evaluate<boolean>(`!document.querySelector('.replay-cancel-selection')`), Boolean, 'Escape cancels historical selection');
  await click('从历史页绑定元素', `document.querySelector('.material-editor')`);
  await wait(() => evaluate<boolean>(`!!document.querySelector('.replay-cancel-selection')`), Boolean, 'inspection re-entered');
  await wait(async()=>(studio as any).replayHost?.active?.state?.selecting,Boolean,'native inspection re-entered');
  const selector = fixture.targetSelector || '[data-entity="o-1"] [data-field="amount"]';
  const point: { x: number; y: number } = await replay.executeJavaScript(`(async() => {
    const frame=document.querySelector('#replay iframe'),element=frame?.contentDocument?.querySelector(${JSON.stringify(selector)});
    if(!frame||!element)throw new Error('Synthetic replay target is absent');
    element.scrollIntoView({block:'center'});
    const locate=()=>{const a=frame.getBoundingClientRect(),b=element.getBoundingClientRect();
      const sx=a.width/(frame.contentWindow?.innerWidth||frame.clientWidth||a.width),sy=a.height/(frame.contentWindow?.innerHeight||frame.clientHeight||a.height);
      return {x:Math.round(a.left+(b.left+b.width/2)*sx),y:Math.round(a.top+(b.top+b.height/2)*sy)};};
    let point=locate();
    if(point.y<0||point.y>=innerHeight)window.scrollTo(0,window.scrollY+point.y-innerHeight/2);
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    point=locate();
    if(point.x<0||point.x>=innerWidth||point.y<0||point.y>=innerHeight)throw new Error('Historical target is outside ReplayHost viewport: '+JSON.stringify({point,width:innerWidth,height:innerHeight,scrollY}));
    return point;
  })()`);
  replay.sendInputEvent({ type: 'mouseMove', ...point });
  replay.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  replay.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await delay(100);
  const inputProbe=await replay.executeJavaScript(`(()=>{const cover=document.querySelector('#selection'),rect=cover.getBoundingClientRect();return {point:${JSON.stringify(point)},width:innerWidth,height:innerHeight,cover:cover.style.display,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},hit:document.elementFromPoint(${point.x},${point.y})?.id,bridge:window.__besReplay};})()`);
  assert.ok(inputProbe.bridge.sequence>0,`Native input did not reach replay selection: ${JSON.stringify(inputProbe)}`);
  await wait(() => evaluate<boolean>(`!!document.querySelector('.material-editor .material-actions .muted')`), Boolean, 'historical DOM target returned to field editor');
  await fillLabel('数据集', 'orders'); await fillLabel('字段名', 'amount'); await fillLabel('明确含义', '页面显示的订单金额');
  await click('保存字段', `document.querySelector('.material-editor')`);
  await wait(() => evaluate<string>(`document.querySelector('.material-workbench .notice')?.textContent || ''`), text => text.includes('字段和需求关联已保存'), 'bound field without annotation');
  assert(await evaluate<boolean>(`!!document.querySelector('.material-editor .material-actions .muted')`), 'Historical target remains selected without an annotation');
  await fillLabel('新需求含义','D fixture linked requirement');
  await click('新建并关联需求',`document.querySelector('.material-editor')`);
  await wait(()=>evaluate<string>(`document.querySelector('.material-workbench .notice')?.textContent||''`),value=>value.includes('新需求已关联当前卡片'),'in-place requirement link');
  await click('新增注释',`document.querySelector('.material-editor')`);
  await click('在历史页选择元素',`document.querySelector('.material-editor')`);
  await wait(()=>evaluate<boolean>(`!!document.querySelector('.replay-cancel-selection')`),Boolean,'annotation inspection mode');
  await wait(async()=>(studio as any).replayHost?.active?.state?.selecting,Boolean,'native annotation inspection active');
  const beforeAnnotation=await replay.executeJavaScript('window.__besReplay.sequence');
  replay.sendInputEvent({ type: 'mouseMove', ...point });
  replay.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  replay.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await wait(async()=>replay.executeJavaScript('window.__besReplay.sequence'),value=>value>beforeAnnotation,'native annotation target');
  await fillLabel('注释','D fixture original observation');
  await click('保存注释',`document.querySelector('.material-editor')`);
  await wait(()=>evaluate<string>(`document.querySelector('.material-annotation')?.textContent||''`),value=>value.includes('D fixture original observation'),'saved annotation');
  await click('编辑注释',`document.querySelector('.material-annotation')`);
  await fillLabel('注释','D fixture revised observation');
  await click('保存注释修改',`document.querySelector('.material-editor')`);
  await wait(()=>evaluate<string>(`document.querySelector('.material-annotation')?.textContent||''`),value=>value.includes('D fixture revised observation'),'revised annotation');
  assert(await evaluate<boolean>(`!!document.querySelector('.material-editor .material-actions .muted')`),'Annotation selection must not clear the field target');
  const editedDraftId=await evaluate<string>(`document.querySelector('.material-editor .material-toolbar code')?.textContent||''`);
  await click('发布候选版本',`document.querySelector('.material-editor .material-toolbar')`);
  const published=await wait(()=>evaluate<string>(`document.querySelector('.material-workbench .notice')?.textContent||''`),value=>value.includes('已发布候选资料版本'),'published revised material');
  const publishedId=published.match(/[a-f0-9]{8}-[a-f0-9-]{27,}/)?.[0];assert(publishedId,'Published revision identity is visible');
  const publishedPrefix=publishedId.slice(0,15);
  await wait(()=>evaluate<boolean>(`!!Array.from(document.querySelectorAll('.material-revision')).find(row=>row.textContent.includes(${JSON.stringify(publishedPrefix)}))`),Boolean,'new fixed revision listed');
  await click('查看固定版本',`Array.from(document.querySelectorAll('.material-revision')).find(row=>row.textContent.includes(${JSON.stringify(publishedPrefix)}))`);
  await wait(()=>evaluate<string>(`document.querySelector('.material-editor section')?.textContent||''`),value=>value.includes('D fixture revised observation')&&value.includes('D fixture linked requirement'),'read-only fixed version content');
  await click('从此版本派生草稿',`document.querySelector('.material-editor section')`);
  await wait(()=>evaluate<string>(`document.querySelector('.material-editor .material-toolbar code')?.textContent||''`),value=>!!value&&value!==editedDraftId,'derived editable draft');
  await click('任务授权', `document.querySelector('.topbar')`);
  await wait(() => evaluate<boolean>(`!!document.querySelector('.task-authorizations')`), Boolean, 'task authorization dialog');
  const priorGrantIds = new Set(((studio as any).tasks.list(fixture.projectId) as Array<{ authorizationId: string }>).map(item => item.authorizationId));
  await evaluate<void>(`(() => {const box=Array.from(document.querySelectorAll('.task-capabilities label')).find(item=>item.textContent.includes('读取当前页面'))?.querySelector('input');
    if(!box)throw new Error('page-read capability missing');box.click();})()`);
  await click('授予这次任务', `document.querySelector('.task-authorizations')`);
  const issued = await wait(async () => ((studio as any).tasks.list(fixture.projectId) as Array<{ authorizationId: string; status: string; pages: unknown[]; origins: string[] }>).find(item => !priorGrantIds.has(item.authorizationId)), Boolean, 'trusted UI grant issued');
  assert(issued, 'Trusted UI did not create a task authorization');
  assert(issued.status === 'active' && issued.pages.length > 0 && issued.origins.length > 0, 'Browser grant retains page and origin scope');
  await wait(() => evaluate<boolean>(`!!Array.from(document.querySelectorAll('.task-grant')).find(node=>node.textContent.includes(${JSON.stringify(issued.authorizationId)}))?.querySelector('button')`), Boolean, 'new grant card visible');
  await click('撤销此授权', `Array.from(document.querySelectorAll('.task-grant')).find(node=>node.textContent.includes(${JSON.stringify(issued.authorizationId)}))`);
  await wait(async () => (studio as any).tasks.get(issued.authorizationId).status, status => status === 'revoked', 'trusted UI revocation');
  await click('返回工作台', `document.querySelector('.overlay-heading')`);
  if (fixture.executionId) {
    const record = studio.state().validations.find((item: any) => item.executionId === fixture.executionId);
    assert(record, 'Fixed execution must be discoverable in the archive index');
    await openRun(record.runId);
    await click('结构化数据 / 验收', `document.querySelector('.archive-tabs')`);
    await wait(() => evaluate<number>(`document.querySelectorAll('.validation-list button').length`), count => count > 0, 'validation list');
    const index = studio.state().validations.filter((item: any) => item.runId === record.runId).findIndex((item: any) => item.id === record.id);
    assert(index >= 0);
    await evaluate<void>(`document.querySelectorAll('.validation-list button')[${index}].click()`);
    await wait(() => evaluate<string>(`document.querySelector('.result-center code')?.textContent || ''`), value => value === fixture.executionId, 'fixed result center');
    await wait(() => evaluate<boolean>(`!!document.querySelector('.result-summary')`), Boolean, 'actual bound result summary');
    if(fixture.brokenDatasetId){
      await wait(()=>evaluate<string>(`document.querySelector('.result-center')?.textContent||''`),value=>value.includes(fixture.brokenDatasetId!)&&value.includes('INDEX_RECOVERY_REQUIRED')&&value.includes('unexpected-attempt')&&value.includes('2 条 / 1 批'),'mixed healthy and corrupt dataset catalog');
      await click('查看数据',`Array.from(document.querySelectorAll('.result-center .result-row')).find(row=>row.querySelector('strong')?.textContent==='orders'&&Array.from(row.querySelectorAll('button')).some(button=>button.textContent.trim()==='查看数据'))`);
      await wait(()=>evaluate<string>(`document.querySelector('.result-center .result-data h4')?.textContent||''`),value=>value.includes('orders'),'healthy dataset still opens after catalog fault');
    }
  }
  if(fixture.partialExecutionId){
    const record=studio.state().validations.find((item:any)=>item.executionId===fixture.partialExecutionId);assert(record,'Partial execution must be indexed');
    await openRun(record.runId);await click('结构化数据 / 验收',`document.querySelector('.archive-tabs')`);
    const index=studio.state().validations.filter((item:any)=>item.runId===record.runId).findIndex((item:any)=>item.id===record.id);assert(index>=0);
    await wait(()=>evaluate<number>(`document.querySelectorAll('.validation-list button').length`),value=>value>index,'partial validation list');
    await evaluate<void>(`document.querySelectorAll('.validation-list button')[${index}].click()`);
    await wait(()=>evaluate<string>(`document.querySelector('.result-center code')?.textContent||''`),value=>value===fixture.partialExecutionId,'partial fixed result center');
    await wait(()=>evaluate<string>(`document.querySelector('.result-center')?.textContent||''`),value=>value.includes('partial')&&value.includes('2 条 / 1 批'),'partial step with committed records');
  }
  console.log('D trusted workbench UI PASS: 241-event replay/pause/seeks, moved source, scoped field/annotation selection, requirement edit, fixed version derive, grant/revoke, full/partial and mixed corrupt results');
}
