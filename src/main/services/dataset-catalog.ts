import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import { executionId, type PersistentDatasetService } from '@/runner/datasets';
import type { DatasetSummary } from '@/runner/manager';
import { ensure } from '@/shared/errors';

async function directories(directory:string,optional=false):Promise<string[]>{
  try{const info=await lstat(directory);ensure(info.isDirectory()&&!info.isSymbolicLink(),'Dataset catalog requires real directories',409);}catch(error){if(optional&&(error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  const names:string[]=[];
  for await(const entry of await opendir(directory)){
    ensure(entry.isDirectory()&&!entry.isSymbolicLink(),'Dataset catalog has an unexpected entry; inspect preserved files',409);
    executionId(entry.name);names.push(entry.name);ensure(names.length<=128,'Dataset catalog exceeds 128 entries',413);
  }
  return names.sort();
}
/** Directory identities and C's small durable indexes only. Never scans batch
 * bodies or mutates originals to make a normal history query succeed. */
export async function datasetCatalog(directory:string,id:string,reader:PersistentDatasetService):Promise<DatasetSummary[]>{
  const root=path.join(directory,'datasets'),result:DatasetSummary[]=[];
  for(const attemptId of await directories(root,true))for(const datasetId of await directories(path.join(root,attemptId))){
    ensure(result.length<128,'Execution exceeds 128 dataset summaries',413);
    const value=await reader.summary({executionId:id,attemptId,datasetId});
    result.push({...value.identity,status:value.status,committedBatches:value.committedBatches,committedRecords:value.committedRecords});
  }
  return result;
}
