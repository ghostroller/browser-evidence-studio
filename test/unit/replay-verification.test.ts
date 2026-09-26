import { describe,it,expect } from 'vitest';
import { assertReadyReplay,assertReplayDom } from '../desktop/replay-verification';
import type { ReplayHostState } from '@/main/services/client-types';
import type { ReplayPosition } from '@/contracts/recording';

const position:ReplayPosition={recordingId:'r',pageId:'p',documentId:'d',streamEpoch:'e',eventSeq:1,sourceTimeMs:1};
const ready:ReplayHostState={replayId:'replay',projectId:'project',generation:1,status:'ready',position,state:{position,reliability:'reliable',gaps:[],viewport:{width:800,height:600,deviceScaleFactor:1}},selecting:false,selectionSequence:0,resources:{status:'ready',blockedRequests:0,failures:[]}};
describe('production replay soak gate',()=>{
  it('rejects an awaited host failure even if a renderer remains alive',()=>{
    expect(()=>assertReadyReplay({...ready,status:'failed',error:'rrweb render failed'},position)).toThrow('rrweb render failed');
    expect(()=>assertReadyReplay({...ready,resources:{status:'partial',blockedRequests:0,failures:[]}},position)).toThrow('partial');
    expect(()=>assertReadyReplay({...ready,state:{...ready.state!,position:{...position,eventSeq:2}}},position)).toThrow('Rendered source state');
  });
  it('rejects a rendered node or text that differs from saved history',()=>{
    expect(()=>assertReplayDom({nodeId:4,text:'live',buttonNodeId:5,buttonId:'soak-click-2',outlineColor:null},{nodeId:4,text:'saved',buttonNodeId:5,buttonId:'soak-click-2'})).toThrow('saved source text');
  });
});
