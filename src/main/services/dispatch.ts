import { readFile } from 'node:fs/promises';
import type { Studio } from './studio';
import { ensure } from '../../shared/errors';
import { loadWorkflow } from '../../runner/fingerprint';
import { inspectRunRecovery, recoverRun } from './run-recovery';
const READ=new Set(['state','projects','project','profiles','workflows','runs','run','pages','snapshot','checkpoints','summary','gaps','events','artifacts','artifact','artifactContent','handoffs','validations','validation','reviews','history','replay']);
export function makeDispatch(studio:Studio){
  return async function dispatch(method:string,body:any={},source:'api'|'ui'='ui',context:{signal?:AbortSignal}={}):Promise<any>{
    // Presentation never enters the run queue: a capture can take seconds while
    // trusted dialogs and resize gestures still need to hide native surfaces.
    if(['presentation','uiPreferences','showBrowser'].includes(method)){
      ensure(source==='ui','UI presentation is available in the trusted client only',403);
      ensure(body&&typeof body==='object'&&!Array.isArray(body),'Invalid UI presentation request');
      if(method==='uiPreferences')return studio.window.uiPreferences(body);
      if(method==='showBrowser'){
        ensure(typeof body.visible==='boolean','Browser visibility must be a boolean');
        studio.window.setBrowserVisible(body.visible);return {};
      }
      ensure(body.reason==='overlay'||body.reason==='layout','Unknown UI presentation reason');
      ensure(typeof body.hidden==='boolean','UI presentation hidden must be a boolean');
      studio.window.setPresentation(body.reason,body.hidden);return {};
    }
    const execute=async()=>{
    if(method==='checkpoint')context.signal?.throwIfAborted();
    const runMethods=new Set(['action','checkpoint','control','pauseOperations','pauseCapture','seal','inspect','selectPage','requestHuman','replyHuman','cancelHandoff','startValidation','stopRunner','saveProfile']);
    if(source==='api'&&runMethods.has(method)){
      const r=studio.required();ensure(body.leaseEpoch===r.leaseEpoch,'Stale control lease',409);if(body.runId)ensure(body.runId===r.id,'Run is not active',409);if(body.profileId)ensure(body.profileId===r.profileId,'Profile is not active',409);
      if(!['replyHuman','cancelHandoff','stopRunner'].includes(method))ensure(r.controller==='agent','Human owns this browser; use the client to grant agent control',409);
    }
    if(source==='api'&&['snapshot','checkpoint'].includes(method)){
      const r=studio.required();ensure(body.runId===r.id,'Run is not active',409);
      ensure(typeof body.pageId==='string'&&Number.isSafeInteger(body.generation)&&body.generation>=0,'pageId and navigation generation are required',409);
      const page=r.pages.get(body.pageId);ensure(page&&page.navigationGeneration===body.generation,'Unknown page or stale navigation generation',409);
    }
    if(source==='api'&&['createProject','updateProject'].includes(method))ensure(!body.scriptDirectory,'Workflow directories are registered in the trusted client UI',403);
    switch(method){
      case 'state':return studio.state();case 'projects':return {items:studio.projects};case 'project':{const p=studio.projects.find(p=>p.id===body.projectId);ensure(p,'Unknown project',404);return p;}
      case 'inspectRunRecovery':ensure(source==='ui','Archive recovery inspection is available in the trusted client only',403);return inspectRunRecovery(studio,body);
      case 'recoverRun':ensure(source==='ui','Archive recovery is available in the trusted client only',403);return recoverRun(studio,body);
      case 'profiles':return {items:studio.profiles.filter(p=>p.projectId===body.projectId)};
      case 'runs':return {items:studio.runs.slice(0,100)};case 'run':{const run=studio.runs.find(r=>r.id===body.runId);ensure(run,'Unknown run',404);return {...run,active:studio.active?.id===body.runId?studio.state().active:null};}
      case 'createProject':return studio.createProject(body);case 'updateProject':return studio.updateProject(body);case 'createProfile':return studio.createProfile(body);case 'startRun':return studio.startRun(body);
      case 'workflows':{const p=studio.projects.find(p=>p.id===body.projectId);ensure(p,'Unknown project',404);return {items:p.scriptDirectory?[{directory:p.scriptDirectory,manifest:(await loadWorkflow(p.scriptDirectory)).manifest}]:[]};}
      case 'registerWorkflow':{const p=studio.projects.find(p=>p.id===body.projectId);ensure(p?.scriptDirectory,'Register directory in the client UI first',409);ensure(!body.directory||body.directory===p.scriptDirectory,'Directory does not match registration',403);return (await loadWorkflow(p.scriptDirectory)).manifest;}
      case 'pages':ensure(studio.active?.id===body.runId,'Run is not active',409);return {items:studio.state().active!.pages};
      case 'snapshot':if(source==='api')ensure(studio.active?.id===body.runId,'Run is not active',409);return studio.snapshot(body);
      case 'navigate':return studio.navigate(body.url);case 'action':return studio.action(body);
      case 'selectPage':{const r=studio.required(),p=r.pages.get(body.pageId),leaseEpoch=r.leaseEpoch;ensure(p,'Unknown page');ensure(!['running','waiting-human','finalizing','stopping'].includes(r.execution),'Cannot change execution target while running',409);ensure(!r.pendingOperation,'Operation connection is still starting',409);const operation=r.operation;if(operation){await operation.gate.quiesce();await operation.browser.disconnect();if(r.operation===operation)r.operation=undefined;}ensure(studio.active===r&&r.leaseEpoch===leaseEpoch&&r.pages.get(p.pageId)===p,'Page selection was cancelled',409);r.selectedPageId=p.pageId;r.leaseEpoch++;studio.window.show(p.view);return studio.state();}
      case 'checkpoint':return studio.checkpoint(body,{signal:context.signal});
      case 'cancelCheckpoint':ensure(source==='ui','Checkpoint API cancellation uses its job identity',403);return studio.cancelCheckpoint(body);
      case 'inspect':ensure(studio.required().controller==='human'&&!['running'].includes(studio.required().execution),'Inspection requires human control',409);await studio.current().capture.inspect(!!body.enabled);return {enabled:!!body.enabled};
      case 'pauseOperations':return studio.pauseOperations(!!body.paused);case 'pauseCapture':return studio.pauseCapture(!!body.paused);case 'seal':return studio.seal();case 'control':ensure(['human','agent'].includes(body.controller),'Invalid controller');return studio.control(body.controller);case 'saveProfile':return studio.saveProfile();
      case 'history':return studio.history(body.runId);case 'summary':return studio.reader(body.runId).summary(body);case 'events':return studio.reader(body.runId).events(body);case 'gaps':return studio.reader(body.runId).gaps(body);case 'checkpoints':return studio.reader(body.runId).checkpoints(body);case 'artifacts':return studio.reader(body.runId).artifacts(body);
      case 'artifact':{ensure(body.runId,'runId query required');const result=await studio.reader(body.runId).artifact(body.artifactId||body.id,body);return source==='ui'?{...result,url:`bes-artifact://${body.runId}/${body.artifactId||body.id}`}:result;}
      case 'artifactContent':{ensure(body.runId,'runId query required');const result=await studio.reader(body.runId).artifactFile(body.artifactId||body.id);ensure(result.artifact.capturedBytes<=16*1024*1024,'Use bounded artifact reads for content above16MiB',413);return {binary:await readFile(result.path),mediaType:result.artifact.mediaType};}
      case 'syntheticSite':return studio.syntheticSite();case 'replay':ensure(source==='ui','Replay is a trusted UI view',403);return studio.replay(body);
      case 'validate':case 'startValidation':return studio.validate(body);case 'validation':return studio.validation(source==='api'?body.validationId:body.id||body.validationId);case 'validations':return {items:studio.state().validations.filter(v=>!body.runId||v.runId===body.runId)};case 'review':return studio.review({...body,id:source==='api'?body.validationId:body.id||body.validationId});
      case 'reviews':return studio.reviews(source==='api'?body.validationId:body.id||body.validationId,body);
      case 'requestHuman':return studio.startHandoff(body);case 'replyHuman':case 'releaseHuman':return studio.releaseHuman(body.handoffId||body.id);case 'cancelHandoff':return studio.cancelHandoff(body.handoffId||body.id);case 'handoffs':{const active=studio.active;return {items:active&&active.id===body.runId&&active.handoff?[active.handoff]:[]};}
      case 'stopRunner':return studio.stopRunner();case 'cancelJob':ensure(['startValidation','requestHuman','action'].includes(body.operation),'This short atomic operation cannot be cancelled after commit',409);return studio.stopRunner();
      default:ensure(false,'Unknown operation: '+method,404);
    }};
    // Read-only state and handoff replies must remain responsive during long operations.
    return READ.has(method)||['replyHuman','releaseHuman','stopRunner','cancelJob','cancelHandoff','cancelCheckpoint','inspectRunRecovery'].includes(method)?execute():studio.serialized(execute);
  };
}
