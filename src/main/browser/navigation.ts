import type { WebContents } from 'electron';
import type { Page } from 'puppeteer-core';
import { setTimeout as delay } from 'node:timers/promises';
import { ensure } from '@/shared/errors';
import { captureError } from '@/capture/url-privacy';

const observation=()=>({url:location.href,timeOrigin:performance.timeOrigin,ready:document.readyState});
/** A navigation completes only when Electron and Puppeteer's observer have
 * consumed the same loaded document. A stale observer context is retried within
 * the deadline; any final failure retains its original cause. */
export async function navigateObserved(contents:WebContents,page:Page,url:string,assertCurrent:()=>void,timeoutMs=15000):Promise<{url:string}>{
  assertCurrent();const controller=new AbortController();let lastError:unknown;
  const timer=setTimeout(()=>controller.abort(new Error('Navigation document readiness timed out',{cause:lastError})),timeoutMs);
  const current=()=>{controller.signal.throwIfAborted();assertCurrent();ensure(!contents.isDestroyed()&&!page.isClosed(),'Navigation target closed',409);};
  const bounded=<T>(promise:Promise<T>)=>new Promise<T>((resolve,reject)=>{const abort=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',abort,{once:true});if(controller.signal.aborted)abort();promise.then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',abort));});
  const creating=page.createCDPSession();
  void creating.then(session=>{if(controller.signal.aborted&&!session.detached)void session.detach().catch(error=>console.error('Late navigation observer detach failed',captureError(error)));},()=>{});
  const session=await bounded(creating).catch(error=>{clearTimeout(timer);throw error;});let failed=false;
  try{
    current();
    // The watcher is installed before Electron starts navigation, so an already
    // completed load cannot leave Puppeteer's FrameManager in its old document.
    const observed=page.waitForNavigation({waitUntil:'load',timeout:timeoutMs,signal:controller.signal});
    await bounded(Promise.all([observed,contents.loadURL(url)]));current();
    const expected=(await bounded(session.send('Page.getFrameTree',undefined,{timeout:timeoutMs}))).frameTree.frame;current();
    while(true){
      current();
      try{
        const frame=page.mainFrame();
        const [observer,native]=await bounded(Promise.all([frame.evaluate(observation),contents.executeJavaScript(`(${observation.toString()})()`)]));current();
        const actual=(await bounded(session.send('Page.getFrameTree',undefined,{timeout:timeoutMs}))).frameTree.frame;current();
        ensure(actual.id===expected.id&&actual.loaderId===expected.loaderId&&actual.url===expected.url,'Navigation changed again before its readiness boundary',409);
        if(!contents.isLoadingMainFrame()&&frame===page.mainFrame()&&observer.ready==='complete'&&native.ready==='complete'&&observer.url===native.url&&observer.url===actual.url&&observer.timeOrigin===native.timeOrigin)return {url:actual.url};
      }catch(error){
        if(!/Execution context was destroyed|Execution context destroyed|Cannot find context with specified id/.test(String(error)))throw error;
        lastError=error;
      }
      await delay(25,undefined,{signal:controller.signal});
    }
  }catch(error){
    failed=true;
    if(controller.signal.aborted){try{assertCurrent();if(!contents.isDestroyed())contents.stop();}catch{/* A newer owner must not be stopped. */}throw controller.signal.reason;}
    throw error;
  }finally{clearTimeout(timer);controller.abort(new Error('Navigation observation finished'));if(!session.detached)try{await session.detach();}catch(error){if(!failed)throw error;console.error('Navigation observer detach also failed',captureError(error));}}
}
