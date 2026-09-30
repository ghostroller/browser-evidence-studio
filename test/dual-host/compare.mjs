import assert from 'node:assert/strict';
import {stable} from './source-manifest.mjs';

/** Normalize only independently verified generated identities and capture
 * coordinates. All other properties, including unknown future properties, stay. */
export function semanticProjection(report){
  const content=report.fixed.content,field=content.fields[0],checkpoint=content.checkpoints[0],requirement=content.requirements[0];
  assert.equal(content.fields.length,1);assert.equal(content.checkpoints.length,1);assert.equal(content.requirements.length,1);
  assert.deepEqual(field.target.position,report.source.thirteen);assert.deepEqual(checkpoint.anchor,report.source.thirteen);
  assert.equal(field.target.nodeId,report.source.nodeId);assert.equal(field.target.frameId,report.source.frameId);assert.equal(field.target.mirrorScopeId,report.source.mirrorScopeId);
  assert.equal(field.checkpointId,checkpoint.id);assert.deepEqual(checkpoint.requirementIds,[requirement.id]);assert.deepEqual(requirement.fieldIds,[field.id]);assert.deepEqual(content.recordingRefs,[report.source.recordingId]);
  const normalized=structuredClone(content);
  const normalizedField=normalized.fields[0],normalizedCheckpoint=normalized.checkpoints[0],normalizedRequirement=normalized.requirements[0];
  normalizedField.id='$field';normalizedField.checkpointId='$checkpoint';
  normalizedField.target={...normalizedField.target,position:{$verifiedArchivedPosition:'amount=13.00'},nodeId:'$verifiedAmountNode',mirrorScopeId:'$historical-mirror'};
  normalizedCheckpoint.id='$checkpoint';normalizedCheckpoint.anchor={$verifiedArchivedPosition:'amount=13.00'};normalizedCheckpoint.requirementIds=['$requirement'];
  for(const key of ['createdAt','capturedAt']){assert(Number.isFinite(Date.parse(normalizedCheckpoint[key])));normalizedCheckpoint[key]='$timestamp'}
  normalizedRequirement.id='$requirement';normalizedRequirement.fieldIds=['$field'];normalized.recordingRefs=['$historical-recording'];
  const results=report.threeState.map(result=>{
    assert.equal(result.sourceCheck.name,'source:'+field.id);assert.equal(result.overall,result.expected);assert.equal(result.sourceCheck.verdict,result.expected);assert.equal(result.binding.materialRevisionId,report.fixed.revisionId);assert.equal(result.binding.materialContentHash,report.fixed.contentHash);
    assert.equal(result.input.requirementId,requirement.id);assert.equal(result.selectedIdentity.executionId,result.executionId);assert.equal(result.selectedIdentity.datasetId,'orders');
    for(const sample of result.sourceSamples){assert.equal(sample.scope.executionId,result.executionId);assert.equal(sample.scope.attemptId,result.selectedIdentity.attemptId);}
    const diagnostics=result.fieldDiagnostics.map(diagnostic=>{
      assert.equal(diagnostic.fieldId,field.id);assert.deepEqual(diagnostic.identity,result.selectedIdentity);
      const out=structuredClone(diagnostic);out.fieldId='$field';out.identity={executionId:'$execution',attemptId:'$dataset-attempt',datasetId:'orders'};
      if(out.sourceRef){const sample=result.sourceSamples.find(s=>s.sourceRef===out.sourceRef);assert(sample);assert.deepEqual(out.target,sample.target);assert.notEqual(sample.target.position.recordingId,report.source.recordingId);assert.equal(sample.target.kind,'dom-node');assert.equal(sample.target.frameId,report.source.frameId);assert(sample.target.mirrorScopeId);out.sourceRef='$runtime-source';out.target={...out.target,position:{$verifiedRuntimePosition:'amount=14.00'},nodeId:'$verifiedRuntimeAmountNode',mirrorScopeId:'$runtime-mirror'};}
      return out;
    });
    return{variant:result.variant,input:{...result.input,requirementId:'$requirement'},overall:result.overall,sourceCheck:{...result.sourceCheck,name:'source:$field'},fieldDiagnostics:diagnostics,records:result.records,sourceCount:result.sourceRefs.length,hostStatus:result.hostStatus};
  });
  return{content:normalized,workflowSha256:report.workflow.sha256,replay:{amount:report.replay.amount,ordinaryText:report.replay.ordinaryText,imageWidth:report.replay.imageWidth,bannerColor:report.replay.bannerColor,sandbox:report.replay.sandbox},results};
}

export function compareHosts(electron,node){
  assert.equal(electron.source.frameId,node.source.frameId);assert.equal(electron.fixture.url,node.fixture.url);assert.equal(electron.fixture.label,node.fixture.label);assert.notEqual(electron.source.recordingId,node.source.recordingId);assert.notEqual(electron.fixed.revisionId,node.fixed.revisionId);assert.notEqual(electron.documentToken,node.documentToken);
  const projections={electron:semanticProjection(electron),node:semanticProjection(node)};
  assert.deepEqual(projections.node,projections.electron,'Same logical input preserves full selected material and actual verdict semantics');
  return{passed:true,projections,resourceCoverage:{electron:{backgroundStatus:electron.replay.backgroundStatus,backgroundReason:electron.replay.backgroundReason},node:{backgroundStatus:node.replay.backgroundStatus,backgroundReason:node.replay.backgroundReason}},coverageNote:'Electron recording begins after loaded page; Node recording begins before navigation. Same post-load archived amount semantics are compared; initial network coverage and conservative CSS dependency diagnostics remain separately reported.'};
}
