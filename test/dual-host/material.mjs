import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {click,fill,select,disclose,hasText,element,exactPositionOption,until,selectCard} from './ui.mjs';
import {readCurrent,pair,readJson} from './host.mjs';
import {assertReplay,projectedClick,viewportEvidence,readReplay} from './replay-observe.mjs';
import {stable} from './source-manifest.mjs';
export const hash=value=>createHash('sha256').update(value).digest('hex');

export async function authorMaterial(c,mark){
  const{web,report,source}=c;
  await pair(c);await click(web,'打开项目资料工作区');await hasText(web,'资料连接已就绪');
  await select(web,'来源录制',c.recordingId);await select(web,'来源文档流',source.baseline.documentId);await exactPositionOption(web,'来源事件位置',source.thirteen.eventSeq);
  await web.waitForFunction(seq=>document.querySelector('.browser-source-picker [role=status]')?.textContent.endsWith('事件 #'+seq),{},source.thirteen.eventSeq);
  let draft=await readCurrent(c);assert.equal(draft.content.checkpoints.length,0);assert.equal(draft.content.fields.length,0);
  const invalidationsBefore=report.scopeInvalidations.length;
  await disclose(web,'任务目标与共享需求');await click(web,'编辑任务目标');await fill(web,'任务目标','按历史显示字符串绑定金额字段');await click(web,'保存任务目标');
  await click(web,'新增保存点');await fill(web,'标题','B4 精确历史金额');await fill(web,'说明','绑定金额 13.00 的精确来源事件');await click(web,'完成保存点编辑');
  draft=await until(()=>readCurrent(c),d=>d.content.checkpoints.length===1,'UI material checkpoint');assert.deepEqual(draft.content.checkpoints[0].anchor,source.thirteen);
  assert(!report.sseObservationError,report.sseObservationError);await until(()=>report.scopeInvalidations.length,n=>n>invalidationsBefore,'legitimate same-session material SSE invalidation');assert(report.scopeInvalidations.slice(invalidationsBefore).every(e=>e.projectId===c.projectId));
  await mark('normal-shared-ui-exact-source-checkpoint-and-sse-invalidation');
  await click(web,'查看来源');const replay=await assertReplay(web,c.launch.replayOrigin,source.sourceNodeId,'13.00');report.replay=replay.state;assert.notEqual(new URL(replay.frame.url()).origin,c.launch.frontendOrigin);await viewportEvidence(web,c.root,'offline-replay',report);
  await click(web,'关闭历史回放');await click(web,'添加字段');await fill(web,'字段名','amount');await fill(web,'明确含义','页面显示金额按字符串原样保存，历史例值 13.00');await select(web,'值类型','string');await select(web,'来源要求','page-displayed');
  await click(web,'选择当前保存点的元素');await assertReplay(web,c.launch.replayOrigin,source.sourceNodeId,'13.00');await hasText(web,'点选历史元素');const selections=report.rpc.filter(r=>r.method==='webReplaySelection').length;
  await projectedClick(web,c.launch.replayOrigin,'#amount');await element(web,'button','解除绑定');await disclose(web,'查看绑定来源');const preview=await web.$eval('[aria-label="编辑字段"]',e=>e.innerText);
  assert(preview.includes('节点 '+source.sourceNodeId+' / '+source.metadata.frameId));assert(preview.includes(c.recordingId));assert(preview.includes('事件 #'+source.thirteen.eventSeq));assert.equal(report.rpc.filter(r=>r.method==='webReplaySelection').length,selections+1);report.selectionPreview=preview;await viewportEvidence(web,c.root,'selected-field',report);
  await disclose(web,'高级实现信息');await fill(web,'数据集','orders');await fill(web,'输出 JSON Pointer','/amount');await fill(web,'来源规则 JSON',JSON.stringify({kind:'dom-text',sourceUrl:c.sourceUrl+'/',nodeAttribute:{name:'data-field',value:'amount'},entityAttribute:'data-entity',outputEntityPath:'/id'}));await click(web,'保存字段');
  draft=await until(()=>readCurrent(c),d=>d.content.fields.length===1,'UI field saved');const field=draft.content.fields[0];assert.equal(field.bindingStatus,'bound');assert.deepEqual(field.target,{kind:'dom-node',position:source.thirteen,nodeId:source.sourceNodeId,frameId:source.metadata.frameId,mirrorScopeId:source.metadata.mirrorScopeId});report.boundField=field;
  await click(web,'关闭历史回放');await click(web,'资料存档');await click(web,'保存存档版本');await fill(web,'版本名称','B4 同输入固定版');await click(web,'确认保存存档版本');await hasText(web,'已保存存档版本');
  const files=(await fs.readdir(c.materialRoot+'/revisions')).filter(f=>f.endsWith('.json'));assert.equal(files.length,1);c.fixedFile=c.materialRoot+'/revisions/'+files[0];const bytes=await fs.readFile(c.fixedFile),fixed=JSON.parse(bytes);assert.equal(hash(stable(fixed.content)),fixed.contentHash);assert.deepEqual(fixed.content.fields[0].target,field.target);
  report.fixed={revisionId:fixed.revisionId,contentHash:fixed.contentHash,fileHash:hash(bytes),content:fixed.content};await click(web,'查看固定版本');await hasText(web,fixed.contentHash);await viewportEvidence(web,c.root,'fixed-readonly',report);
  await web.reload();await pair(c);await click(web,'打开项目资料工作区');await click(web,'资料存档');await click(web,'查看固定版本');await hasText(web,fixed.contentHash);await hasText(web,field.description);await mark('actual-node-binding-fixed-hash-and-refresh-readback');
  c.fixed=fixed;c.field=field;c.requirement=fixed.content.requirements.find(r=>r.fieldIds.includes(field.id));assert(c.requirement&&c.requirement.dataset==='orders');
}

export async function nativeReadback(c,mark){
  if(c.host!=='electron')return;
  const{ui}=c;await ui.bringToFront();await ui.keyboard.press('Escape');await ui.reload();await ui.waitForSelector('.material-card-list button');
  const recovery=await ui.evaluate(()=>[...document.querySelectorAll('button')].find(e=>/^读取修订 \d+ 并处理冲突$/.test(e.textContent.trim()))?.textContent.trim());
  if(recovery){const before=await readCurrent(c);await click(ui,recovery);await ui.waitForFunction(()=>![...document.querySelectorAll('button')].some(e=>/^读取修订 \d+ 并处理冲突$/.test(e.textContent.trim())));assert.deepEqual(await readCurrent(c),before)}
  await selectCard(ui,'B4 精确历史金额');await click(ui,'查看来源');
  const replay=await until(async()=>{for(const p of await c.eb.pages()){if(p===ui||p===c.live)continue;try{if(await p.evaluate(()=>!!window.__besReplayController&&!!document.querySelector('#replay iframe')))return p}catch{}}},Boolean,'native shared replay target');
  const state=await until(()=>readReplay(replay),s=>s.amount==='13.00','native archived amount');assert.equal(state.nodeId,c.source.sourceNodeId);assert.equal(state.controller,'function');assert.equal(state.imageWidth,1);assert.equal(state.bannerColor,'rgb(12, 67, 89)');c.report.nativeReplay=state;
  await ui.screenshot({path:c.root+'/native-replay-controls.png',fullPage:true});await replay.screenshot({path:c.root+'/native-shared-replay.png'});await click(ui,'返回实时页面');await click(ui,'存档');await click(ui,'资料版本');await click(ui,'查看固定版本');await hasText(ui,c.fixed.contentHash);await hasText(ui,c.field.description);await ui.screenshot({path:c.root+'/native-fixed-readback.png',fullPage:true});await mark('actual-electron-shared-replay-fixed-readback');
}
