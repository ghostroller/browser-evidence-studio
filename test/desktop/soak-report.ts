import path from 'node:path';
import { atomicFile } from '@/evidence/files';

/** Publish both observer snapshots. Any failure must reach the soak runner. */
export async function saveSoakReport(root:string,report:unknown):Promise<void>{
  for(const file of ['soak-result.json','soak-progress.json']){
    const destination=path.join(root,file);
    await atomicFile(destination,Buffer.from(JSON.stringify(report,null,file==='soak-result.json'?2:undefined)));
  }
}
