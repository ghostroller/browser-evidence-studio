import assert from 'node:assert/strict';
import type { ReplayPosition } from '@/contracts/recording';
import { sameReplayPosition } from '@/contracts/recording';
import type { ReplayHostState } from '@/main/services/client-types';

export function assertReadyReplay(result:ReplayHostState,position:ReplayPosition,replayId?:string,previousGeneration=0):void{
  assert.equal(result.status,'ready',`Replay host returned ${result.status}: ${result.error??'no error detail'}`);
  if(replayId)assert.equal(result.replayId,replayId,'Replay identity changed during seek');
  assert.equal(result.generation,previousGeneration+1,'Replay did not publish the requested generation');
  assert.ok(result.position&&sameReplayPosition(result.position,position),'Replay host position differs from the requested historical position');
  assert.ok(result.state?.position&&sameReplayPosition(result.state.position,position),'Rendered source state differs from the requested historical position');
  assert.equal(result.state?.reliability,'reliable','Replay source structure is not reliable');
  assert.deepEqual(result.state?.gaps,[],'Replay source has unresolved gaps');
  assert.equal(result.resources?.status,'ready',`Replay resources are ${result.resources?.status}: ${JSON.stringify(result.resources?.failures??[])}`);
  assert.equal(result.resources?.unavailableCount??0,0,'Replay has unavailable resources');
}

export interface ReplayDomExpectation { nodeId:number;text:string;buttonNodeId:number;buttonId:string;outlineColor?:string }
export interface ReplayDomObservation { nodeId:number|null;text:string|null;buttonNodeId:number|null;buttonId:string|null;outlineColor:string|null }
export function assertReplayDom(observed:ReplayDomObservation,expected:ReplayDomExpectation):void{
  assert.equal(observed.nodeId,expected.nodeId,'Rendered action count has the wrong rrweb node ID');
  assert.equal(observed.text,expected.text,'Rendered action count differs from saved source text');
  assert.equal(observed.buttonNodeId,expected.buttonNodeId,'Rendered button has the wrong rrweb node ID');
  assert.equal(observed.buttonId,expected.buttonId,'Rendered button identity differs from saved source');
  if(expected.outlineColor)assert.equal(observed.outlineColor,expected.outlineColor,'Archived stylesheet did not render');
}
