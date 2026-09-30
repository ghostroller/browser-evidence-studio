import { materializeReplayEvents } from '../../replay/materialize';
import { createCssUrlRewriter, rewriteSrcset } from '../../resources/rewrite';
import { createReplayEventRewriter } from '../../resources/replay-event-rewrite';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { installReplayController, REPLAY_SHELL_BODY, REPLAY_SHELL_STYLE } from '../../replay/controller';
import { installReplayFrameBridge } from '../../replay/frame-bridge';
import { fitReplayViewport, replayHit, waitReplayPresentation } from '../../replay/presentation';
import rrwebSource from '../../../node_modules/rrweb/dist/rrweb.umd.cjs?raw';
import rrwebStyles from '../../../node_modules/rrweb/dist/style.css?raw';
/** A different origin with one immutable public document, no business routes,
 * resource lookup, cookies, bearer authentication, directory or proxy. */
export class ReplayDocumentServer {
  private server?: Server;
  private sockets = new Set<Socket>();
  async start(parentOrigin: string, instanceId: string): Promise<string> {
    if (this.server) throw new Error('Replay document server already started');
    const parent = new URL(parentOrigin);
    if (parent.protocol !== 'http:' || parent.hostname !== '127.0.0.1' || parent.origin !== parentOrigin || !parent.port || !/^[A-Za-z0-9_-]{1,128}$/.test(instanceId)) throw new Error('Invalid replay parent authority');
    const nonce = randomBytes(24).toString('base64');
    const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' blob:; img-src data: blob:; font-src data: blob:; frame-src 'none'; connect-src 'none'; object-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${parentOrigin}`;
    const script = `${rrwebSource}\n;(${installReplayController.toString()})(${replayHit.toString()},${fitReplayViewport.toString()},${waitReplayPresentation.toString()});\n(${installReplayFrameBridge.toString()})(${JSON.stringify(parentOrigin)},${JSON.stringify(instanceId)},(${createReplayEventRewriter.toString()})((${createCssUrlRewriter.toString()})(),${rewriteSrcset.toString()}),(${createCssUrlRewriter.toString()})(),${materializeReplayEvents.toString()});`.replace(/<\/script/gi, '<\\/script');
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${REPLAY_SHELL_STYLE}\n${rrwebStyles.replace(/<\/style/gi, '<\\/style')}</style></head><body>${REPLAY_SHELL_BODY}<script nonce="${nonce}">${script}</script></body></html>`;
    let host = '';
    const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, (request, response) => {
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), clipboard-read=(), clipboard-write=(), display-capture=()');
      response.setHeader('Content-Security-Policy', csp);
      if (request.headers.host !== host || request.rawHeaders.filter((_, index) => index % 2 === 0).filter(name => name.toLowerCase() === 'host').length !== 1) { response.writeHead(403); response.end(); return; }
      if (request.url !== '/replay.html' || !['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) }); response.end(request.method === 'HEAD' ? undefined : html);
    });
    this.server = server; server.maxConnections = 16; server.keepAliveTimeout = 1000;
    server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing replay address');
    host = `127.0.0.1:${address.port}`; return `http://${host}`;
  }
  async dispose() { const server = this.server; this.server = undefined; if (!server) return; for (const socket of this.sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
