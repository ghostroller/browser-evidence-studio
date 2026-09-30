import fs from 'node:fs/promises';import {spawn} from 'node:child_process';import {until} from './ui.mjs';
// Console-only bootstrap credentials stay in memory. Redacted streams are proof logs.
export async function launchWithRedactedConsole({command=process.execPath,args,cwd,env,logPath,ticketPattern}){
 const log=await fs.open(logPath,'w');const child=spawn(command,args,{cwd,env,stdio:['pipe','pipe','pipe']});const buffers={stdout:'',stderr:''};let ticket,closed;let writes=Promise.resolve();
 const emit=async(line)=>{const detected=ticketPattern?.exec(line);if(detected)ticket=detected[1];const safe=(ticket?line.split(ticket).join('[bootstrap-ticket-redacted]'):line).replace(/ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+/g,'[local-CDP-endpoint-redacted]').replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,'[ephemeral-value-redacted]');await log.write(safe+'\n')};
 for(const stream of ['stdout','stderr'])child[stream].on('data',chunk=>{buffers[stream]+=chunk.toString();const lines=buffers[stream].split(/\r?\n/);buffers[stream]=lines.pop();for(const line of lines)writes=writes.then(()=>emit(line))});
 const done=new Promise(resolve=>{child.once('error',error=>{closed={error:error.message};resolve(closed)});child.once('close',(code,signal)=>{closed={code,signal};for(const rest of Object.values(buffers))if(rest)writes=writes.then(()=>emit(rest));resolve(closed)})});
 return{child,done,readTicket:()=>until(async()=>{if(closed)throw Error('Launcher closed before bootstrap ticket');return ticket},Boolean,'owner bootstrap console ticket',60000),clearTicket:()=>{ticket=undefined},closeLog:async()=>{await writes;await log.close()}};
}
