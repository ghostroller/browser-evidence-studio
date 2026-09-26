import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { EvidenceError } from './contracts';
import { safeFile } from './files';

/** Check the original seal before a projection creates new receipts from current bytes. */
export async function verifySealedOriginals(runDir:string,kind:'replay'|'resource'):Promise<'sealed'|'unverified'> {
  let manifest:{id?:string;status?:string};
  try { const file=await safeFile(runDir,'manifest.json');if((await fs.stat(file)).size>65536)throw new Error('Manifest exceeds 64 KiB');manifest=JSON.parse(await fs.readFile(file,'utf8')); }
  catch(error){throw new EvidenceError('ORIGINAL_MANIFEST_READ_FAILED',`Cannot inspect run manifest: ${String(error)}`,409);}
  if(manifest.status!=='sealed')return 'unverified';
  let ledger:{schemaVersion?:number;runId?:string;files?:Array<{path:string;sha256:string;bytes:number}>};
  try { const file=await safeFile(runDir,'integrity.json');if((await fs.stat(file)).size>8*1024*1024)throw new Error('Ledger exceeds 8 MiB');ledger=JSON.parse(await fs.readFile(file,'utf8')); }
  catch(error){throw new EvidenceError('ORIGINAL_INTEGRITY_UNAVAILABLE',`Sealed integrity ledger is unavailable: ${String(error)}`,409);}
  if(ledger.schemaVersion!==1||ledger.runId!==manifest.id||!Array.isArray(ledger.files))throw new EvidenceError('ORIGINAL_INTEGRITY_UNAVAILABLE','Sealed integrity ledger is malformed or belongs to another run',409);
  const prefix=kind==='replay'?'raw/rrweb/':'journal/';
  const code=kind==='replay'?'REPLAY_ORIGINAL_INTEGRITY':'RESOURCE_ORIGINAL_INTEGRITY';
  const listed=new Map<string,{sha256:string;bytes:number}>();
  for(const entry of ledger.files){
    if(!entry||typeof entry.path!=='string'||!/^[a-f0-9]{64}$/.test(entry.sha256)||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||listed.has(entry.path))throw new EvidenceError('ORIGINAL_INTEGRITY_UNAVAILABLE','Sealed integrity ledger has invalid or duplicate entries',409);
    listed.set(entry.path,entry);
  }
  const directory=path.join(runDir,...prefix.slice(0,-1).split('/'));
  const names=await fs.readdir(directory).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;});
  const selected=names.filter(name=>kind==='replay'?/^rrweb-\d{6}\.jsonl$/.test(name):/^events-\d{6}\.jsonl$/.test(name)).map(name=>prefix+name);
  for(const relative of selected){
    const expected=listed.get(relative);
    if(!expected)throw new EvidenceError(code,`Original ${relative} is absent from the sealed ledger`,409);
    let bytes=0;const hash=createHash('sha256');
    try { for await(const chunk of createReadStream(await safeFile(runDir,relative))){bytes+=chunk.length;hash.update(chunk);} }
    catch(error){throw new EvidenceError(code,`Cannot verify sealed original ${relative}: ${String(error)}`,409);}
    if(bytes!==expected.bytes||hash.digest('hex')!==expected.sha256)throw new EvidenceError(code,`Sealed original ${relative} differs from its integrity ledger`,409);
  }
  for(const relative of listed.keys())if(relative.startsWith(prefix)&&!selected.includes(relative))throw new EvidenceError(code,`Sealed original ${relative} is missing`,409);
  return 'sealed';
}
