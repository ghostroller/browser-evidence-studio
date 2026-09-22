import test from 'node:test';
import assert from 'node:assert/strict';
import { GateDrainError, GateTransport, type ProtocolTransport } from '@/runner/gate';

class FakeTransport implements ProtocolTransport {
  onmessage?: (message: string) => void;
  onclose?: () => void;
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
  gate.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate' }));
  await assert.rejects(gate.quiesce(5), GateDrainError);
  raw.reply(1);
  assert.equal(gate.snapshot().state, 'failed');
  assert.throws(() => gate.resume(), /failed/);
  gate.send(JSON.stringify({ id: 2, method: 'Page.navigate' }));
  assert.equal(raw.sent.length, 1);
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
