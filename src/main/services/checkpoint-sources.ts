import type { MaterialContent } from '@/contracts/materials';
import type { HistoricalElementRef, ReplayPosition } from '@/contracts/recording';
import type { SourceModel } from '@/replay/source-model';
import { matchesUrl } from '@/validator/proofs';
import { ensure } from '@/shared/errors';

/** Frozen field semantics select actual source nodes. Request data can select
 * fixed requirements but cannot declare observed values or evidence ownership. */
export function checkpointSourceProofs(content:MaterialContent,requirementIds:unknown){
  ensure(requirementIds===undefined||Array.isArray(requirementIds)&&requirementIds.length<=64&&requirementIds.every(id=>typeof id==='string'&&content.requirements.some(item=>item.id===id)),'Checkpoint must select existing fixed requirements',400);
  const requirements=requirementIds===undefined?content.requirements:content.requirements.filter(item=>(requirementIds as string[]).includes(item.id));
  const fieldIds=new Set(requirements.flatMap(item=>item.fieldIds));
  return content.fields.filter(item=>fieldIds.has(item.id)).flatMap(item=>item.sourceProof?.kind==='dom-text'?[item.sourceProof]:[]);
}
export function checkpointSourceTargets(content:MaterialContent,requirementIds:unknown,model:SourceModel,position:ReplayPosition):HistoricalElementRef[]{
  const proofs=checkpointSourceProofs(content,requirementIds);
  if(!proofs.length)return [];
  ensure(model.metadataComplete,'Source metadata is incomplete at the checkpoint',409);
  const targets:HistoricalElementRef[]=[];
  for(const node of model.nodes.values()){
    const metadata=node.metadata;if(node.type!==2||!metadata?.metadataComplete)continue;
    if(!proofs.some(proof=>{const attribute=metadata.attributes[proof.nodeAttribute.name];return attribute?.status==='present'&&attribute.value===proof.nodeAttribute.value&&matchesUrl(metadata.documentUrl.status==='present'?metadata.documentUrl.value:undefined,proof.sourceUrl,proof.pageParameter);}))continue;
    ensure(targets.length<64,'Checkpoint source exceeds 64 matching nodes; split the fixed requirement or page selection',413);
    targets.push({kind:'dom-node',position:structuredClone(position),frameId:metadata.frameId,mirrorScopeId:metadata.mirrorScopeId,nodeId:node.id});
  }
  ensure(targets.length>0,'No current source nodes match the fixed DOM field semantics',409);
  return targets;
}
