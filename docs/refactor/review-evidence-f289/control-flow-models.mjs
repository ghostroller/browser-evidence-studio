/**
 * Review control-flow models, NOT project/React/Electron integration tests.
 * Baseline: f2894456e2a9364044067ddbdbd813300e5a8dde.
 * Models isolate the data dependencies in MaterialWorkbench. No repository,
 * user profiles, recordings, or network are read or modified.
 */
import assert from 'node:assert/strict';

const report = {
  baseline: 'f2894456e2a9364044067ddbdbd813300e5a8dde',
  runtime: process.version,
  classification: 'isolated control-flow models; not production test results',
  cases: [],
};

// publish() awaits saveField(), then saveRequirement(), both closures from
// the click's render. Updating draftRef does not refresh selectedRequirement.
{
  const selectedRequirement = {id:'r', description:'old', dataset:'orders', fieldIds:[], rules:[]};
  const store = {revision:0, requirements:[structuredClone(selectedRequirement)], fields:[]};
  const draftRef = {current:{draftRevision:0}};
  const requirementDescription = 'new description';
  async function mutate(edits) {
    assert.equal(draftRef.current.draftRevision, store.revision);
    for (const {collection,item} of edits) {
      const list=store[collection], index=list.findIndex(x=>x.id===item.id);
      if(index<0) list.push(structuredClone(item)); else list[index]=structuredClone(item);
    }
    draftRef.current={draftRevision:++store.revision};
  }
  async function saveField() {
    const id='new-field';
    await mutate([
      {collection:'fields',item:{id,dataset:'orders',name:'amount'}},
      {collection:'requirements',item:{...selectedRequirement,fieldIds:[...selectedRequirement.fieldIds,id]}},
    ]);
  }
  async function saveRequirement() {
    await mutate([{collection:'requirements',item:{id:selectedRequirement.id,
      description:requirementDescription,dataset:selectedRequirement.dataset,
      fieldIds:selectedRequirement.fieldIds??[],rules:[]}}]);
  }
  await saveField();
  const afterField=[...store.requirements[0].fieldIds];
  await saveRequirement();
  assert.deepEqual(afterField,['new-field']);
  assert.equal(store.fields.length,1);
  assert.deepEqual(store.requirements[0].fieldIds,[]);
  report.cases.push({name:'publish_stale_render_relation',defectModeled:true,
    afterFieldSave:afterField,afterRequirementSave:store.requirements[0].fieldIds,
    fieldStillExists:true,explanation:'Fresh draftRevision can accept stale relationship content.'});
}

// A retry ref is set before acquisition. A definitive stale-selection rejection
// leaves it set. A fresh selection is ignored by `retry ?? freshRequest`.
{
  let retry=null;
  let currentSelection='expired';
  async function api(request) {
    if(request.selectionId!==currentSelection)throw new Error('STALE_SELECTION');
    return {status:'saved',target:'node-new'};
  }
  async function attempt(selectionId) {
    const request=retry??{operationId:'op-'+selectionId,selection:true,selectionId};
    retry=request;
    try {const result=await api(request);retry=null;return result;}
    catch(error){return {error:error.message,submitted:request.selectionId};}
  }
  currentSelection='current-1';
  const first=await attempt('old-1');
  currentSelection='current-2';
  const second=await attempt('current-2');
  assert.equal(first.error,'STALE_SELECTION');
  assert.equal(second.error,'STALE_SELECTION');
  assert.equal(second.submitted,'old-1');
  report.cases.push({name:'capture_retry_retains_rejected_selection',defectModeled:true,first,second});
}

// The retry button calls recordCurrent() with default selection=false even when
// the saved request was a field-selection request. The target isn't installed.
{
  const savedRequest={selection:true,selectionId:'s',operationId:'op'};
  const response={status:'saved',target:'node-7',card:{id:'card-7'}};
  let fieldTarget=null;
  async function recordCurrent(selection=false) {
    const request=savedRequest;
    assert.equal(request.selection,true);
    if(selection) fieldTarget=response.target;
  }
  await recordCurrent();
  assert.equal(fieldTarget,null);
  report.cases.push({name:'retry_button_loses_binding_intent',defectModeled:true,
    responseTarget:response.target,appliedFieldTarget:fieldTarget});
}

// An old workingMaterialDraft response calls old openDraft(), which mutates
// shared request/ref state BEFORE its response-scope check.
{
  let scope='A', token=0, draftRef=null, renderedDraft=null;
  const waiters=new Map();
  const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
  const readA=deferred(),readB=deferred();
  waiters.set('A',readA);waiters.set('B',readB);
  async function openDraft(capturedProject,id) {
    const ownToken=++token;
    draftRef=null;renderedDraft=null;
    const value=await waiters.get(capturedProject).promise;
    if(ownToken!==token||scope!==capturedProject)return;
    draftRef=value;renderedDraft=value;
  }
  scope='B';
  const b=openDraft('B','draft-B');
  // A's earlier working-draft lookup arrives after B began opening.
  const a=openDraft('A','draft-A');
  readB.resolve({draftId:'draft-B'});readA.resolve({draftId:'draft-A'});
  await Promise.all([a,b]);
  assert.equal(scope,'B');assert.equal(draftRef,null);assert.equal(renderedDraft,null);
  report.cases.push({name:'late_project_bootstrap_invalidates_current_load',defectModeled:true,
    currentProject:scope,visibleDraft:renderedDraft});
}
console.log(JSON.stringify(report,null,2));
