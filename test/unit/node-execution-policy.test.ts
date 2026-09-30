import { afterEach, expect, test, vi } from 'vitest';
import { ChromiumStudio } from '@/node/chromium-studio';
import { StudioCore } from '@/main/services/studio-core';
import { ChromiumPresentation, type ChromiumView } from '@/node/chromium-presentation';
import { nodeLaunchOptions } from '@/node/launch-options';
import { ownerState } from '@/node/owner-server';
afterEach(()=>vi.restoreAllMocks());

test('launcher requires explicit cooperative opt-in and rejects headless or ambiguous options before assembly',()=>{
  expect(()=>nodeLaunchOptions([], '/not-created')).toThrow('--dev-cooperative-input');
  expect(()=>nodeLaunchOptions(['--dev-cooperative-input','--headless'],'/not-created')).toThrow('headed');
  expect(()=>nodeLaunchOptions(['--dev-cooperative-input','--dev-cooperative-input'],'/not-created')).toThrow('Duplicate');
  expect(()=>nodeLaunchOptions(['--dev-cooperative-input','--data-root','relative'],'/not-created')).toThrow('absolute');
  expect(nodeLaunchOptions(['--dev-cooperative-input','--data-root','/explicit','--chromium','/installed/chromium'],'/default')).toEqual({root:'/explicit',executable:'/installed/chromium',headless:false,devCooperativeInput:true});
});

test('safe direct construction rejects execution before shared validation and cannot be enabled by a body or mutable options',async()=>{
  const options={executablePath:'/not-launched',headless:false,devCooperativeInput:false};
  const studio=new ChromiumStudio('/not-created',process.cwd(),options);
  const shared=vi.spyOn(StudioCore.prototype,'validate').mockResolvedValue({} as any);
  options.devCooperativeInput=true;
  await expect(studio.validate({devCooperativeInput:true,executionMode:'cooperative-dev-test'})).rejects.toThrow('launch-time');
  expect(shared).not.toHaveBeenCalled();expect(studio.active).toBeUndefined();expect(studio.runs).toEqual([]);
  expect(studio.executionPolicy.executionMode).toBe('disabled');expect(Object.isFrozen(studio.executionPolicy)).toBe(true);
});

test('opted launch exposes and persists the same explicitly nonexclusive policy while using shared validation',async()=>{
  const studio=new ChromiumStudio('/not-created',process.cwd(),{executablePath:'/not-launched',headless:false,devCooperativeInput:true});
  const shared=vi.spyOn(StudioCore.prototype,'validate').mockResolvedValue({accepted:true} as any);
  const body={executionMode:'current-page-test'};
  await expect(studio.validate(body)).resolves.toEqual({accepted:true});expect(shared).toHaveBeenCalledWith(body,{});
  const policy={executionMode:'cooperative-dev-test',inputIsolation:'none',physicalInputExclusive:false,interferenceDetection:'partial',humanHandoff:'unsupported'};
  expect(ownerState(studio).capabilities).toMatchObject(policy);
  expect((studio as any).providerEnvironment({browserInstanceId:'owned-browser',userAgent:'synthetic',version:'test'}).executionPolicy).toEqual(policy);
  expect(()=>new ChromiumStudio('/not-created',process.cwd(),{executablePath:'/not-launched',headless:true,devCooperativeInput:true})).toThrow('headed');
});

test('cooperative logical locks never toggle physical or CDP input suppression',async()=>{
  const send=vi.fn(async()=>{}),presentation=new ChromiumPresentation(true);
  const view={page:{isClosed:()=>false},cdp:{send},inputBlocked:false} as unknown as ChromiumView;
  presentation.add(view);presentation.lock(true);await presentation.awaitInput();presentation.assertInputReady(view);
  await presentation.withBackgroundInteraction(view,async()=>{expect(view.inputBlocked).toBe(false);});
  presentation.lock(false);presentation.lock(true);await presentation.awaitInput();
  expect(send).not.toHaveBeenCalled();expect(view.inputBlocked).toBe(false);
});

test('the actual protected runner handoff hook fails explicitly without entering a waiting state',async()=>{
  const studio=new ChromiumStudio('/not-created',process.cwd(),{executablePath:'/not-launched',headless:false,devCooperativeInput:true});
  await expect((studio as any).beginHuman({instructions:'test'},'runner','page')).rejects.toMatchObject({status:409,code:'unsupported_human_handoff'});
  expect(studio.active).toBeUndefined();expect((studio as any).humanDone).toBeUndefined();
});

test('backend-confirmed renderer failure blocks shared validation, recording and seal before side effects',async()=>{
  const studio=new ChromiumStudio('/not-created',process.cwd(),{executablePath:'/not-launched',headless:false,devCooperativeInput:true});
  Object.assign(studio,{provider:{browser:{connected:true},failedTargets:new Set(['real-owned-target'])}});
  const validation=vi.spyOn(StudioCore.prototype,'validate'),recording=vi.spyOn(StudioCore.prototype,'startRun'),seal=vi.spyOn(StudioCore.prototype,'seal');
  expect(studio.providerStatus).toBe('renderer-failed');
  await expect(studio.validate({})).rejects.toThrow('renderer crashed');
  await expect(studio.startRun({})).rejects.toThrow('renderer crashed');
  await expect(studio.seal()).rejects.toThrow('renderer crashed');
  expect(validation).not.toHaveBeenCalled();expect(recording).not.toHaveBeenCalled();expect(seal).not.toHaveBeenCalled();
  Object.assign(studio,{provider:{browser:{connected:false},failedTargets:new Set()}});
  await expect(studio.startRun({})).rejects.toThrow('disconnected');expect(recording).not.toHaveBeenCalled();
});

test('an unmatched navigation synchronously revokes gates and requests cancellation without awaiting navigation-dependent settlement',()=>{
  const studio=new ChromiumStudio('/not-created',process.cwd(),{executablePath:'/not-launched',headless:false,devCooperativeInput:true});
  const page={pageId:'owned-page'},closed=vi.fn(),cancel=vi.fn(()=>new Promise(()=>{}));
  const runtime={pages:new Map([['owned-page',page]]),controller:'agent',leaseEpoch:4,operation:{gate:{close:closed},browser:{disconnect:vi.fn()}},locked:false};
  Object.assign(studio,{browser:{runtime},workflow:{cancel},workflowStarting:{gate:{close:closed}}});
  vi.spyOn(studio,'stopRunner').mockImplementation(()=>new Promise(()=>{}));
  (studio as any).unownedNavigation(page);
  expect(runtime.leaseEpoch).toBe(5);expect(runtime.locked).toBe(true);expect(closed).toHaveBeenCalledTimes(2);expect(cancel).toHaveBeenCalledOnce();
});

test('forced normal session closure reports unconfirmed profile persistence after the session is removed',async()=>{
  const studio=new ChromiumStudio('/not-created',process.cwd(),{executablePath:'/not-launched',headless:false,devCooperativeInput:true});
  Object.assign(studio,{provider:{forcedTermination:true}});
  vi.spyOn(StudioCore.prototype,'closeSession').mockImplementation(async()=>{Object.assign(studio,{provider:undefined});return {closed:true,sessionId:'11111111-1111-4111-8111-111111111111' as const};});
  await expect(studio.closeSession()).resolves.toMatchObject({closed:true,profilePersistence:'unconfirmed',warning:expect.stringContaining('forced termination')});
});
test('an unconfirmed startup process cannot be overwritten by a second provider launch',async()=>{
  const studio=new ChromiumStudio('/not-created',process.cwd(),{executablePath:'/not-launched',headless:false,devCooperativeInput:true});
  const pending={browser:{},abort:new AbortController()};Object.assign(studio,{pendingOwned:pending});
  const id='11111111-1111-4111-8111-111111111111';
  await expect((studio as any).providerSession({id,provider:'chromium',storageRef:`chromium:${id}`})).rejects.toThrow('awaiting confirmed process cleanup');
  expect((studio as any).pendingOwned).toBe(pending);expect(studio.providerTerminated).toBe(false);
});
