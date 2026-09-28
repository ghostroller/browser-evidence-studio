import { spawn } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import electron from 'electron';
import { startProductSite } from '../test/fixtures/product-site';
import { implementExportedProductTask } from '../test/desktop/product-implementer';

const argument=(name:string)=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
const handoff=argument('handoff');
if(handoff){
  const directory=argument('output'),source=argument('source');
  if(!directory||!source)throw new Error('Use --handoff=<export directory> --output=<implementation directory> --source=<synthetic orders URL>');
  await implementExportedProductTask(handoff,directory,source);
  console.log(`Implementation written: ${path.resolve(directory)}\nRegister this directory in the UI; read and confirm the implementation proposal, then publish a new fixed version. No Studio task data was written.`);
}else{
  const resume=argument('resume'),port=argument('port');
  const root=resume?await realpath(path.resolve(resume)):path.resolve('output',`product-demo-${Date.now()}`);
  if(resume){
    const output=await realpath(path.resolve('output'));
    if(path.dirname(root).toLowerCase()!==output.toLowerCase()||!/^product-demo-\d+$/.test(path.basename(root))||!(await stat(root)).isDirectory())throw new Error('Resume accepts only an existing isolated output/product-demo-<timestamp> directory');
    if(!port||Number(port)<=0)throw new Error('Resume requires --port=<original synthetic port>; do not silently change the source origin');
  }else await mkdir(root,{recursive:true});
  const site=await startProductSite(port===undefined?0:Number(port));
  const env={...process.env,BES_DATA:root,BES_VISIBLE_EVIDENCE:process.argv.includes('--record-visible')?'1':'0'};delete env.ELECTRON_RUN_AS_NODE;delete env.BES_TEST;delete env.BES_TEST_PHASE;
  console.log(`${resume?'RESUMED':'EMPTY'} BES_DATA: ${root}\nSYNTHETIC LOGIN / ORDERS: ${site.url}/orders\n${resume?'Continue the preserved task through the visible app.':'Create a project and environment in the visible app.'} The site creates no Studio task data.\nKeep this process running throughout the demonstration. Close this app window normally to finalize any --record-visible evidence under this isolated data root.`);
  const child=spawn(electron as unknown as string,['.'],{env,windowsHide:false,stdio:'inherit'});
  child.once('exit',async code=>{await site.close();process.exitCode=code??1;});
  process.once('SIGINT',()=>child.kill());
}
