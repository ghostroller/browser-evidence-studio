import { describe, expect, it } from 'vitest';
import { checkpointSourceTargets } from '@/main/services/checkpoint-sources';
import type { MaterialContent } from '@/contracts/materials';
import type { SourceModel } from '@/replay/source-model';

const position={recordingId:'recording',pageId:'page',documentId:'document',streamEpoch:'epoch',sourceTimeMs:1,eventSeq:1};
const content:MaterialContent={recordingRefs:[],checkpoints:[],annotations:[],requirements:[{id:'orders',description:'order amounts',fieldIds:['amount'],rules:[]}],fields:[{id:'amount',dataset:'orders',name:'amount',description:'amount',sourcePolicy:'page-displayed',sourceProof:{kind:'dom-text',sourceUrl:'https://fixture.test/orders',nodeAttribute:{name:'data-field',value:'amount'},entityAttribute:'data-entity',outputEntityPath:'/id'},outputPath:'/amount'}]};
function model(count=2):SourceModel{return {metadataComplete:true,nodes:new Map(Array.from({length:count},(_,index)=>[index+1,{id:index+1,type:2,metadata:{metadataComplete:true,frameId:'top',mirrorScopeId:'mirror',attributes:{'data-field':{status:'present',value:'amount'}},documentUrl:{status:'present',value:'https://fixture.test/orders'}}}]))} as unknown as SourceModel;}
describe('frozen checkpoint source selection',()=>{
  it('includes every matching source identity and never accepts caller observations',()=>{const result=checkpointSourceTargets(content,['orders'],model(),position);expect(result.map(item=>item.nodeId)).toEqual([1,2]);expect(result.every(item=>item.frameId==='top'&&item.mirrorScopeId==='mirror')).toBe(true);result[0].position.eventSeq=99;expect(position.eventSeq).toBe(1);expect(()=>checkpointSourceTargets(content,['fabricated'],model(),position)).toThrow('existing fixed requirements');});
  it('rejects incomplete source structure and explicit over-budget populations',()=>{const incomplete=model();incomplete.metadataComplete=false;expect(()=>checkpointSourceTargets(content,['orders'],incomplete,position)).toThrow('incomplete');expect(()=>checkpointSourceTargets(content,['orders'],model(65),position)).toThrow('64 matching nodes');expect(checkpointSourceTargets(content,['orders'],model(64),position)).toHaveLength(64);});
  it('does not substitute a similarly named node from a different source URL',()=>{const wrong=model(1);wrong.nodes.get(1)!.metadata!.documentUrl={status:'present',value:'https://outside.test/orders'};expect(()=>checkpointSourceTargets(content,['orders'],wrong,position)).toThrow('No current source nodes');});
});
