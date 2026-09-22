import test from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedUiSender } from '@/main/ui-ipc';

function fixture() {
  const frame = { url: 'file:///trusted/index.html' };
  const sender = { isDestroyed: () => false, mainFrame: frame };
  const window = { uiUrl: frame.url, window: { isDestroyed: () => false, webContents: sender } };
  return { frame, sender, window, event: { sender, senderFrame: frame } };
}
const check = (event: unknown, window: unknown) => isTrustedUiSender(event as Parameters<typeof isTrustedUiSender>[0], window as Parameters<typeof isTrustedUiSender>[1]);

test('UI IPC requires the exact live main frame, webContents and URL', () => {
  const { event, window, frame, sender } = fixture();
  assert.equal(check(event, window), true);
  assert.equal(check({ sender, senderFrame: { ...frame } }, window), false);
  assert.equal(check({ sender: { ...sender }, senderFrame: frame }, window), false);
  frame.url = 'https://untrusted.example/';
  assert.equal(check(event, window), false);
});

test('queued IPC after window/frame teardown is ignored without dereferencing destroyed objects', () => {
  const { event, window } = fixture();
  const destroyed = () => { throw new TypeError('Object has been destroyed'); };
  assert.equal(check({ sender: event.sender, get senderFrame() { return destroyed(); } }, window), false);
  assert.equal(check(event, { ...window, window: { isDestroyed: () => true, get webContents() { return destroyed(); } } }), false);
  assert.equal(check({ ...event, senderFrame: null }, window), false);
  Object.defineProperty(event.senderFrame, 'url', { get: destroyed });
  assert.equal(check(event, window), false);
});
