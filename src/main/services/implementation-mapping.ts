import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { safeFile } from '@/evidence/files';
import { materialContentHash } from '@/materials';
import { parseFieldSourceProof, parseJsonPointer } from '@/contracts/workflow';
import { ensure } from '@/shared/errors';
import type { Studio } from './studio';

/** Technical proposals can add verification, never replace the user's semantics. */
export async function implementationMapping(studio:Studio,body:any,confirm=false){
  const project=studio.projects.find(item=>item.id===body.projectId);
  ensure(project?.scriptDirectory,'先在执行页登记实现目录。',409);
  const draft=await studio.materials.service.getDraft(body.projectId,body.draftId);
  const file=await safeFile(project.scriptDirectory,'implementation.json');
  ensure((await stat(file)).size<=128*1024,'Implementation proposal exceeds its read budget',413);
  const bytes=await readFile(file,'utf8'),proposal=JSON.parse(bytes);
  const proposalHash=createHash('sha256').update(bytes).digest('hex');
  ensure(proposal.materialContentHash===materialContentHash(draft.content),'实现映射针对另一份资料；请从当前固定版本重新生成。',409);
  ensure(Array.isArray(proposal.fields)&&proposal.fields.length<=2000,'Invalid field mapping');
  const ids=new Set<string>();
  const fields=proposal.fields.map((mapping:any)=>{
    ensure(mapping&&Object.keys(mapping).every(key=>['fieldId','outputPath','sourceProof'].includes(key)),'映射只能设置输出路径与来源检查，不能改任务含义。',422);
    const field=draft.content.fields.find(item=>item.id===mapping.fieldId);
    ensure(field&&!ids.has(field.id),'Mapping must reference each existing field at most once',422);ids.add(field.id);
    return {...field,outputPath:parseJsonPointer(mapping.outputPath),...(mapping.sourceProof?{sourceProof:parseFieldSourceProof(mapping.sourceProof)}:{})};
  });
  const summary={proposalHash,draftRevision:draft.draftRevision,fields:fields.map((field:any)=>({name:field.name,description:field.description,dataset:field.dataset,sourcePolicy:field.sourcePolicy,outputPath:field.outputPath,verification:field.sourceProof?`${field.sourceProof.kind} · ${field.sourceProof.sourceUrl} · 实体 ${field.sourceProof.outputEntityPath}`:'未提供独立检查；结果将保持未核验'}))};
  if(!confirm)return summary;
  ensure(body.proposalHash===proposalHash&&body.expectedDraftRevision===draft.draftRevision,'映射或草稿已变化，请重新阅读确认。',409);
  return studio.materials.edit(body.projectId,body.draftId,draft.draftRevision,fields.map((item:any)=>({operation:'upsert',collection:'fields',item})),'ui');
}
