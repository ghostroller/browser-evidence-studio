import { readFile, stat } from 'node:fs/promises';
import type { Studio } from './studio';
import { ensure } from '@/shared/errors';
import path from 'node:path';
import { loadWorkflow, resolveRegisteredFile } from '@/runner/fingerprint';
import { inspectRunRecovery, recoverRun, recoverRunIndexes } from './run-recovery';
import { dispatchProject, PROJECT_METHODS } from './project-dispatch';
const READ=new Set(['state','projects','project','profiles','workflows','runs','run','pages','snapshot','checkpoints','summary','gaps','events','artifacts','artifact','artifactContent','handoffs','validations','validation','validationStartGrant','reviews','history','replay']);
function originAllowed(grant:{origins:string[]},url:string){try{return grant.origins.includes(new URL(url).origin);}catch{return false;}}
export function makeDispatch(studio:Studio){
  return async function dispatch(method:string,body:any={},source:'api'|'ui'='ui',context:{signal?:AbortSignal}={}):Promise<any>{
    if(method==='action')context={...context,signal:context.signal?AbortSignal.any([context.signal,AbortSignal.timeout(15_000)]):AbortSignal.timeout(15_000)};
    if(source==='api'&&['control','startRun','seal','pauseOperations','pauseCapture','saveProfile','replyHuman','releaseHuman','review','authorizeValidationStart','revokeValidationStart','inspect','navigate','navigateHistory','closePage','closeSession','syntheticSite','replay','createProject','updateProject','createProfile','registerWorkflow','validationStartGrant'].includes(method))ensure(false,method==='validationStartGrant'?'Use a current task authorization; one-time startup grants are retired from the HTTP API':'This operation requires the trusted client UI',403);
    if(source==='api'&&method==='startValidation'&&body.startGrantId!==undefined)ensure(false,'One-time startGrantId is retired; request a current task authorization with execute capability in the trusted client',403);
    if(source==='api'&&method==='jobAccess'){
      ensure(typeof body.ownerAuthorizationId==='string'&&body.authorizationId===body.ownerAuthorizationId,'This job belongs to another task authorization',403);
      const grant=studio.tasks.get(body.ownerAuthorizationId);
      if(body.projectId!==undefined)ensure(body.projectId===grant.projectId,'This job belongs to another project',403);
      if(body.action==='cancel')return {projectId:grant.projectId,authorizationId:grant.authorizationId};
      ensure(body.action==='read','Unknown job access action',400);
      await studio.tasks.check(grant.authorizationId,body.jobStatus==='failed'?grant.capabilities[0]:body.capability,{projectId:grant.projectId});
      return {projectId:grant.projectId,authorizationId:grant.authorizationId};
    }
    if(source==='api'&&method==='taskAuthorizations'){
      const grant=studio.tasks.get(body.authorizationId);
      ensure(grant.projectId===body.projectId,'Task belongs to another project',403);
      await studio.tasks.check(grant.authorizationId,grant.capabilities[0],{projectId:grant.projectId});
      return {instanceId:studio.instanceId,items:[grant]};
    }
    if(['openReplay','seekReplay','playReplay','pauseReplay','replayStatus','selectReplay','closeReplay'].includes(method)){
      ensure(source==='ui','Native replay presentation is only available in the trusted client',403);
      if(method==='openReplay')return studio.replayHost.open(body);
      if(method==='seekReplay')return studio.replayHost.seek(body);
      if(method==='playReplay')return studio.replayHost.play(body);
      if(method==='pauseReplay')return studio.replayHost.pause(body.replayId,body.projectId);
      if(method==='replayStatus')return studio.replayHost.status(body.replayId);
      if(method==='selectReplay')return studio.replayHost.select(body.replayId,body.enabled);
      ensure(typeof body.replayId==='string'&&body.replayId.length>0,'A specific replay operation ID is required',400);return studio.replayHost.close(body.replayId);
    }
    if(PROJECT_METHODS.has(method)){const invoke=()=>dispatchProject(studio,method,body,source,context.signal);return ['createMaterialDraft','copyMaterialDraft','manageMaterialCatalog','setWorkingMaterialDraft'].includes(method)?studio.serialized(invoke):invoke();}
    if(['updateProfile','manageProject','manageProfile','managementDependencies','settleManagementDependencies','browserCommand'].includes(method))ensure(source==='ui','Management and browser controls require trusted UI',403);
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
    const runMethods=new Set(['checkpoint','control','pauseOperations','pauseCapture','seal','inspect','selectPage','requestHuman','cancelHandoff','startValidation','stopRunner','saveProfile']);
    if(source==='api'&&method==='startValidation'&&!studio.active){ensure(body.runId===undefined,'A stopped recording cannot be an execution target; use POST /v1/validations',409);const session=studio.state().session;ensure(session&&body.sessionId===session.sessionId&&body.profileId===session.profileId&&body.leaseEpoch===session.leaseEpoch&&session.controller==='agent','Session lease is stale or not agent-owned',409);}
    if(source==='api'&&runMethods.has(method)&&!(method==='startValidation'&&!studio.active)){
      const r=studio.required();ensure(body.leaseEpoch===r.leaseEpoch,'Stale control lease',409);if(body.runId)ensure(body.runId===r.id,'Run is not active',409);if(body.profileId)ensure(body.profileId===r.profileId,'Profile is not active',409);
      if(!['cancelHandoff','stopRunner'].includes(method))ensure(r.controller==='agent','Human owns this browser; use the client to grant agent control',409);
    }
    if(source==='api'&&['pages','snapshot','action','createPage'].includes(method)){
      const session=studio.state().session;ensure(session,'No live browser session',409);
      if(body.runId!==undefined)ensure(studio.active&&studio.active.id===body.runId,'Run is not active; use the current session route',409);
      else ensure(body.sessionId===session.sessionId,'Session identity is stale',409);
      if(['action','createPage'].includes(method)){ensure(body.leaseEpoch===session.leaseEpoch,'Stale control lease',409);ensure(session.controller==='agent','Human owns this browser',409);}
      if(method!=='pages'){ensure(typeof body.pageId==='string'&&Number.isSafeInteger(body.generation)&&body.generation>=0,'pageId and navigation generation are required',409);const page=session.pages.find(page=>page.pageId===body.pageId);ensure(page&&page.generation===body.generation,'Unknown page or stale navigation generation',409);}
    }
    if(source==='api'&&method==='checkpoint'){const r=studio.required();ensure(body.runId===r.id,'Run is not active',409);ensure(typeof body.pageId==='string'&&Number.isSafeInteger(body.generation)&&r.pages.get(body.pageId)?.navigationGeneration===body.generation,'Unknown page or stale navigation generation',409);}
    if(source==='api'&&['createProject','updateProject'].includes(method))ensure(!body.scriptDirectory,'Workflow directories are registered in the trusted client UI',403);
    if(source==='api'&&method==='startValidation')ensure(!['directory','scriptDirectory','entry','code','manifest'].some(key=>body[key]!==undefined),'Validation only runs the registered workflow; paths and code are not accepted',403);
    switch(method){
      case 'state':return studio.state();case 'projects':return {items:studio.projects};case 'project':{const p=studio.projects.find(p=>p.id===body.projectId);ensure(p,'Unknown project',404);return p;}
      case 'inspectRunRecovery':ensure(source==='ui','Archive recovery inspection is available in the trusted client only',403);return inspectRunRecovery(studio,body);
      case 'recoverRun':ensure(source==='ui','Archive recovery is available in the trusted client only',403);return recoverRun(studio,body);
      case 'recoverRunIndexes':ensure(source==='ui','Archive index recovery is available in the trusted client only',403);return recoverRunIndexes(studio,body);
      case 'openEnvironment':ensure(source==='ui','Environment preparation requires trusted UI',403);return studio.openEnvironment(body);
      case 'checkEnvironment':ensure(source==='ui','Environment checks require trusted UI',403);return studio.checkEnvironment();
      case 'profiles':return {items:studio.profiles.filter(p=>p.projectId===body.projectId)};
      case 'runs':{const runs=source==='api'?studio.runs.filter(run=>run.projectId===body.projectId):studio.runs;return {items:runs.slice(0,100).map(({id,projectId,profileId,status,createdAt})=>({id,projectId,profileId,status,createdAt})),outputTruncated:runs.length>100};}case 'run':{const run=studio.runs.find(r=>r.id===body.runId);ensure(run,'Unknown run',404);return {...run,active:source==='api'?null:studio.active?.id===body.runId?studio.state().active:null};}
      case 'browserCommand':return studio.browserCommand(body);
      case 'updateProfile':return studio.updateProfile(body);case 'manageProject':return studio.manageProject(body);case 'manageProfile':return studio.manageProfile(body);case 'managementDependencies':return studio.managementDependencies(body);case 'settleManagementDependencies':return studio.settleManagementDependencies(body);
      case 'createProject':return studio.createProject(body);case 'updateProject':return studio.updateProject(body);case 'createProfile':return studio.createProfile(body);case 'startRun':ensure(source==='ui','Browser session creation requires the trusted client',403);return studio.startRun(body);
      case 'workflowInputSchema':{
        ensure(source==='ui','Input forms require the trusted client',403);
        const project=studio.projects.find(p=>p.id===body.projectId);ensure(project,'Unknown project',404);
        if(!project.scriptDirectory)return {schema:null};
        const loaded=await loadWorkflow(project.scriptDirectory);if(!loaded.manifest.inputSchema)return {schema:null};
        const file=await resolveRegisteredFile(project.scriptDirectory,path.resolve(path.dirname(loaded.manifestPath),loaded.manifest.inputSchema));
        ensure((await stat(file)).size<=262144,'Input schema is too large for the form',413);
        return {schema:JSON.parse(await readFile(file,'utf8'))};
      }
      case 'workflows':{const p=studio.projects.find(p=>p.id===body.projectId);ensure(p,'Unknown project',404);return {items:p.scriptDirectory?[{directory:p.scriptDirectory,manifest:(await loadWorkflow(p.scriptDirectory)).manifest}]:[]};}
      case 'registerWorkflow':{const p=studio.projects.find(p=>p.id===body.projectId);ensure(p?.scriptDirectory,'Register directory in the client UI first',409);ensure(!body.directory||body.directory===p.scriptDirectory,'Directory does not match registration',403);return (await loadWorkflow(p.scriptDirectory)).manifest;}
      case 'pages':return {items:studio.state().session?.pages??[]};
      case 'snapshot':return studio.snapshot(body);
      case 'navigate':ensure(source==='ui','Direct navigation is available in the trusted client only; use actions with a page identity',403);return studio.navigate(body.url);case 'action':return studio.action(body,context.signal);
      case 'createPage':return studio.createTaskPage(body,context.signal);
      case 'selectPage':return studio.selectPage(body.pageId);
      case 'navigateHistory':ensure(source==='ui','Session navigation requires the trusted UI',403);ensure(['back','forward','reload'].includes(body.direction),'Unknown navigation direction');return studio.navigateHistory(body.direction);
      case 'closePage':ensure(source==='ui','Closing live pages requires the trusted UI',403);return studio.closePage(body.pageId);
      case 'closeSession':ensure(source==='ui','Closing the browser session requires the trusted UI',403);return studio.closeSession();
      case 'authoringOperation':ensure(source==='ui','Authoring status requires trusted UI',403);return studio.authoringOperation(body);
      case 'authoringRecovery':ensure(source==='ui','Authoring recovery requires trusted UI',403);return studio.authoringRecovery(body);
      case 'captureAndAuthor':ensure(source==='ui','Authoring requires trusted UI',403);return studio.captureAndAuthor(body);
      case 'workingMaterialDraft':ensure(source==='ui','Working draft requires trusted UI',403);return studio.materials.workingDraft(body.projectId);
      case 'checkpoint':return studio.checkpoint(body,{signal:context.signal});
      case 'cancelCheckpoint':ensure(source==='ui','Checkpoint API cancellation uses its job identity',403);return studio.cancelCheckpoint(body);
      case 'inspect':{const run=studio.required();ensure(run.controller==='human'&&!['running'].includes(run.execution),'Inspection requires human control',409);const selectionId=studio.current().capture!.selectionId;await studio.current().capture!.inspect(!!body.enabled,body.selectionId);run.selection=body.enabled?undefined:{cancelled:true,selectionId};return {enabled:!!body.enabled};}
      case 'pauseOperations':ensure(source==='ui','Capture controls require the trusted client',403);return studio.pauseOperations(!!body.paused);case 'pauseCapture':ensure(source==='ui','Capture controls require the trusted client',403);return studio.pauseCapture(!!body.paused);case 'seal':ensure(source==='ui','Recording controls require the trusted client',403);return studio.seal();case 'control':ensure(source==='ui','Browser ownership is granted by the trusted client',403);ensure(['human','agent'].includes(body.controller),'Invalid controller');return studio.control(body.controller);case 'saveProfile':ensure(source==='ui','Profile persistence requires the trusted client',403);return studio.saveProfile();
      case 'history':return studio.history(body.runId);case 'summary':return studio.reader(body.runId).summary(body);case 'events':return studio.reader(body.runId).events(body);case 'gaps':return studio.reader(body.runId).gaps(body);case 'checkpoints':return studio.reader(body.runId).checkpoints(body);case 'artifacts':return studio.reader(body.runId).artifacts(body);
      case 'artifact':{ensure(body.runId,'runId query required');const result=await studio.reader(body.runId).artifact(body.artifactId||body.id,body);return source==='ui'?{...result,url:`bes-artifact://${body.runId}/${body.artifactId||body.id}`}:result;}
      case 'artifactContent':{ensure(body.runId,'runId query required');const reader=studio.reader(body.runId),id=body.artifactId||body.id,metadata=await reader.artifactMetadata(id);
        const privacy=metadata.metadata?.capturePrivacy as {access?:unknown}|undefined;
        // Old screenshots have no marker, but their pixels were never redacted.
        ensure(source==='ui'||metadata.kind!=='screenshot'&&privacy?.access!=='restricted',
          'Unredacted screenshot pixels are available only in the trusted client UI',403);
        const result=await reader.artifactFile(id);
        ensure(result.artifact.capturedBytes<=16*1024*1024,'Use bounded artifact reads for content above16MiB',413);return {binary:await readFile(result.path),mediaType:result.artifact.mediaType};}
      case 'syntheticSite':return studio.syntheticSite();case 'replay':ensure(source==='ui','Replay is a trusted UI view',403);return studio.replay(body);
      case 'authorizeValidationStart':ensure(source==='ui','Validation startup authorization requires the trusted client UI',403);return studio.authorizeValidationStart(body);
      case 'revokeValidationStart':ensure(source==='ui','Validation startup revocation requires the trusted client UI',403);return studio.revokeValidationStart(body);
      case 'validationStartGrant':return studio.validationStartGrant(body);
      case 'validate':case 'startValidation':return studio.validate(body,{signal:context.signal});case 'validation':return studio.validation(source==='api'?body.validationId:body.id||body.validationId);case 'validations':return {items:studio.state().validations.filter(v=>!body.runId||v.runId===body.runId)};case 'review':ensure(source==='ui','Human reviews must be submitted in the trusted client',403);return studio.review(body);
      case 'reviews':return studio.reviews(source==='api'?body.validationId:body.id||body.validationId,body);
      case 'requestHuman':return studio.startHandoff(body);case 'replyHuman':case 'releaseHuman':ensure(source==='ui','Only the trusted client can return human control',403);return studio.releaseHuman(body.handoffId||body.id);case 'cancelHandoff':return studio.cancelHandoff(body.handoffId||body.id);case 'handoffs':{const active=studio.active;return {items:active&&active.id===body.runId&&active.handoff?[active.handoff]:[]};}
      case 'stopRunner':if(source==='ui'){const state=studio.state();if(body.sessionId)ensure(state.session?.sessionId===body.sessionId,'Stop session target is stale',409);if(body.validationId)ensure(state.validationStarting?.validationId===body.validationId||state.validations.some(record=>record.id===body.validationId&&record.runId===studio.active?.id),'Validation stop target is stale',409);else if(body.runId)ensure(studio.active?.id===body.runId,'Stop target is stale',409);}return studio.stopRunner();case 'cancelJob':ensure(['startValidation','requestHuman','action'].includes(body.operation),'This short atomic operation cannot be cancelled after commit',409);return studio.stopRunner();
      default:ensure(false,'Unknown operation: '+method,404);
    }};
    // Read-only state and handoff replies must remain responsive during long operations.
    const invoke=()=>method==='browserCommand'&&['stop','dialog','download-cancel'].includes(body.command)||READ.has(method)||['replyHuman','releaseHuman','stopRunner','cancelJob','cancelHandoff','cancelCheckpoint','inspectRunRecovery','revokeValidationStart'].includes(method)?execute():studio.serialized(execute,method==='action'?context.signal:undefined);
    if(source==='api'&&['state','projects','project','profiles','workflows','runs','handoffs'].includes(method)){
      const grant=studio.tasks.get(body.authorizationId);
      const capability=method==='workflows'?'execute':method==='runs'?'history-read':method==='handoffs'?'page-read':grant.capabilities[0];
      const projectId=body.projectId??(['handoffs','runs'].includes(method)?studio.runs.find(item=>item.id===body.runId)?.projectId:undefined)??grant.projectId;
      if(method==='runs')body.projectId=projectId;
      ensure(projectId===grant.projectId,'Discovery belongs to another project',403);
      if(method==='handoffs'){
        const active=studio.active;
        ensure(active&&active.id===body.runId&&active.profileId===grant.profileId&&grant.pages.some(page=>page.pageId===active.selectedPageId),'Handoff page is outside task authorization',403);
      }
      return studio.tasks.run(grant.authorizationId,capability,{projectId},async()=>{
        const result=await invoke();
        if(method==='projects')return {items:(result.items as typeof studio.projects).filter(item=>item.id===projectId)};
        if(method==='runs')return result;
        if(method==='state'){
          const state=result as ReturnType<Studio['state']>;
          const active=state.active;
          const visiblePages=active?.pages.filter(page=>grant.pages.some(allowed=>allowed.pageId===page.pageId&&allowed.targetId===page.targetId)&&originAllowed(grant,page.url))??[];
          const activeView=active&&active.projectId===projectId&&active.profileId===grant.profileId&&state.session?.sessionId===grant.sessionId&&grant.capabilities.some(item=>['page-read','page-act','page-create','execute'].includes(item))?
            {id:active.id,projectId:active.projectId,profileId:active.profileId,sessionId:state.session?.sessionId,controller:active.controller,leaseEpoch:active.leaseEpoch,capture:active.capture,execution:active.execution,locked:active.locked,pages:visiblePages,selectedPageId:visiblePages.some(page=>page.pageId===active.selectedPageId)?active.selectedPageId:null}:null;
          const session=state.session;
          const sessionPages=session?.pages.filter(page=>grant.pages.some(allowed=>allowed.pageId===page.pageId&&allowed.targetId===page.targetId)&&originAllowed(grant,page.url))??[];
          const sessionView=session&&session.projectId===projectId&&session.sessionId===grant.sessionId&&session.profileId===grant.profileId&&grant.capabilities.some(item=>['page-read','page-act','page-create','execute'].includes(item))?
            {sessionId:session.sessionId,projectId:session.projectId,profileId:session.profileId,recordingId:session.recordingId,controller:session.controller,leaseEpoch:session.leaseEpoch,locked:session.locked,pages:sessionPages,selectedPageId:sessionPages.some(page=>page.pageId===session.selectedPageId)?session.selectedPageId:null}:null;
          return {instanceId:state.instanceId,projects:state.projects.filter(item=>item.id===projectId),
            profiles:grant.capabilities.some(item=>['page-read','page-act','page-create','execute'].includes(item))?state.profiles.filter(item=>item.projectId===projectId):[],
            runs:grant.capabilities.includes('history-read')?state.runs.filter(item=>item.projectId===projectId):[],
            validations:grant.capabilities.includes('results-read')?state.validations.filter(item=>state.runs.some(run=>run.id===item.runId&&run.projectId===projectId)):[],active:activeView,session:sessionView};
        }
        return result;
      },context.signal);
    }
    if(source==='api'&&['snapshot','pages','action','createPage','checkpoint','startValidation','validate','selectPage','requestHuman','cancelHandoff','stopRunner','cancelJob'].includes(method)){
      const capability=['snapshot','pages'].includes(method)?'page-read':['startValidation','validate'].includes(method)?'execute':method==='createPage'?'page-create':'page-act';
      const scopedBody=capability==='page-read'?{
        ...body,
        projectId:body.projectId===undefined?studio.state().session?.projectId:body.projectId,
        profileId:body.profileId===undefined?studio.state().session?.profileId:body.profileId,
        sessionId:body.sessionId===undefined?studio.state().session?.sessionId:body.sessionId,
      }:body;
      body=scopedBody;
      return studio.authorizedOperation({...scopedBody,type:method==='action'?body.type:undefined},capability,async signal=>{context={...context,signal};signal.throwIfAborted();const result=await invoke();
        if(method==='pages'){const grant=studio.tasks.get(body.authorizationId);return {...result,items:result.items.filter((page:any)=>grant.pages.some(allowed=>allowed.pageId===page.pageId&&allowed.targetId===page.targetId)&&originAllowed(grant,page.url))};}
        return result;},context.signal);
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
