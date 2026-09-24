import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { SocketTransport } from '@/main/browser/connection';
import { transportCloseInfo, type TransportCloseInfo } from '@/runner/transport-diagnostics';

async function pair(t: TestContext) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  t.after(async () => {
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const connected = once(server, 'connection');
  const transport = await SocketTransport.connect(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const [peer] = await connected as [WebSocket];
  return { transport, peer };
}

function observe(transport: SocketTransport) {
  const notifications: TransportCloseInfo[] = [];
  let done!: (info: TransportCloseInfo) => void;
  const closed = new Promise<TransportCloseInfo>(resolve => { done = resolve; });
  transport.onclose = info => { assert(info); notifications.push(info); done(info); };
  return { notifications, closed };
}

test('socket transport preserves remote policy close and reason exactly once', { timeout: 5000 }, async t => {
  const { transport, peer } = await pair(t), result = observe(transport);
  peer.close(1008, 'Policy rejected the operation');
  const info = await result.closed;
  assert.equal(info.source, 'remote'); assert.equal(info.code, 1008);
  assert.equal(info.reason, 'Policy rejected the operation'); assert(Number.isFinite(Date.parse(info.occurredAt)));
  transport.close(); await delay(20);
  assert.equal(result.notifications.length, 1);
});

test('socket transport distinguishes abrupt remote termination from local close', { timeout: 5000 }, async t => {
  const remote = await pair(t), remoteResult = observe(remote.transport);
  remote.peer.terminate();
  assert.deepEqual({ ...(await remoteResult.closed), occurredAt: null }, { source: 'remote', occurredAt: null, code: 1006, reason: '' });
  const local = await pair(t), localResult = observe(local.transport);
  local.transport.close();
  assert.equal((await localResult.closed).source, 'local');
  assert.equal(localResult.notifications.length, 1);
});

test('socket error takes precedence over following close and redacts endpoint and credentials', { timeout: 5000 }, async t => {
  const { transport, peer } = await pair(t), result = observe(transport);
  // A local synthetic socket error makes the error/close ordering deterministic.
  const socket = (transport as unknown as { socket: WebSocket }).socket;
  socket.emit('error', Object.assign(new Error('socket failed ws://user:pass@127.0.0.1:12345/devtools/browser/private-id?token=hidden Authorization: Bearer top-secret'), { code: 'ECONNRESET' }));
  peer.terminate();
  const info = await result.closed;
  await once(socket, 'close');
  assert.equal(info.source, 'error'); assert.equal(info.errorCode, 'ECONNRESET'); assert.equal(info.errorName, 'Error');
  for (const secret of ['127.0.0.1', '12345', 'private-id', 'hidden', 'top-secret', 'user:pass']) assert(!JSON.stringify(info).includes(secret));
  assert.equal(result.notifications.length, 1); assert.equal(info.code, undefined);
});

test('close before consumer registration is retained and delivered once', { timeout: 5000 }, async t => {
  const { transport, peer } = await pair(t);
  const socket = (transport as unknown as { socket: WebSocket }).socket;
  const closed = once(socket, 'close'); peer.close(1008, 'early close'); await closed;
  const first = observe(transport); assert.equal((await first.closed).reason, 'early close');
  let repeated = 0; transport.onclose = () => { repeated++; };
  assert.equal(repeated, 0);
});

test('failed handshake rejects with bounded structured error instead of swallowing the socket error', { timeout: 5000 }, async t => {
  const server = createServer((_request, response) => { response.writeHead(403); response.end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await assert.rejects(SocketTransport.connect(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/sensitive?token=never-log`), (error: any) => {
    assert.equal(error.transportCloseInfo.source, 'error'); assert.match(error.message, /403/);
    assert(!JSON.stringify(error).includes('never-log')); return true;
  });
  await delay(20); // The later close/error cleanup must not become an unhandled event.
});

test('aborted handshake cleans up while consuming termination errors', { timeout: 5000 }, async t => {
  const server = createServer();
  const upgraded = new Promise<void>(resolve => server.once('upgrade', (_request, socket) => { t.after(() => socket.destroy()); resolve(); }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const controller = new AbortController();
  const connecting = SocketTransport.connect(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, controller.signal);
  const rejected = assert.rejects(connecting, /synthetic cancellation/);
  await upgraded; controller.abort(new Error('synthetic cancellation')); await rejected;
  await delay(20);
});

test('transport diagnostics are bounded and retain no supplied error payload fields', () => {
  const info = transportCloseInfo('error', { reason: 'x'.repeat(1024), code: 1008,
    error: { name: 'Error', code: 'ECONNRESET', message: 'y'.repeat(2048), token: 'hidden', params: { secret: 'hidden' } } });
  assert.equal(info.reason?.length, 512); assert.equal(info.reasonTruncated, true);
  assert.equal(info.errorMessage?.length, 512); assert(!JSON.stringify(info).includes('hidden'));
  const credentials = transportCloseInfo('remote', { reason: 'Cookie: session=one; account=two' });
  assert.equal(credentials.reason, '[redacted-cookie]');
});
