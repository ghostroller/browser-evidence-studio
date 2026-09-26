import { describe, expect, it, vi } from 'vitest';
import { makeDispatch } from '@/main/services/dispatch';
import { TaskAuthorizations } from '@/main/services/task-authorization';
import type { Studio } from '@/main/services/studio';

async function fixture(){
  const tasks=new TaskAuthorizations(),page={pageId:'page',targetId:'target',navigationGeneration:1};
  const run={id:'run',projectId:'project',profileId:'profile',leaseEpoch:1,controller:'agent',execution:'ready',selectedPageId:'page',pages:new Map([['page',page]])};
  const scope={projectId:'project',sessionId:'session',profileId:'profile',pageId:'page',targetId:'target',url:'https://fixture.test/'};
  const grant=await tasks.issue(scope,{origins:['https://fixture.test'],pages:[{pageId:'page',targetId:'target'}],capabilities:['page-read','page-act','history-read','results-read'],durationMs:60000,maxOperations:50});
  const calls={action:vi.fn(async()=>({done:true})),snapshot:vi.fn(async()=>({pageId:'page'})),summary:vi.fn(async()=>({events:4})),release:vi.fn()};
  const fake={tasks,active:run,runs:[run],projects:[{id:'project'}],required:()=>run,serialized:async(action:()=>Promise<unknown>)=>action(),state:()=>({active:run,validations:[]}),action:calls.action,snapshot:calls.snapshot,reader:()=>({summary:calls.summary}),releaseHuman:calls.release,
    authorizedOperation:async(body:any,capability:any,operation:any,signal?:AbortSignal)=>tasks.run(body.authorizationId,capability,{...scope,url:body.type==='navigate'?body.url:scope.url},operation,signal)};
  return {tasks,grant,run,calls,dispatch:makeDispatch(fake as unknown as Studio),body:{authorizationId:grant.authorizationId,runId:'run',projectId:'project',profileId:'profile',sessionId:'session',pageId:'page',generation:1,leaseEpoch:1}};
}
describe('new and legacy HTTP routes share task scope',()=>{
  it('cannot omit authorizationId on the old action/snapshot endpoints and rejects revoked grants',async()=>{
    const f=await fixture();try{
      const {authorizationId,...bare}=f.body;
      await expect(f.dispatch('action',{...bare,type:'click',selector:'#button'},'api')).rejects.toMatchObject({code:'AUTHORIZATION_REQUIRED'});
      await expect(f.dispatch('snapshot',bare,'api')).rejects.toMatchObject({code:'AUTHORIZATION_REQUIRED'});
      expect(f.calls.action).not.toHaveBeenCalled();expect(f.calls.snapshot).not.toHaveBeenCalled();
      await f.dispatch('snapshot',f.body,'api');expect(f.calls.snapshot).toHaveBeenCalledTimes(1);
      f.tasks.revoke(authorizationId);await expect(f.dispatch('action',{...f.body,type:'click',selector:'#button'},'api')).rejects.toMatchObject({code:'AUTHORIZATION_REVOKED'});
    }finally{f.tasks.close();}
  });
  it('allows authorized background reads under human ownership while refusing writes and forged handoff/review',async()=>{
    const f=await fixture();try{f.run.controller='human';await f.dispatch('snapshot',f.body,'api');expect(f.calls.snapshot).toHaveBeenCalledTimes(1);
      await expect(f.dispatch('action',{...f.body,type:'click',selector:'#button'},'api')).rejects.toMatchObject({status:409});
      for(const method of ['control','releaseHuman','replyHuman','review','authorizeTask','revokeTask'])await expect(f.dispatch(method,{...f.body,controller:'agent'},'api')).rejects.toMatchObject({status:403});
      expect(f.calls.action).not.toHaveBeenCalled();expect(f.calls.release).not.toHaveBeenCalled();
    }finally{f.tasks.close();}
  });
  it('checks project authorization on old evidence reads and destination origin before action',async()=>{
    const f=await fixture();try{
      await expect(f.dispatch('summary',{runId:'run'},'api')).rejects.toMatchObject({code:'AUTHORIZATION_REQUIRED'});
      await f.dispatch('summary',{runId:'run',authorizationId:f.grant.authorizationId},'api');expect(f.calls.summary).toHaveBeenCalledTimes(1);
      await expect(f.dispatch('summary',{runId:'run',projectId:'other',authorizationId:f.grant.authorizationId},'api')).rejects.toMatchObject({status:403});
      await expect(f.dispatch('action',{...f.body,type:'navigate',url:'https://outside.test/'},'api')).rejects.toMatchObject({code:'AUTHORIZATION_ORIGIN'});
      expect(f.calls.action).not.toHaveBeenCalled();
    }finally{f.tasks.close();}
  });
  it('does not expose discovery and state outside the active task scope',async()=>{
    const f=await fixture();try{
      await expect(f.dispatch('project',{projectId:'project'},'api')).rejects.toMatchObject({code:'AUTHORIZATION_REQUIRED'});
      await expect(f.dispatch('profiles',{projectId:'project'},'api')).rejects.toMatchObject({code:'AUTHORIZATION_REQUIRED'});
      await expect(f.dispatch('state',{},'api')).rejects.toMatchObject({code:'AUTHORIZATION_REQUIRED'});
      f.tasks.revoke(f.grant.authorizationId);
      await expect(f.dispatch('projects',{authorizationId:f.grant.authorizationId},'api')).rejects.toMatchObject({code:'AUTHORIZATION_REVOKED'});
    }finally{f.tasks.close();}
  });
});
