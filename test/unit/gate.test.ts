import { test } from 'vitest';
import assert from 'node:assert/strict';
import { GateDrainError, GateTransport, type ProtocolTransport } from '@/runner/gate';
import type { TransportCloseInfo } from '@/runner/transport-diagnostics';

class FakeTransport implements ProtocolTransport {
  onmessage?: (message: string) => void;
  onclose?: (details?: TransportCloseInfo) => void;
  sent: string[] = [];
  send(message: string) { this.sent.push(message); }
  close() { this.onclose?.(); }
  reply(id: number) { this.onmessage?.(JSON.stringify({ id, result: {} })); }
}

test('drain blocks Promise and timer commands before human input is enabled, while capture continues', async () => {
  const operation = new FakeTransport();
  const capture = new FakeTransport();
  const conflicts: string[] = [];
  const gate = new GateTransport(operation, { onConflict: event => conflicts.push(event.method) });
  const received: { id: number; error?: unknown }[] = [];
  gate.onmessage = message => received.push(JSON.parse(message));
  gate.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate' }));
  let humanEnabled = false;
  const draining = gate.quiesce().then(() => { humanEnabled = true; });
  await Promise.resolve().then(() => gate.send(JSON.stringify({ id: 2, method: 'Input.dispatchMouseEvent' })));
  await new Promise<void>(resolve => setTimeout(() => {
    gate.send(JSON.stringify({ id: 3, method: 'Unknown.newMutation', sessionId: 'page-session' }));
    resolve();
  }, 1));
  capture.send(JSON.stringify({ id: 1, method: 'Network.getResponseBody' }));
  assert.equal(humanEnabled, false);
  assert.equal(operation.sent.length, 1);
  assert.equal(capture.sent.length, 1);
  operation.reply(1);
  await draining;
  assert.equal(humanEnabled, true);
  assert.equal(gate.snapshot().state, 'quiesced');
  assert.deepEqual(conflicts, ['Input.dispatchMouseEvent', 'Unknown.newMutation']);
  assert.equal(received.filter(reply => reply.error).length, 2);
  gate.resume();
  gate.send(JSON.stringify({ id: 4, method: 'Page.navigate' }));
  assert.equal(operation.sent.length, 2);
});

test('a timed-out drain fails closed and cannot be resumed even after a late reply', async () => {
  const raw = new FakeTransport();
  const gate = new GateTransport(raw);
  raw.onmessage?.(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'known' } }));
  gate.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate' }));
  await assert.rejects(gate.quiesce(5), GateDrainError);
  raw.reply(1);
  assert.equal(gate.snapshot().state, 'failed');
  assert.throws(() => gate.resume(), /failed/);
  gate.send(JSON.stringify({ id: 2, method: 'Page.navigate' }));
  gate.send(JSON.stringify({ id: 3, method: 'Runtime.runIfWaitingForDebugger', sessionId: 'known' }));
  assert.equal(raw.sent.length, 1);
  assert.equal(gate.snapshot().rejectedCommands, 2);
});

test('connection loss during drain rejects the handoff and closes once', async () => {
  const raw = new FakeTransport();
  const gate = new GateTransport(raw);
  let closes = 0;
  gate.onclose = () => { closes += 1; };
  gate.send(JSON.stringify({ id: 1, method: 'Page.navigate' }));
  const draining = gate.quiesce();
  raw.close();
  await assert.rejects(draining, /closed before drain/);
  gate.close();
  assert.equal(closes, 1);
  assert.equal(gate.snapshot().state, 'closed');
});

test('closing evidence retains bounded method names before drain state is cleared', () => {
  const raw = new FakeTransport();
  let notifications=0;
  const gate = new GateTransport(raw,{onClosed:()=>{notifications++;}});
  for(let id=1;id<=20;id++)gate.send(JSON.stringify({id,method:`Synthetic.command${id}`,params:{secret:'never-save-protocol-arguments'}}));
  raw.onclose?.({source:'remote',occurredAt:new Date().toISOString(),code:1006});
  const info=gate.closeDiagnostic;
  assert.equal(info?.trigger,'transport');
  assert.equal(info?.gateStateBeforeClose,'open');
  assert.equal(info?.inFlight,20);
  assert.equal(info?.pendingMethods.length,16);
  assert.equal(info?.pendingMethodsTruncated,true);
  assert.equal(JSON.stringify(info).includes('never-save-protocol-arguments'),false);
  assert.equal(gate.snapshot().inFlight,0);
  gate.close();raw.onclose?.({source:'remote',occurredAt:new Date().toISOString(),code:1000});
  assert.equal(notifications,1);assert.equal(gate.closeDiagnostic?.transport.code,1006);
});

test('human takeover permits bounded attached-session housekeeping without opening page operations', async () => {
  const raw = new FakeTransport();
  const gate = new GateTransport(raw);
  raw.onmessage?.(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'tab' } }));
  raw.onmessage?.(JSON.stringify({ method: 'Target.attachedToTarget', sessionId: 'tab', params: { sessionId: 'page' } }));
  await gate.quiesce();
  // These arise from Puppeteer events, even while the workflow awaits requestHuman.
  const commands = [
    { method: 'Runtime.runIfWaitingForDebugger', sessionId: 'page' },
    { method: 'Target.setAutoAttach', sessionId: 'tab', params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: true, filter: [{}] } },
    { method: 'Runtime.releaseObject', sessionId: 'page', params: { objectId: 'obsolete-context-handle' } },
    { method: 'Target.detachFromTarget', sessionId: 'tab', params: { sessionId: 'page' } },
  ];
  commands.forEach((command, i) => { gate.send(JSON.stringify({ id: i + 1, ...command })); raw.reply(i + 1); });
  assert.equal(raw.sent.length, 4);
  assert.equal(gate.snapshot().maintenanceCommands, 4);
  assert.equal(gate.snapshot().state, 'quiesced');
  const rejected = [
    { method: 'Runtime.evaluate', sessionId: 'page' },
    { method: 'Runtime.callFunctionOn', sessionId: 'page' },
    { method: 'Input.dispatchMouseEvent', sessionId: 'page' },
    { method: 'Page.navigate', sessionId: 'page' },
    { method: 'Unknown.futureMutation', sessionId: 'page' },
    { method: 'Runtime.runIfWaitingForDebugger', sessionId: 'unobserved' },
    { method: 'Runtime.runIfWaitingForDebugger', sessionId: 'page', params: { expression: 'mutation' } },
    { method: 'Target.detachFromTarget', params: { sessionId: 'page' } },
    { method: 'Target.setAutoAttach', sessionId: 'page', params: { autoAttach: false, flatten: true, waitForDebuggerOnStart: true, filter: [{}] } },
    { method: 'Target.setAutoAttach', sessionId: 'page', params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: true, filter: [[]] } },
  ];
  rejected.forEach((command, i) => gate.send(JSON.stringify({ id: 20 + i, ...command })));
  assert.equal(raw.sent.length, 4);
  assert.equal(gate.snapshot().rejectedCommands, rejected.length);
  raw.onmessage?.(JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: 'page' } }));
  gate.send(JSON.stringify({ id: 40, ...commands[0] }));
  assert.equal(gate.snapshot().rejectedCommands, rejected.length + 1);
  gate.close();
  gate.send(JSON.stringify({ id: 41, ...commands[1] }));
  assert.equal(raw.sent.length, 4, 'Even housekeeping is denied after the transport closes');
});

test('checks the action owner again before internal follow-up CDP commands',()=>{
  const raw=new FakeTransport(),gate=new GateTransport(raw);let valid=true;
  gate.setCommandGuard(()=>{if(!valid)throw new Error('document changed');});
  gate.send(JSON.stringify({id:1,method:'DOM.getContentQuads'}));raw.reply(1);valid=false;
  assert.throws(()=>gate.send(JSON.stringify({id:2,method:'Input.dispatchMouseEvent'})),/document changed/);
  assert.equal(raw.sent.length,1);gate.setCommandGuard();gate.close();
});
