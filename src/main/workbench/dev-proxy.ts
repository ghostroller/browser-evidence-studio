import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';

const paths = new Set(['/workbench/session', '/workbench/rpc', '/workbench/events']);
const forwarded = ['origin', 'authorization', 'x-workbench-instance', 'content-type', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'] as const;
const securityHeaders = ['host', ...forwarded];
export interface WorkbenchProxyOptions { origin: string; targetPort: number }
function fail(response: ServerResponse, status: number, code: string) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify({ error: { code } }));
}
/** Fixed development proxy, not a general URL forwarder. Never injects auth,
 * forwards cookies/Agent routes, rewrites Origin or relaxes Fetch Metadata. */
export function createWorkbenchDevProxy(options: WorkbenchProxyOptions) {
  const origin = new URL(options.origin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.origin !== options.origin ||
    !Number.isSafeInteger(options.targetPort) || options.targetPort < 1 || options.targetPort > 65535) throw new TypeError('Invalid fixed loopback proxy configuration');
  const authority = origin.host;
  return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const names = request.rawHeaders.filter((_item, index) => index % 2 === 0).map(name => name.toLowerCase());
    if (request.headers.host !== authority || securityHeaders.some(name => names.filter(item => item === name).length > 1)) return fail(response, 403, 'forbidden');
    if (!(request.url ?? '').startsWith('/workbench')) return next();
    if (!paths.has(request.url ?? '') || request.method !== 'POST') return fail(response, 404, 'not_found');
    if (request.headers.origin !== options.origin || request.headers['sec-fetch-site'] !== 'same-origin' ||
      !['cors', 'same-origin'].includes(String(request.headers['sec-fetch-mode'])) || request.headers['sec-fetch-dest'] !== 'empty') return fail(response, 403, 'forbidden');
    if (request.headers['content-encoding']) return fail(response, 400, 'invalid_request');
    const headers: Record<string, string> = { host: `127.0.0.1:${options.targetPort}` };
    for (const key of forwarded) {
      const value = request.headers[key];
      if (typeof value === 'string') headers[key] = value;
    }
    const upstream = httpRequest({ hostname: '127.0.0.1', port: options.targetPort, method: 'POST', path: request.url, headers }, incoming => {
      const safeHeaders: Record<string, string> = {};
      for (const key of ['content-type', 'cache-control', 'x-content-type-options']) {
        const value = incoming.headers[key]; if (typeof value === 'string') safeHeaders[key] = value;
      }
      response.writeHead(incoming.statusCode ?? 502, safeHeaders);
      incoming.pipe(response);
      incoming.once('error', () => response.destroy());
    });
    upstream.once('error', () => { if (!response.headersSent && !response.destroyed) fail(response, 503, 'unavailable'); else response.destroy(); });
    request.once('aborted', () => upstream.destroy());
    response.once('close', () => upstream.destroy());
    request.pipe(upstream);
  };
}
