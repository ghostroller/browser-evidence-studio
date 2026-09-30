import { randomUUID } from 'node:crypto';
import { captureError } from '@/capture/url-privacy';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { WorkbenchSessions, type WorkbenchSessionContext } from '../main/workbench/session';
import { WorkbenchPairing } from '../main/workbench/pairing';
import { record, exactKeys, identifier, revision, textField, checkJsonBudget } from '../main/workbench/validation';
import { WorkbenchError } from '../main/workbench/errors';
import { StudioError, ensure } from '@/shared/errors';
import type { NodeOwnerMethod, NodeOwnerState } from '@/contracts/node-owner';
import type { ChromiumStudio } from './chromium-studio';
import { NODE_HOST_CAPABILITIES } from '@/contracts/host-capabilities';

const methods=new Set<NodeOwnerMethod>(['state','createProject','registerWorkflow','createProfile','openEnvironment','startRun','browserCommand','checkpoint','seal','closeSession','saveProfile','endInterruptedSession','startValidation','stopRunner','executionDatasets','assessExecution','pairWorkbench','revokeWorkbench','revokeOwner','shutdown']);
const common=['projectId','profileId','sessionId','leaseEpoch'],pageKeys=[...common,'pageId','targetId','generation'];
const messages:Record<string,string>={unauthorized:'Local owner session expired or was revoked. Enter a new console ticket.',forbidden:'Owner identity or origin is not authorized.',invalid_request:'Owner request fields are invalid.',conflict:'The browser identity or operation changed. Refresh and retry.',busy:'Another operation is in progress.',unavailable:'Node service is unavailable.',internal_error:'The operation failed; inspect local diagnostics.'};
export function ownerState(studio:ChromiumStudio):NodeOwnerState {
  const state=studio.state();
  return {instanceId:studio.instanceId,backendKind:'node',runtimeProvider:'chromium',providerStatus:studio.providerStatus,capabilities:{...NODE_HOST_CAPABILITIES,...studio.executionPolicy},
    projects:state.projects,profiles:state.profiles,session:state.session,active:state.active?{id:state.active.id,projectId:state.active.projectId,profileId:state.active.profileId,controller:state.active.controller,leaseEpoch:state.active.leaseEpoch,capture:state.active.capture,execution:state.active.execution,locked:state.active.locked,selectedPageId:state.active.selectedPageId,checkpoint:state.active.checkpoint}:null,
    runs:state.runs.map(({id,projectId,profileId,status,kind,capture,execution})=>({id,projectId,profileId,status,kind,capture,execution})),
    validations:state.validations.map(({id,runId,projectId,status,executionId,validation})=>({id,runId,projectId,status,executionId,validation})),validationStarting:state.validationStarting};
}
export class NodeOwnerServer {
  private server?:Server;private host='';private sockets=new Set<Socket>();private pending=0;private disposed=false;
  private readonly sessions:WorkbenchSessions;
  private context?:WorkbenchSessionContext;
  constructor(private readonly options:{studio:ChromiumStudio;origin:string;pairing:WorkbenchPairing;shutdown:()=>Promise<void>}){
    this.sessions=new WorkbenchSessions({instanceId:options.studio.instanceId,ticketTtlMs:60000,sessionTtlMs:900000,maxTickets:1,maxSessions:1});
  }
  async ticket(){await this.revoke();return this.sessions.begin('node-owner');}
  private async revoke(){this.context=undefined;this.sessions.revokeIssuer();this.options.pairing.revoke();await this.options.studio.cancelOwnerOperations();}
  async start(){
    const server=createServer({maxHeaderSize:8192,requestTimeout:15000,headersTimeout:5000},(request,response)=>{void this.handle(request,response);});this.server=server;server.maxConnections=24;server.keepAliveTimeout=1000;
    server.on('connection',socket=>{this.sockets.add(socket);socket.once('close',()=>this.sockets.delete(socket));});
    server.on('clientError',(_error,socket)=>socket.destroy());
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address();if(!address||typeof address==='string')throw new Error('Owner listener unavailable');this.host=`127.0.0.1:${address.port}`;return {port:address.port};
  }
  private send(response:ServerResponse,status:number,value:unknown){response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});response.end(JSON.stringify(value));}
  private async handle(request:IncomingMessage,response:ServerResponse){
    let counted=false,requestedMethod='unparsed';
    try{
      const names=request.rawHeaders.filter((_,i)=>i%2===0).map(name=>name.toLowerCase());
      if(this.disposed)throw new WorkbenchError('unavailable');
      if(request.headers.host!==this.host||['host','origin','authorization','content-type','x-workbench-instance','sec-fetch-site','sec-fetch-mode','sec-fetch-dest'].some(name=>names.filter(value=>value===name).length!==(['authorization'].includes(name)&&request.url==='/owner/session'?0:1)))throw new WorkbenchError('forbidden');
      if(request.method!=='POST'||!['/owner/session','/owner/rpc'].includes(request.url??''))throw new WorkbenchError('not_found');
      if(request.headers.origin!==this.options.origin||request.headers['sec-fetch-site']!=='same-origin'||!['same-origin','cors'].includes(String(request.headers['sec-fetch-mode']))||request.headers['sec-fetch-dest']!=='empty'||request.headers['x-workbench-instance']!==this.options.studio.instanceId)throw new WorkbenchError('forbidden');
      if(request.headers['content-type']!=='application/json'||request.headers['content-encoding']||request.headers.cookie)throw new WorkbenchError('invalid_request');
      if(this.pending>=8)throw new WorkbenchError('busy');this.pending++;counted=true;
      let bytes=0;const chunks:Buffer[]=[];
      for await(const data of request){bytes+=data.length;if(bytes>16384)throw new WorkbenchError('invalid_request');chunks.push(data);}
      let input:unknown;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new WorkbenchError('invalid_request');}checkJsonBudget(input);
      const envelope=record(input);
      if(request.url==='/owner/session'){
        exactKeys(envelope,['instanceId','ticket']);const result=this.sessions.exchange(envelope.ticket,identifier(envelope.instanceId));const context=this.sessions.authenticate(result.token,result.instanceId);this.context=context;
        this.sessions.onInvalidated(context,()=>{if(this.context===context){this.context=undefined;this.options.pairing.revoke();void this.options.studio.cancelOwnerOperations().catch(()=>{});}});
        this.send(response,200,{token:result.token,instanceId:result.instanceId,expiresAt:result.expiresAt});return;
      }
      exactKeys(envelope,['instanceId','method','body']);const authorization=request.headers.authorization;
      if(typeof authorization!=='string'||!/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization))throw new WorkbenchError('unauthorized');
      const context=this.sessions.authenticate(authorization.slice(7),identifier(envelope.instanceId));const assertOwner=()=>{this.sessions.assertActive(context);if(this.disposed)throw new WorkbenchError('unavailable');};
      const method=envelope.method;if(typeof method!=='string'||!methods.has(method as NodeOwnerMethod))throw new WorkbenchError('invalid_request');
      requestedMethod=method;const body=record(envelope.body);this.validate(method as NodeOwnerMethod,body);assertOwner();
      const result=await this.execute(method as NodeOwnerMethod,body,assertOwner);this.send(response,200,result);
    }catch(error){const code=error instanceof WorkbenchError?error.code:error instanceof StudioError?(error.status===409?'conflict':error.status===403?'forbidden':error.status===400||error.status===422?'invalid_request':'internal_error'):'internal_error';
      const status=error instanceof WorkbenchError?error.status:error instanceof StudioError?error.status:500;
      const diagnosticId=status>=500?randomUUID():undefined;
      if(diagnosticId){const diagnostic=captureError(error);diagnostic.message=diagnostic.message.replace(/wss?:\/\/[^\s'"<>]+/gi,'[private browser endpoint]');
        const stage=(error as {providerStage?:unknown})?.providerStage;
        console.error('Node owner operation failed',JSON.stringify({diagnosticId,method:requestedMethod,code,...diagnostic,...(typeof stage==='string'?{providerStage:stage.slice(0,80)}:{})}));}
      if(!response.headersSent&&!response.destroyed)this.send(response,status,{error:{code,message:messages[code]??code,...(diagnosticId?{diagnosticId}:{})}});
    }finally{if(counted)this.pending--;}
  }
  private validate(method:NodeOwnerMethod,b:Record<string,any>){
    const keys=(required:string[],optional:string[]=[])=>exactKeys(b,required,optional);
    const project=()=>identifier(b.projectId);
    switch(method){
      case 'state':case 'revokeWorkbench':case 'revokeOwner':case 'shutdown':keys([]);break;
      case 'createProject':keys(['name','objective','operationId'],['scriptDirectory']);textField(b.name,200,true);textField(b.objective,4000);identifier(b.operationId);if(b.scriptDirectory!==undefined)textField(b.scriptDirectory,4096,true);break;
      case 'registerWorkflow':keys(['projectId','expectedRevision','scriptDirectory','operationId']);project();revision(b.expectedRevision);textField(b.scriptDirectory,4096,true);identifier(b.operationId);break;
      case 'createProfile':keys(['projectId','name','entryUrl','operationId']);project();textField(b.name,120,true);textField(b.entryUrl,2048,true);identifier(b.operationId);break;
      case 'openEnvironment':keys(['projectId','profileId']);project();identifier(b.profileId);break;
      case 'startRun':keys(['projectId','profileId','expectedSessionId','url'],['leaseEpoch']);project();identifier(b.profileId);if(b.expectedSessionId!==null)identifier(b.expectedSessionId);if(b.leaseEpoch!==undefined)revision(b.leaseEpoch);textField(b.url,2048,true);break;
      case 'browserCommand':keys([...(b.command==='new'?common:pageKeys),'command'],['url']);this.identity(b,b.command!=='new');if(!['new','select','close','navigate','back','forward','reload','stop'].includes(b.command))throw new WorkbenchError('invalid_request');if(b.url!==undefined)textField(b.url,4096,true);break;
      case 'checkpoint':keys([...pageKeys,'key','title','description']);this.identity(b,true);textField(b.key,200,true);textField(b.title,1000);textField(b.description,4000);break;
      case 'seal':case 'closeSession':case 'saveProfile':case 'endInterruptedSession':keys(common);this.identity(b);break;
      case 'startValidation':keys([...pageKeys,'materialRevisionId','materialContentHash','executionMode','input'],['startUrl']);this.identity(b,true);identifier(b.materialRevisionId);if(!/^[a-f0-9]{64}$/.test(b.materialContentHash)||!['current-page-test','from-start-validation'].includes(b.executionMode))throw new WorkbenchError('invalid_request');if(b.startUrl!==undefined)textField(b.startUrl,2048,true);break;
      case 'stopRunner':keys(['sessionId']);identifier(b.sessionId);break;
      case 'executionDatasets':keys(['projectId','executionId']);project();identifier(b.executionId);break;
      case 'assessExecution':keys(['projectId','executionId','datasetIdentities']);project();identifier(b.executionId);if(!Array.isArray(b.datasetIdentities)||b.datasetIdentities.length>64)throw new WorkbenchError('invalid_request');for(const identity of b.datasetIdentities){const item=record(identity);exactKeys(item,['executionId','attemptId','datasetId']);identifier(item.executionId);identifier(item.attemptId);identifier(item.datasetId);if(item.executionId!==b.executionId)throw new WorkbenchError('forbidden');}break;
      case 'pairWorkbench':keys(['projectId']);project();break;
    }
  }
  private identity(b:Record<string,any>,page=false){for(const key of ['projectId','profileId','sessionId'])identifier(b[key]);revision(b.leaseEpoch);if(page){identifier(b.pageId);identifier(b.targetId);revision(b.generation);}}
  private assertIdentity(b:Record<string,any>,page=false){const state=this.options.studio.state(),s=state.session;ensure(s&&s.sessionId===b.sessionId&&s.projectId===b.projectId&&s.profileId===b.profileId&&s.leaseEpoch===b.leaseEpoch,'Owner browser identity changed',409);if(page){const current=s.pages.find(item=>item.pageId===b.pageId);ensure(current&&current.targetId===b.targetId&&current.generation===b.generation,'Owner target generation changed',409);}}
  private execute(method:NodeOwnerMethod,b:Record<string,any>,assertOwner:()=>void):Promise<unknown>{
    const studio=this.options.studio;
    if(method==='state')return Promise.resolve(ownerState(studio));
    if(method==='stopRunner'){ensure(studio.browserSessionId===b.sessionId,'Owner session changed',409);return studio.stopRunner();}
    if(method==='revokeOwner')return this.revoke().then(()=>({revoked:true}));
    if(method==='shutdown'){setTimeout(()=>{void this.options.shutdown().catch(error=>console.error('Node shutdown failed',String(error)));},25);return Promise.resolve({closing:true});}
    if(method==='startValidation'){this.assertIdentity(b,true);return studio.ownerOperation(()=>studio.validate({...b}));}
    // Recovery must be able to end the owned process that a queued capture is
    // waiting on. It has its own exact identity/auth and single-flight barrier.
    if(method==='endInterruptedSession'){this.assertIdentity(b);return studio.endInterruptedSession({projectId:b.projectId,profileId:b.profileId,sessionId:b.sessionId,leaseEpoch:b.leaseEpoch});}
    // Queue authorization and target checks at the actual domain start, so expiry/revocation cannot revive queued commands.
    return studio.serialized(()=>studio.ownerOperation(async()=>{assertOwner();
      switch(method){
        case 'createProject':return studio.createProject(b);
        case 'registerWorkflow':return studio.updateProject(b);
        case 'createProfile':return studio.createProfile(b);
        case 'openEnvironment':return studio.openEnvironment(b);
        case 'startRun':{const s=studio.state().session;ensure((s?.sessionId??null)===b.expectedSessionId&&(!s||s.projectId===b.projectId&&s.profileId===b.profileId&&s.leaseEpoch===b.leaseEpoch),'Recording session changed',409);return studio.startRun(b);}
        case 'browserCommand':this.assertIdentity(b,b.command!=='new');return studio.browserCommand(b as any);
        case 'checkpoint':this.assertIdentity(b,true);return studio.checkpoint(b);
        case 'seal':this.assertIdentity(b);return studio.seal();
        case 'closeSession':this.assertIdentity(b);return studio.closeSession();
        case 'saveProfile':this.assertIdentity(b);return studio.saveProfile();
        case 'executionDatasets':return studio.executions.items(b.projectId,b.executionId,'datasets',{limit:64,maxBytes:32768});
        case 'assessExecution':return studio.executions.assess(b.projectId,b.executionId,b.datasetIdentities);
        case 'pairWorkbench':return this.options.pairing.begin({projectId:b.projectId,grant:'project-replay'},assertOwner);
        case 'revokeWorkbench':this.options.pairing.revoke();return {revoked:true};
        default:throw new WorkbenchError('invalid_request');
      }
    }));
  }
  async dispose(){if(this.disposed)return;this.disposed=true;this.sessions.dispose();this.options.pairing.revoke();for(const socket of this.sockets)socket.destroy();if(this.server)await new Promise<void>(resolve=>this.server!.close(()=>resolve()));}
}
