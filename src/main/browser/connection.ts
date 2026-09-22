import WebSocket from 'ws';
import type { ProtocolTransport } from '../../runner/gate';
export class SocketTransport implements ProtocolTransport {
  onmessage?: (message: string) => void;
  onclose?: () => void;
  private constructor(private socket: WebSocket) {
    socket.on('message', data => this.onmessage?.(data.toString()));
    socket.on('close', () => this.onclose?.());
    socket.on('error', () => this.onclose?.());
  }
  static async connect(endpoint: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const socket = new WebSocket(endpoint, { maxPayload: 64 * 1024 * 1024, handshakeTimeout: 10_000 });
    await new Promise<void>((resolve, reject) => {
      const clean = () => { signal?.removeEventListener('abort', aborted); socket.off('open', opened); socket.off('error', failed); socket.off('close', closed); };
      const opened = () => { clean(); resolve(); };
      const failed = (error: Error) => { clean(); reject(error); };
      const closed = () => failed(new Error('Operation socket closed before its handshake completed'));
      const aborted = () => { socket.once('error', () => {}); socket.terminate(); clean(); reject(signal?.reason ?? new Error('Operation socket connection cancelled')); };
      socket.once('open', opened); socket.once('error', failed); socket.once('close', closed);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
    if (signal?.aborted) { socket.terminate(); signal.throwIfAborted(); }
    return new SocketTransport(socket);
  }
  send(message: string) { this.socket.send(message); }
  close() { this.socket.close(); }
}
