import { readFile } from 'node:fs/promises';
import type { Studio } from './studio';
import { ensure } from '@/shared/errors';
import { loadWorkflow } from '@/runner/fingerprint';
import { inspectRunRecovery, recoverRun } from './run-recovery';
import { dispatchProject, PROJECT_METHODS } from './project-dispatch';
const READ=new Set(['state','projects','project','profiles','workflows','runs','run','pages','snapshot','checkpoints','summary','gaps','events','artifacts','artifact','artifactContent','handoffs','validations','validation','validationStartGrant','reviews','history','replay']);
export function makeDispatch(studio:Studio){
  return async function dispatch(method:string,body:any={},source:'api'|'ui'='ui',context:{signal?:AbortSignal}={}):Promise<any>{
    if(source==='api'&&['control','startRun','seal','pauseOperations','pauseCapture','saveProfile','replyHuman','releaseHuman','review','authorizeValidationStart','revokeValidationStart','inspect','navigate','navigateHistory','closePage','closeSession','syntheticSite','replay'].includes(method))ensure(false,'This operation requires the trusted client UI',403);
    if(['openReplay','seekReplay','replayStatus','selectReplay','closeReplay'].includes(method)){
      ensure(source==='ui','Native replay presentation is only available in the trusted client',403);
      if(method==='openReplay')return studio.replayHost.open(body);
      if(method==='seekReplay')return studio.replayHost.seek(body);
      if(method==='replayStatus')return studio.replayHost.status(body.replayId);
      if(method==='selectReplay')return studio.replayHost.select(body.replayId,body.enabled);
      return studio.replayHost.close(body.replayId);
    }
    if(PROJECT_METHODS.has(method))return dispatchProject(studio,method,body,source,context.signal);
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
    if(['checkpoint','startValidation'].includes(method))context.signal?.throwIfAborted();
    const grantStart=method==='startValidation'&&body.startGrantId!==undefined;
    const runMethods=new Set(['action','checkpoint','control','pauseOperations','pauseCapture','seal','inspect','selectPage','requestHuman','cancelHandoff','startValidation','stopRunner','saveProfile']);
    if(source==='api'&&runMethods.has(method)&&!grantStart){
      const r=studio.required();ensure(body.leaseEpoch===r.leaseEpoch,'Stale control lease',409);if(body.runId)ensure(body.runId===r.id,'Run is not active',409);if(body.profileId)ensure(body.profileId===r.profileId,'Profile is not active',409);
      if(!['cancelHandoff','stopRunner'].includes(method))ensure(r.controller==='agent','Human owns this browser; use the client to grant agent control',409);
    }
    if(source==='api'&&['snapshot','checkpoint','action'].includes(method)){
      const r=studio.required();ensure(body.runId===r.id,'Run is not active',409);
      ensure(typeof body.pageId==='string'&&Number.isSafeInteger(body.generation)&&body.generation>=0,'pageId and navigation generation are required',409);
      const page=r.pages.get(body.pageId);ensure(page&&page.navigationGeneration===body.generation,'Unknown page or stale navigation generation',409);
      if(method==='action')ensure(body.pageId===r.selectedPageId,'Action page is not selected',409);
    }
    if(source==='api'&&['createProject','updateProject'].includes(method))ensure(!body.scriptDirectory,'Workflow directories are registered in the trusted client UI',403);
    if(source==='api'&&method==='startValidation')ensure(!['directory','scriptDirectory','entry','code','manifest'].some(key=>body[key]!==undefined),'Validation only runs the registered workflow; paths and code are not accepted',403);
    switch(method){
      case 'state':return studio.state();case 'projects':return {items:studio.projects};case 'project':{const p=studio.projects.find(p=>p.id===body.projectId);ensure(p,'Unknown project',404);return p;}
      case 'inspectRunRecovery':ensure(source==='ui','Archive recovery inspection is available in the trusted client only',403);return inspectRunRecovery(studio,body);
      case 'recoverRun':ensure(source==='ui','Archive recovery is available in the trusted client only',403);return recoverRun(studio,body);
      case 'profiles':return {items:studio.profiles.filter(p=>p.projectId===body.projectId)};
      case 'runs':return {items:studio.runs.slice(0,100).map(({id,projectId,profileId,status,createdAt})=>({id,projectId,profileId,status,createdAt})),outputTruncated:studio.runs.length>100};case 'run':{const run=studio.runs.find(r=>r.id===body.runId);ensure(run,'Unknown run',404);return {...run,active:studio.active?.id===body.runId?studio.state().active:null};}
      case 'createProject':return studio.createProject(body);case 'updateProject':return studio.updateProject(body);case 'createProfile':return studio.createProfile(body);case 'startRun':ensure(source==='ui','Browser session creation requires the trusted client',403);return studio.startRun(body);
      case 'workflows':{const p=studio.projects.find(p=>p.id===body.projectId);ensure(p,'Unknown project',404);return {items:p.scriptDirectory?[{directory:p.scriptDirectory,manifest:(await loadWorkflow(p.scriptDirectory)).manifest}]:[]};}
      case 'registerWorkflow':{const p=studio.projects.find(p=>p.id===body.projectId);ensure(p?.scriptDirectory,'Register directory in the client UI first',409);ensure(!body.directory||body.directory===p.scriptDirectory,'Directory does not match registration',403);return (await loadWorkflow(p.scriptDirectory)).manifest;}
      case 'pages':ensure(studio.active?.id===body.runId,'Run is not active',409);return {items:studio.state().active!.pages};
      case 'snapshot':if(source==='api')ensure(studio.active?.id===body.runId,'Run is not active',409);return studio.snapshot(body);
      case 'navigate':ensure(source==='ui','Direct navigation is available in the trusted client only; use actions with a page identity',403);return studio.navigate(body.url);case 'action':return studio.action(body,context.signal);
      case 'selectPage':return studio.selectPage(body.pageId);
      case 'navigateHistory':ensure(source==='ui','Session navigation requires the trusted UI',403);ensure(['back','forward','reload'].includes(body.direction),'Unknown navigation direction');return studio.navigateHistory(body.direction);
      case 'closePage':ensure(source==='ui','Closing live pages requires the trusted UI',403);return studio.closePage(body.pageId);
      case 'closeSession':ensure(source==='ui','Closing the browser session requires the trusted UI',403);return studio.closeSession();
      case 'checkpoint':return studio.checkpoint(body,{signal:context.signal});
      case 'cancelCheckpoint':ensure(source==='ui','Checkpoint API cancellation uses its job identity',403);return studio.cancelCheckpoint(body);
      case 'inspect':ensure(studio.required().controller==='human'&&!['running'].includes(studio.required().execution),'Inspection requires human control',409);await studio.current().capture.inspect(!!body.enabled);return {enabled:!!body.enabled};
      case 'pauseOperations':ensure(source==='ui','Capture controls require the trusted client',403);return studio.pauseOperations(!!body.paused);case 'pauseCapture':ensure(source==='ui','Capture controls require the trusted client',403);return studio.pauseCapture(!!body.paused);case 'seal':ensure(source==='ui','Recording controls require the trusted client',403);return studio.seal();case 'control':ensure(source==='ui','Browser ownership is granted by the trusted client',403);ensure(['human','agent'].includes(body.controller),'Invalid controller');return studio.control(body.controller);case 'saveProfile':ensure(source==='ui','Profile persistence requires the trusted client',403);return studio.saveProfile();
      case 'history':return studio.history(body.runId);case 'summary':return studio.reader(body.runId).summary(body);case 'events':return studio.reader(body.runId).events(body);case 'gaps':return studio.reader(body.runId).gaps(body);case 'checkpoints':return studio.reader(body.runId).checkpoints(body);case 'artifacts':return studio.reader(body.runId).artifacts(body);
      case 'artifact':{ensure(body.runId,'runId query required');const result=await studio.reader(body.runId).artifact(body.artifactId||body.id,body);return source==='ui'?{...result,url:`bes-artifact://${body.runId}/${body.artifactId||body.id}`}:result;}
      case 'artifactContent':{ensure(body.runId,'runId query required');const result=await studio.reader(body.runId).artifactFile(body.artifactId||body.id);ensure(result.artifact.capturedBytes<=16*1024*1024,'Use bounded artifact reads for content above16MiB',413);return {binary:await readFile(result.path),mediaType:result.artifact.mediaType};}
      case 'syntheticSite':return studio.syntheticSite();case 'replay':ensure(source==='ui','Replay is a trusted UI view',403);return studio.replay(body);
      case 'authorizeValidationStart':ensure(source==='ui','Validation startup authorization requires the trusted client UI',403);return studio.authorizeValidationStart(body);
      case 'revokeValidationStart':ensure(source==='ui','Validation startup revocation requires the trusted client UI',403);return studio.revokeValidationStart(body);
      case 'validationStartGrant':return studio.validationStartGrant(body);
      case 'validate':case 'startValidation':ensure(source==='ui'||!grantStart,'Use the task authorization for repeated execution; one-time startup grants are no longer accepted over HTTP',403);return studio.validate(body,{signal:context.signal});case 'validation':return studio.validation(source==='api'?body.validationId:body.id||body.validationId);case 'validations':return {items:studio.state().validations.filter(v=>!body.runId||v.runId===body.runId)};case 'review':ensure(source==='ui','Human reviews must be submitted in the trusted client',403);return studio.review(body);
      case 'reviews':return studio.reviews(source==='api'?body.validationId:body.id||body.validationId,body);
      case 'requestHuman':return studio.startHandoff(body);case 'replyHuman':case 'releaseHuman':ensure(source==='ui','Only the trusted client can return human control',403);return studio.releaseHuman(body.handoffId||body.id);case 'cancelHandoff':return studio.cancelHandoff(body.handoffId||body.id);case 'handoffs':{const active=studio.active;return {items:active&&active.id===body.runId&&active.handoff?[active.handoff]:[]};}
      case 'stopRunner':if(source==='ui'){const state=studio.state();if(body.validationId)ensure(state.validationStarting?.validationId===body.validationId||state.validations.some(record=>record.id===body.validationId&&record.runId===studio.active?.id),'Validation stop target is stale',409);else if(body.runId)ensure(studio.active?.id===body.runId,'Stop target is stale',409);}return studio.stopRunner();case 'cancelJob':ensure(['startValidation','requestHuman','action'].includes(body.operation),'This short atomic operation cannot be cancelled after commit',409);return studio.stopRunner();
      default:ensure(false,'Unknown operation: '+method,404);
    }};
    // Read-only state and handoff replies must remain responsive during long operations.
    const invoke=()=>READ.has(method)||['replyHuman','releaseHuman','stopRunner','cancelJob','cancelHandoff','cancelCheckpoint','inspectRunRecovery','revokeValidationStart'].includes(method)?execute():studio.serialized(execute);
    if(source==='api'&&['snapshot','pages','action','checkpoint','startValidation','validate','selectPage','requestHuman','cancelHandoff','stopRunner','cancelJob'].includes(method)){
      const capability=['snapshot','pages'].includes(method)?'page-read':['startValidation','validate'].includes(method)?'execute':'page-act';
      return studio.authorizedOperation(body,capability,async signal=>{context={...context,signal};signal.throwIfAborted();return invoke();},context.signal);
    }
    if(source==='api'&&['run','summary','gaps','events','checkpoints','artifacts','artifact','artifactContent','history','validations','validation','reviews'].includes(method)){
      const runId=body.runId??studio.state().validations.find(item=>item.id===body.validationId)?.runId;
      const run=studio.runs.find(item=>item.id===runId);ensure(run,'An exact recording identity is required',404);
      if(body.projectId!==undefined)ensure(body.projectId===run.projectId,'Recording belongs to another project',403);
      return studio.tasks.run(body.authorizationId,['validations','validation','reviews'].includes(method)?'results-read':'history-read',{projectId:run.projectId},async()=>invoke(),context.signal);
    }
    return invoke();
  };
}
