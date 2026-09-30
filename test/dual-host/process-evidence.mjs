import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
export function ownedProcessTree(rootPids){
 const raw=execFileSync('ps',['-eo','pid=,ppid=,comm=,args='],{encoding:'utf8'});
 const processes=raw.split('\n').map(line=>{const match=line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);return match?{pid:Number(match[1]),ppid:Number(match[2]),command:match[3],args:match[4]}:null}).filter(Boolean);
 const owned=new Set(rootPids),ancestors=new Map(processes.map(p=>[p.pid,p]));let changed=true;while(changed){changed=false;for(const p of processes)if(owned.has(p.ppid)&&!owned.has(p.pid)){owned.add(p.pid);changed=true}}
 return{capturedAt:new Date().toISOString(),roots:rootPids,processes:processes.filter(p=>owned.has(p.pid))};
}
export function assertNoElectronDependency(tree){assert(tree.processes.length>0,'Owned process tree present');assert(tree.processes.every(p=>!/\belectron(?:\s|$|\/)/i.test(p.command+' '+p.args)),'Owned Node launch must not spawn Electron');}
export function isAlive(pid){try{process.kill(pid,0);return true}catch(e){if(e.code==='ESRCH')return false;throw e}}
export function chromiumRootIn(tree,storage){const matching=tree.processes.filter(p=>p.args.includes('--user-data-dir='+storage)&&!p.args.includes('--type='));assert.equal(matching.length,1,'One dedicated provider browser process');return matching[0]}
