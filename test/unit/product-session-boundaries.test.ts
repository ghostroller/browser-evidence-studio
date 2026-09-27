import { expect, it, vi } from 'vitest';
vi.mock('electron',()=>({app:{},session:{},BrowserWindow:class{},WebContentsView:class{}}));
import { Studio } from '@/main/services/studio';

function fixture(sealed=false){
  const parent={pageId:'parent',targetId:'parent-target',webContentsId:1,view:{webContents:{isDestroyed:()=>false}}};
  const popup={pageId:'popup',targetId:'popup-target',webContentsId:2,openerPageId:'parent',view:{webContents:{isDestroyed:()=>false}}};
  const store=sealed?{appendEvent:vi.fn(async()=>{throw new Error('sealed writer');})}:undefined;
  const runtime={projectId:'project',profileId:'profile',selectedPageId:'parent',pages:new Map([['parent',parent],['popup',popup]]),leaseEpoch:1,controller:'human',locked:false,execution:'ready',store};
  const studio=Object.create(Studio.prototype) as any;
  Object.assign(studio,{browser:{id:'session',runtime},active:undefined,window:{show:vi.fn(),lock:vi.fn(),remove:vi.fn()},onChanged:vi.fn(),state:()=>({session:{sessionId:'session'}}),revokeOperation:vi.fn(async()=>{})});
  return {studio,runtime,parent,popup,store};
}

it.each([false,true])('switches live pages without writing a recording (sealed=%s)',async sealed=>{
  const {studio,runtime,popup,store}=fixture(sealed);
  await studio.selectPage('popup');
  expect(runtime.selectedPageId).toBe('popup');expect(studio.window.show).toHaveBeenCalledWith(popup.view);
  expect(store?.appendEvent.mock.calls.length??0).toBe(0);
});

it.each([false,true])('closing a live popup restores the parent surface without a recording (sealed=%s)',sealed=>{
  const {studio,runtime,parent,popup,store}=fixture(sealed);runtime.selectedPageId='popup';
  studio.pageDestroyed(runtime,popup.view,popup,popup);
  expect(runtime.selectedPageId).toBe('parent');expect(studio.window.show).toHaveBeenCalledWith(parent.view);
  expect(store?.appendEvent.mock.calls.length??0).toBe(0);
});

it('revokes active browser operations and returns human ownership even when audit persistence fails',async()=>{
  const {studio,runtime}=fixture();runtime.controller='agent';
  const grant={authorizationId:'grant',projectId:'project',sessionId:'session',status:'active'};
  studio.tasks={get:()=>({...grant}),revoke:vi.fn(()=>{grant.status='revoked';})};studio.browserAuthorizationId='grant';
  studio.sessionAudit=vi.fn(async()=>{throw new Error('audit disk unavailable');});
  studio.control=vi.fn(async()=>{runtime.controller='human';});
  await expect(studio.revokeTask({projectId:'project',authorizationId:'grant'})).rejects.toThrow('audit disk unavailable');
  expect(grant.status).toBe('revoked');expect(studio.revokeOperation).toHaveBeenCalledWith(runtime);
  expect(studio.control).toHaveBeenCalledWith('human');expect(studio.browserAuthorizationId).toBeUndefined();
});
