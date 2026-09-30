import type { Browser } from 'puppeteer-core';
import { ensure } from '@/shared/errors';

export const CHROMIUM_PROTOCOL_TIMEOUT_MS=15_000;
const GRACEFUL_CLOSE_MS=5_000;
const CONFIRMED_EXIT_MS=10_000;
/** Exact process returned by our launch only. Never infer exit from CDP loss. */
export async function closeOwnedChromium(browser:Pick<Browser,'process'|'close'>,launchAbort:AbortController){
  const child=browser.process();ensure(child,'Owned Chromium process handle is unavailable',409);
  const exited=()=>child.exitCode!==null||child.signalCode!==null;
  let forced=false,closeError:unknown;
  if(exited()){void browser.close().catch(()=>{});return {forced};}
  let graceful:ReturnType<typeof setTimeout>|undefined,deadline:ReturnType<typeof setTimeout>|undefined;
  let onExit!:()=>void;
  const joined=new Promise<void>((resolve,reject)=>{
    onExit=()=>resolve();child.once('exit',onExit);
    graceful=setTimeout(()=>{if(!exited()){forced=true;try{launchAbort.abort(new Error('Owned Chromium did not close within its graceful deadline'));}catch(error){closeError=error;}}},GRACEFUL_CLOSE_MS);
    deadline=setTimeout(()=>{if(exited())resolve();else reject(new Error('Owned Chromium process did not confirm termination within 10 seconds',{cause:closeError}));},CONFIRMED_EXIT_MS);
  });
  // Closing CDP may settle after exit; the actual process event is authoritative.
  void browser.close().catch(error=>{closeError=error;});
  try{await joined;ensure(exited(),'Owned Chromium process did not confirm termination',409);return {forced};}
  finally{clearTimeout(graceful);clearTimeout(deadline);child.off('exit',onExit);}
}
