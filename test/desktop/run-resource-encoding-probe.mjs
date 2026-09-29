import { build } from 'vite';
import { builtinModules } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import electron from 'electron';

const root=path.resolve('output/resource-encoding-electron-'+Date.now());await mkdir(root,{recursive:true});
await build({configFile:false,resolve:{tsconfigPaths:true},build:{target:'node24',outDir:'.vite/resource-encoding-probe',emptyOutDir:false,minify:false,lib:{entry:'test/desktop/resource-encoding-probe.ts',formats:['es'],fileName:()=> 'probe.js'},rolldownOptions:{external:['electron','puppeteer-core','ws',...builtinModules,...builtinModules.map(value=>'node:'+value)]}}});
const env={...process.env,BES_TEST:'1',BES_RESOURCE_PROBE_ROOT:root};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(electron,[path.resolve('.vite/resource-encoding-probe/probe.js')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='';child.stdout.on('data',data=>{log+=data;});child.stderr.on('data',data=>{log+=data;});
const timeout=setTimeout(()=>child.kill(),90000);
const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});clearTimeout(timeout);
await writeFile(path.join(root,'probe.log'),log);console.log('Synthetic result: '+root);
let passed=false;
try{const result=await readFile(path.join(root,'result.json'),'utf8');console.log(result);passed=JSON.parse(result).passed===true;}catch{console.error(log.slice(-5000));}
process.exitCode=typeof code==='number'&&code===0&&passed?0:1;
