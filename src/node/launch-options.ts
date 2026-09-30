import path from 'node:path';
import { ensure } from '@/shared/errors';

/** Pure parsing must complete before resolving executables, leasing roots, or starting listeners. */
export function nodeLaunchOptions(args:string[],defaultRoot:string){
  let root=defaultRoot,executable:string|undefined,headless=false,devCooperativeInput=false;
  const seen=new Set<string>();
  for(let i=0;i<args.length;i++){
    const option=args[i];ensure(!seen.has(option),`Duplicate launcher option: ${option}`);seen.add(option);
    if(option==='--data-root'){root=args[++i];ensure(typeof root==='string'&&path.isAbsolute(root),'--data-root requires an absolute path');}
    else if(option==='--chromium'){executable=args[++i];ensure(typeof executable==='string'&&path.isAbsolute(executable),'--chromium requires an absolute executable path');}
    else if(option==='--headless')headless=true;
    else if(option==='--dev-cooperative-input')devCooperativeInput=true;
    else throw new Error('Use start:node --dev-cooperative-input [--data-root /absolute/directory] [--chromium /installed/executable]');
  }
  ensure(devCooperativeInput,'Node Chromium is a cooperative DEV/TEST tool. Explicitly pass --dev-cooperative-input: physical input is not blocked, interference detection is partial, and results do not prove noninterference.');
  ensure(!headless,'--dev-cooperative-input supports headed Chromium only; --headless is not supported by this DEV/TEST launch mode.');
  return {root,executable,headless,devCooperativeInput};
}
