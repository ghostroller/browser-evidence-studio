import WebSocket from 'ws';
import type { ProtocolTransport } from '@/runner/gate';
import { transportCloseInfo, type TransportCloseInfo } from '@/runner/transport-diagnostics';

function connectionError(error: unknown) {
  const details = transportCloseInfo('error', { error });
  return Object.assign(new Error(details.errorMessage || 'Operation socket connection failed'), {
    name: details.errorName || 'Error', ...(details.errorCode ? { code: details.errorCode } : {}), transportCloseInfo: details,
  });
}

export class SocketTransport implements ProtocolTransport {
  onmessage?: (message: string) => void;
  private closeHandler?: (details?: TransportCloseInfo) => void;
  private closeDetails?: TransportCloseInfo;
  private closeNotified = false;
  private localClosing = false;
  get onclose() { return this.closeHandler; }
  set onclose(handler: ((details?: TransportCloseInfo) => void) | undefined) { this.closeHandler = handler; this.notifyClosed(); }
  private constructor(private socket: WebSocket) {
    socket.on('message', data => this.onmessage?.(data.toString()));
    socket.on('close', (code, reason) => {
      // An error is emitted before the following close. Preserve the useful
      // first failure instead of replacing it with the derivative close code.
      this.closeDetails ??= transportCloseInfo(this.localClosing ? 'local' : 'remote', { code, reason: reason.toString('utf8') });
      this.notifyClosed();
    });
    socket.on('error', error => {
      if (!this.closeNotified) this.closeDetails = transportCloseInfo('error', { error });
      this.notifyClosed();
    });
  }
  private notifyClosed() {
    if (this.closeNotified || !this.closeDetails || !this.closeHandler) return;
    this.closeNotified = true; this.closeHandler(this.closeDetails);
  }
  static async connect(endpoint: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    let socket: WebSocket;
    try { socket = new WebSocket(endpoint, { maxPayload: 64 * 1024 * 1024, handshakeTimeout: 10_000 }); }
    catch (error) { throw connectionError(error); }
    // Install a persistent error consumer before starting the handshake wait,
    // including errors emitted later by terminate() after abort or failure.
    const transport = new SocketTransport(socket);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const clean = () => { signal?.removeEventListener('abort', aborted); socket.off('open', opened); socket.off('error', failed); socket.off('close', closed); };
      const opened = () => { if (settled) return; settled = true; clean(); resolve(); };
      const failed = (error: Error) => { if (settled) return; settled = true; clean(); reject(connectionError(error)); };
      const closed = () => failed(new Error('Operation socket closed before its handshake completed'));
      const aborted = () => {
        if (settled) return;
        settled = true; clean(); transport.localClosing = true; socket.terminate();
        reject(signal?.reason ?? new Error('Operation socket connection cancelled'));
      };
      socket.once('open', opened); socket.once('error', failed); socket.once('close', closed);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
    if (signal?.aborted) { transport.close(); signal.throwIfAborted(); }
    return transport;
  }
  send(message: string) { this.socket.send(message); }
  close() { this.localClosing = true; this.socket.close(); }
}
