import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { WorkbenchDispatcher, type ProjectMetadataPort } from './dispatch';
import { WorkbenchError, publicError } from './errors';
import { WorkbenchSessions, type WorkbenchSessionContext } from './session';
import { checkJsonBudget, exactKeys, identifier, record } from './validation';

export const WORKBENCH_PATHS = Object.freeze({ session: '/workbench/session', rpc: '/workbench/rpc', events: '/workbench/events' });
const paths = new Set<string>(Object.values(WORKBENCH_PATHS));
const securityHeaders = ['host', 'origin', 'authorization', 'x-workbench-instance', 'content-type', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'];
interface EventStream { context: WorkbenchSessionContext; response: ServerResponse; close: () => void }
export interface WorkbenchHttpOptions {
  origin: string;
  sessions: WorkbenchSessions;
  projectPort: ProjectMetadataPort;
  maxRequests?: number;
  maxStreams?: number;
  maxStreamsPerSession?: number;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
}
function budget(value: number | undefined, fallback: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new TypeError('Invalid workbench limit');
  return result;
}

/** Unwired B1.2a core: creating this object neither listens nor grants resource
 * access. start() always binds a fresh loopback port. The caller owns a dedicated
 * session registry; dispose() revokes it. No static files or control routes.
 */
export class WorkbenchHttpTransport {
  private readonly server: Server;
  private readonly dispatcher: WorkbenchDispatcher;
  private readonly streams = new Set<EventStream>();
  private readonly sockets = new Set<Socket>();
  private readonly controllers = new Set<AbortController>();
  private readonly maxRequests: number;
  private readonly maxStreams: number;
  private readonly maxStreamsPerSession: number;
  private readonly maxBodyBytes: number;
  private readonly requestTimeoutMs: number;
  private pending = 0;
  private host: string | undefined;
  private started = false;
  private destroyed = false;
  private startPromise: Promise<{ baseUrl: string; instanceId: string; origin: string }> | undefined;
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly options: WorkbenchHttpOptions) {
    this.options = Object.freeze({ ...options });
    const origin = new URL(options.origin);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.origin !== options.origin) {
      throw new TypeError('A fixed loopback HTTP origin is required');
    }
    this.maxRequests = budget(options.maxRequests, 8, 32);
    this.maxStreams = budget(options.maxStreams, 8, 32);
    this.maxStreamsPerSession = budget(options.maxStreamsPerSession, 2, 4);
    this.maxBodyBytes = budget(options.maxBodyBytes, 16_384, 65_536);
    this.requestTimeoutMs = budget(options.requestTimeoutMs, 5_000, 30_000);
    this.dispatcher = new WorkbenchDispatcher(options.sessions, options.projectPort, projectId => this.invalidate(projectId));
    // Node checks incomplete headers/requests periodically. Bound that sweep
    // too: expiry is the deadline plus at most one sweep (and event-loop delay).
    this.server = createServer({ maxHeaderSize: 8_192, requestTimeout: this.requestTimeoutMs,
      headersTimeout: this.requestTimeoutMs, connectionsCheckingInterval: Math.min(this.requestTimeoutMs, 1_000) }, (request, response) => {
      void this.handle(request, response);
    });
    this.server.maxConnections = 48;
    this.server.keepAliveTimeout = 1_000;
    this.server.on('connection', socket => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    this.server.on('clientError', (_error, socket) => { socket.destroy(); });
  }

  start(): Promise<{ baseUrl: string; instanceId: string; origin: string }> {
    if (this.started || this.destroyed) return Promise.reject(new WorkbenchError('unavailable'));
    this.started = true;
    this.startPromise = this.listen();
    return this.startPromise;
  }

  private async listen(): Promise<{ baseUrl: string; instanceId: string; origin: string }> {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { this.server.off('listening', ready); reject(error); };
      const ready = () => { this.server.off('error', fail); resolve(); };
      this.server.once('error', fail);
      this.server.once('listening', ready);
      this.server.listen(0, '127.0.0.1');
    });
    if (this.destroyed) throw new WorkbenchError('unavailable');
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new WorkbenchError('unavailable');
    this.host = `127.0.0.1:${address.port}`;
    return { baseUrl: `http://${this.host}`, instanceId: this.options.sessions.instanceId, origin: this.options.origin };
  }

  /** Scope invalidation only: no state, credentials, error detail or replay log. */
  invalidate(projectId: string): void {
    identifier(projectId);
    for (const stream of this.streams) {
      if (stream.context.projectId !== projectId) continue;
      try {
        this.options.sessions.assertActive(stream.context);
        if (!stream.response.write(`event: scope-invalidated\ndata: ${JSON.stringify({ projectId })}\n\n`)) stream.close();
      } catch { stream.close(); }
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.destroyed = true;
    this.disposePromise = this.close();
    return this.disposePromise;
  }

  private async close(): Promise<void> {
    this.options.sessions.dispose();
    for (const controller of this.controllers) controller.abort();
    for (const stream of this.streams) stream.close();
    await this.startPromise?.catch(() => {});
    const closed = this.server.listening ? new Promise<void>(resolve => this.server.close(() => resolve())) : Promise.resolve();
    for (const socket of this.sockets) socket.destroy();
    await closed;
  }

  get listening(): boolean { return this.server.listening; }

  get counts(): { requests: number; streams: number; sockets: number } {
    return { requests: this.pending, streams: this.streams.size, sockets: this.sockets.size };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Vary', 'Origin');
    let acquired = false;
    let controller: AbortController | undefined;
    const abort = () => controller?.abort();
    const disconnected = () => { if (!response.writableEnded) abort(); };
    try {
      if (this.destroyed) throw new WorkbenchError('unavailable');
      this.checkAuthority(request);
      if (!paths.has(request.url ?? '')) throw new WorkbenchError('not_found');
      if (request.method !== 'POST') throw new WorkbenchError('not_found');
      if (request.headers['x-workbench-instance'] !== this.options.sessions.instanceId) throw new WorkbenchError('forbidden');
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '') || request.headers['content-encoding']) {
        throw new WorkbenchError('invalid_request');
      }
      if (this.pending >= this.maxRequests) throw new WorkbenchError('busy');
      this.pending++;
      acquired = true;
      controller = new AbortController();
      this.controllers.add(controller);
      request.once('aborted', abort);
      response.once('close', disconnected);
      // Authenticate before allocating a body buffer on RPC and event routes.
      const context = request.url === WORKBENCH_PATHS.session ? undefined : this.authenticate(request);
      const body = await this.readBody(request);
      if (controller.signal.aborted) throw new WorkbenchError('cancelled');
      if (request.url === WORKBENCH_PATHS.session) {
        const input = record(body);
        exactKeys(input, ['instanceId', 'ticket']);
        if (input.instanceId !== this.options.sessions.instanceId) throw new WorkbenchError('forbidden');
        this.json(response, 200, this.options.sessions.exchange(input.ticket, identifier(input.instanceId)));
      } else if (request.url === WORKBENCH_PATHS.rpc) {
        const result = await this.dispatcher.dispatch(body, context!, controller.signal);
        this.json(response, 200, result);
      } else {
        const input = record(body);
        exactKeys(input, ['instanceId', 'projectId']);
        if (input.instanceId !== this.options.sessions.instanceId || input.projectId !== context!.projectId) throw new WorkbenchError('forbidden');
        this.openEvents(context!, response);
      }
    } catch (error) {
      const safe = publicError(error);
      if (!response.headersSent && !response.destroyed) {
        response.setHeader('Connection', 'close');
        this.json(response, safe.status, { error: { code: safe.code } });
      } else if (!response.writableEnded) response.destroy();
    } finally {
      if (acquired) this.pending--;
      if (controller) this.controllers.delete(controller);
      request.off('aborted', abort);
      response.off('close', disconnected);
    }
  }

  private checkAuthority(request: IncomingMessage): void {
    if (!this.host || request.headers.host !== this.host || request.headers.origin !== this.options.origin) throw new WorkbenchError('forbidden');
    if (request.headers['sec-fetch-site'] !== 'same-origin' ||
      !['cors', 'same-origin'].includes(String(request.headers['sec-fetch-mode'])) || request.headers['sec-fetch-dest'] !== 'empty') {
      throw new WorkbenchError('forbidden');
    }
    const names = request.rawHeaders.filter((_value, index) => index % 2 === 0).map(name => name.toLowerCase());
    if (securityHeaders.some(name => names.filter(item => item === name).length > 1)) throw new WorkbenchError('forbidden');
  }
  private authenticate(request: IncomingMessage): WorkbenchSessionContext {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) throw new WorkbenchError('unauthorized');
    return this.options.sessions.authenticate(authorization.slice(7), this.options.sessions.instanceId);
  }
  private readBody(request: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = (error?: unknown, value?: unknown) => {
        clearTimeout(timer);
        request.off('data', data);
        request.off('end', end);
        request.off('error', fail);
        request.off('aborted', fail);
        if (error) reject(error); else resolve(value);
      };
      const fail = () => finish(new WorkbenchError('invalid_request'));
      const data = (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.maxBodyBytes) { request.pause(); finish(new WorkbenchError('invalid_request')); }
        else chunks.push(chunk);
      };
      const end = () => {
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          checkJsonBudget(value);
          finish(undefined, value);
        } catch { finish(new WorkbenchError('invalid_request')); }
      };
      const timer = setTimeout(fail, this.requestTimeoutMs);
      timer.unref();
      request.on('data', data);
      request.once('end', end);
      request.once('error', fail);
      request.once('aborted', fail);
    });
  }
  private openEvents(context: WorkbenchSessionContext, response: ServerResponse): void {
    this.options.sessions.assertActive(context);
    if (this.streams.size >= this.maxStreams || [...this.streams].filter(stream => stream.context === context).length >= this.maxStreamsPerSession) throw new WorkbenchError('busy');
    let removeInvalidation = () => {};
    let closed = false;
    const stream: EventStream = { context, response, close: () => {
      if (closed) return;
      closed = true;
      this.streams.delete(stream);
      removeInvalidation();
      response.off('close', stream.close);
      response.off('error', stream.close);
      // Destroy rather than buffer a final frame for a slow/disconnected reader.
      response.destroy();
    } };
    removeInvalidation = this.options.sessions.onInvalidated(context, stream.close);
    this.streams.add(stream);
    response.once('close', stream.close);
    response.once('error', stream.close);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('X-Accel-Buffering', 'no');
    response.statusCode = 200;
    response.flushHeaders();
    if (!response.write(': connected\n\n')) stream.close();
  }
  private json(response: ServerResponse, status: number, body: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(body));
  }
}
