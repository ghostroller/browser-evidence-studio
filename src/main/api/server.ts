import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const BODY_LIMIT = 64 * 1024;
const JSON_LIMIT = 32 * 1024;
const JOB_RESULT_LIMIT = 24 * 1024;
export interface ApiOptions {
  root: string;
  dispatch: (method: string, body: Record<string, unknown>, source: 'api', context?: { signal?: AbortSignal }) => unknown | Promise<unknown>;
  state?: () => unknown | Promise<unknown>;
}
export interface ApiHandle { address: string; connectionFile: string; close(): Promise<void>; }
type JobStatus = 'queued' | 'running' | 'waiting-human' | 'succeeded' | 'failed' | 'cancelled';
interface ApiFailure { code: string; message: string; status: number; }
interface Job { id: string; status: JobStatus; operation: string; createdAt: string; updatedAt: string; result?: unknown; error?: ApiFailure; cancellationRequested?: boolean; cancellationError?: ApiFailure; }
interface InternalJob { public: Job; body: Record<string, unknown>; cancellation?: AbortController; }
interface Route { verb: string; pattern: RegExp; parameters: string[]; operation: string; mutate?: boolean; lease?: boolean; extra?: Record<string, unknown>; binary?: boolean; }
const route = (verb: string, pattern: RegExp, parameters: string[], operation: string, options: Partial<Route> = {}): Route => ({ verb, pattern, parameters, operation, ...options });
const routes: Route[] = [
  route('GET', /^\/v1\/state$/, [], 'state'),
  route('GET', /^\/v1\/projects$/, [], 'projects'), route('POST', /^\/v1\/projects$/, [], 'createProject', { mutate: true }),
  route('GET', /^\/v1\/projects\/([^/]+)$/, ['projectId'], 'project'),
  route('GET', /^\/v1\/projects\/([^/]+)\/profiles$/, ['projectId'], 'profiles'), route('POST', /^\/v1\/projects\/([^/]+)\/profiles$/, ['projectId'], 'createProfile', { mutate: true }),
  route('POST', /^\/v1\/profiles\/([^/]+)\/save$/, ['profileId'], 'saveProfile', { mutate: true, lease: true }),
  route('GET', /^\/v1\/projects\/([^/]+)\/workflows$/, ['projectId'], 'workflows'), route('POST', /^\/v1\/projects\/([^/]+)\/workflows$/, ['projectId'], 'registerWorkflow', { mutate: true }),
  route('GET', /^\/v1\/runs$/, [], 'runs'), route('POST', /^\/v1\/runs$/, [], 'startRun', { mutate: true }),
  route('GET', /^\/v1\/runs\/([^/]+)$/, ['runId'], 'run'),
  route('GET', /^\/v1\/runs\/([^/]+)\/validation-start-grant$/, ['runId'], 'validationStartGrant'),
  ...['pages', 'snapshot', 'checkpoints', 'summary', 'gaps', 'events', 'artifacts', 'handoffs', 'validations'].map((operation) => route('GET', new RegExp(`^/v1/runs/([^/]+)/${operation}$`), ['runId'], operation)),
  ...[['actions', 'action'], ['checkpoints', 'checkpoint'], ['control', 'control'], ['seal', 'seal'], ['select-page', 'selectPage'], ['handoffs', 'requestHuman'], ['validations', 'startValidation'], ['stop', 'stopRunner']].map(([suffix, operation]) => route('POST', new RegExp(`^/v1/runs/([^/]+)/${suffix}$`), ['runId'], operation, { mutate: true, lease: true })),
  ...[['pause-capture', 'pauseCapture', true], ['resume-capture', 'pauseCapture', false]].map(([suffix, operation, paused]) => route('POST', new RegExp(`^/v1/runs/([^/]+)/${suffix}$`), ['runId'], String(operation), { mutate: true, lease: true, extra: { paused } })),
  route('GET', /^\/v1\/runs\/([^/]+)\/artifacts\/([^/]+)$/, ['runId', 'artifactId'], 'artifact'),
  route('GET', /^\/v1\/runs\/([^/]+)\/artifacts\/([^/]+)\/content$/, ['runId', 'artifactId'], 'artifactContent', { binary: true }),
  route('GET', /^\/v1\/artifacts\/([^/]+)$/, ['artifactId'], 'artifact'),
  route('GET', /^\/v1\/artifacts\/([^/]+)\/content$/, ['artifactId'], 'artifactContent', { binary: true }),
  route('POST', /^\/v1\/handoffs\/([^/]+)\/reply$/, ['handoffId'], 'replyHuman', { mutate: true, lease: true }),
  route('POST', /^\/v1\/handoffs\/([^/]+)\/cancel$/, ['handoffId'], 'cancelHandoff', { mutate: true, lease: true }),
  route('GET', /^\/v1\/validations\/([^/]+)$/, ['validationId'], 'validation'),
  route('GET', /^\/v1\/validations\/([^/]+)\/reviews$/, ['validationId'], 'reviews'),
  route('POST', /^\/v1\/validations\/([^/]+)\/reviews$/, ['validationId'], 'review', { mutate: true }),
];
class ApiError extends Error { constructor(readonly code: string, message: string, readonly status = 400) { super(message); } }
function failure(error: unknown): ApiFailure {
  const value = error as { code?: unknown; message?: unknown; status?: unknown; statusCode?: unknown };
  const status = Number(value?.statusCode ?? value?.status ?? 500);
  return { code: typeof value?.code === 'string' ? value.code.slice(0, 100) : status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED', message: status >= 500 ? 'The operation failed. Check the local run evidence and application status.' : String(value?.message ?? 'Request failed.').slice(0, 2000), status: status >= 400 && status <= 599 ? status : 500 };
}
function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new ApiError('JSON_TOO_DEEP', 'JSON nesting exceeds 32 levels.');
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
  return JSON.stringify(value);
}
function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value ?? null);
  if (Buffer.byteLength(body) > JSON_LIMIT) throw new ApiError('RESPONSE_BUDGET', 'Response exceeds 32 KiB; use a narrower evidence query.', 413);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox" });
  response.end(body);
}
async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (Number(request.headers['content-length'] ?? 0) > BODY_LIMIT) { request.resume(); throw new ApiError('BODY_TOO_LARGE', 'JSON request body exceeds 64 KiB.', 413); }
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    let bytes = 0, exceeded = false;
    request.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > BODY_LIMIT) { if (!exceeded) reject(new ApiError('BODY_TOO_LARGE', 'JSON request body exceeds 64 KiB.', 413)); exceeded = true; return; } chunks.push(chunk); });
    request.on('end', resolve); request.on('error', reject); request.on('aborted', () => reject(new ApiError('REQUEST_ABORTED', 'Request body was interrupted.')));
  });
  if (!chunks.length) return {};
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Mutation bodies must be application/json.', 415);
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError('INVALID_JSON', 'Request body is not valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('INVALID_BODY', 'Request body must be a JSON object.');
  canonical(value);
  return value as Record<string, unknown>;
}
function queryBody(url: URL): Record<string, unknown> {
  const body: Record<string, unknown> = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new ApiError('INVALID_QUERY', 'Reserved query field.');
    if (key in body) throw new ApiError('INVALID_QUERY', 'Repeated query fields are not supported.');
    if (['maxBytes', 'limit', 'fromSequence', 'toSequence', 'generation', 'leaseEpoch'].includes(key)) {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ApiError('INVALID_QUERY', `${key} must be a nonnegative integer.`);
      body[key] = Number(value);
    } else if (['fields', 'types'].includes(key)) body[key] = value.split(',').filter(Boolean);
    else body[key] = value;
  }
  return body;
}
async function connectionFile(root: string, value: Record<string, unknown>): Promise<string> {
  const directory = path.join(root, 'connection');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'agent-connection.json'), temporary = path.join(directory, `${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    // Remove inherited read access before writing the secret; the file is new and has no old explicit grants.
    if (process.platform === 'win32') {
      const result = await executeFile('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
      const sid = result.stdout.match(/S-1-\d+(?:-\d+)+/u)?.[0];
      if (!sid) throw new Error('Unable to establish the current Windows user SID.');
      await executeFile('icacls.exe', [temporary, '/inheritance:r', '/grant:r', `*${sid}:(F)`], { windowsHide: true });
    } else await fs.chmod(temporary, 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } catch (error) { await handle.close(); await fs.rm(temporary, { force: true }); throw error; }
  await handle.close();
  await fs.rename(temporary, file);
  return file;
}

export async function startApi(options: ApiOptions): Promise<ApiHandle> {
  const token = randomBytes(32).toString('base64url'), tokenHash = createHash('sha256').update(token).digest();
  const instanceId = randomUUID(), jobs = new Map<string, InternalJob>(), idempotency = new Map<string, { fingerprint: string; jobId: string }>();
  let address = '', stopped = false;
  const dispatch = (operation: string, body: Record<string, unknown>, context?: { signal?: AbortSignal }): Promise<unknown> => Promise.resolve().then(() => operation === 'state' && options.state ? options.state() : options.dispatch(operation, body, 'api', context));
  const runJob = (job: InternalJob): void => {
    if (stopped || job.public.status !== 'queued') return;
    job.public.status = 'running'; job.public.updatedAt = new Date().toISOString();
    if(['checkpoint','startValidation'].includes(job.public.operation))job.cancellation=new AbortController();
    void dispatch(job.public.operation, job.body, {signal:job.cancellation?.signal}).then((result) => {
      if (job.public.status !== 'running') return;
      const serialized = JSON.stringify(result ?? null);
      const references: Record<string, string> = {};
      if (typeof job.body.runId === 'string') references.runId = job.body.runId;
      if (result && typeof result === 'object') for (const field of ['id', 'runId', 'validationId', 'artifactId', 'checkpointId']) {
        const value = (result as Record<string, unknown>)[field];
        if (typeof value === 'string' && value.length <= 128) references[field] = value;
      }
      job.public.result = Buffer.byteLength(serialized) > JOB_RESULT_LIMIT ? { outputTruncated: true, resultBytes: Buffer.byteLength(serialized), references, nextRead: 'Read this run through summary, checkpoints, validations or artifact queries.' } : result;
      const cancelled=job.public.operation==='checkpoint'&&(result as any)?.metadata?.captureOutcome==='cancelled'||job.public.operation==='startValidation'&&job.cancellation?.signal.aborted;
      job.public.status = cancelled?'cancelled':'succeeded'; job.public.updatedAt = new Date().toISOString();
    }).catch((error: unknown) => { if (job.public.status !== 'running') return; const cancelled=['checkpoint','startValidation'].includes(job.public.operation)&&job.cancellation?.signal.aborted&&error===job.cancellation.signal.reason;job.public.status=cancelled?'cancelled':'failed';if(!cancelled)job.public.error=failure(error);job.public.updatedAt=new Date().toISOString(); });
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (stopped) throw new ApiError('SERVER_CLOSING', 'The application is closing.', 503);
      if (request.socket.remoteAddress !== '127.0.0.1' && request.socket.remoteAddress !== '::ffff:127.0.0.1') throw new ApiError('LOOPBACK_REQUIRED', 'Only loopback clients are allowed.', 403);
      const origin = new URL(address), host = request.headers.host;
      if (host !== origin.host && host !== `localhost:${origin.port}`) throw new ApiError('INVALID_HOST', 'Host is not this local API address.', 403);
      if (request.headers.origin !== undefined && request.headers.origin !== address) throw new ApiError('ORIGIN_DENIED', 'Browser origin is not allowed.', 403);
      if (request.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(String(request.headers['sec-fetch-site']))) throw new ApiError('ORIGIN_DENIED', 'Cross-site browser requests are not allowed.', 403);
      const authorization = String(request.headers.authorization ?? '');
      const supplied = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)?.[1] ?? '';
      if (!timingSafeEqual(createHash('sha256').update(supplied).digest(), tokenHash)) throw new ApiError('UNAUTHORIZED', 'A valid local API bearer token is required.', 401);
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new ApiError('INVALID_URL', 'Only local API paths are accepted.');
      const url = new URL(request.url, address), verb = request.method ?? 'GET';
      if (verb === 'GET' && url.pathname === '/v1/health') { json(response, 200, { status: 'ready', schemaVersion: 1, instanceId, transport: 'loopback-http', processId: process.pid }); return; }
      if (verb === 'GET' && url.pathname === '/v1/capabilities') { json(response, 200, { schemaVersion: 1, authentication: 'Bearer token from current-user-only connection file', asyncMutations: true, idempotencyHeader: 'Idempotency-Key', bodyLimitBytes: BODY_LIMIT, evidenceDefaults: { queryBytes: 8192, artifactBytes: 4096 }, nativeControl: 'Managed Puppeteer transport gate; HTTP leases alone do not control native connections.', validationStartAuthorization: { issuer: 'trusted-ui', singleUse: true, ttlSeconds: 120, readRoute: '/v1/runs/:runId/validation-start-grant', requestField: 'startGrantId', boundTo: ['runId','projectId','profileId','workflowId','leaseEpoch','pageId','targetId','generation','workflowSha256','inputSha256'] }, unsupported: ['public-cdp', 'arbitrary-eval', 'websocket-control'], operations: routes.map(({ verb: method, operation }) => ({ method, operation })) }); return; }
      const jobMatch = /^\/v1\/jobs\/([a-f0-9-]+)(\/cancel)?$/.exec(url.pathname);
      if (jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (!job) throw new ApiError('JOB_NOT_FOUND', 'Job is not available in this application instance.', 404);
        if (verb === 'GET' && !jobMatch[2]) { json(response, 200, job.public); return; }
        if (verb === 'POST' && jobMatch[2]) {
          await requestBody(request);
          if (job.public.status === 'queued') { job.public.status = 'cancelled'; job.public.updatedAt = new Date().toISOString(); }
          else if (job.public.status === 'running' || job.public.status === 'waiting-human') {
            if (!job.public.cancellationRequested) {
              job.public.cancellationRequested = true;
              if(['checkpoint','startValidation'].includes(job.public.operation)){
                // Abort only this job, including a callback still waiting in the
                // Studio queue. The checkpoint result retains persisted evidence.
                job.cancellation?.abort(new Error(job.public.operation==='checkpoint'?'Checkpoint acquisition cancelled':'Validation startup cancelled'));
              }else{
              void dispatch('cancelJob', { jobId: job.public.id, operation: job.public.operation, operationBody: job.body }).then(() => {
                if (job.public.status === 'running' || job.public.status === 'waiting-human') job.public.status = 'cancelled';
                job.public.updatedAt = new Date().toISOString();
              }, (error: unknown) => { job.public.cancellationError = failure(error); job.public.cancellationRequested = false; job.public.updatedAt = new Date().toISOString(); });
              }
            }
          }
          json(response, 202, { jobId: job.public.id, status: job.public.status, cancellationRequested: job.public.cancellationRequested ?? false }); return;
        }
        throw new ApiError('METHOD_NOT_ALLOWED', 'Unsupported job operation.', 405);
      }
      const matched = routes.find((candidate) => candidate.verb === verb && candidate.pattern.test(url.pathname));
      if (!matched) throw new ApiError('NOT_FOUND', 'Unknown API endpoint.', 404);
      const captures = matched.pattern.exec(url.pathname)!;
      const body = { ...queryBody(url), ...(matched.mutate ? await requestBody(request) : {}), ...matched.extra };
      matched.parameters.forEach((name, index) => {
        let value: string;
        try { value = decodeURIComponent(captures[index + 1]); } catch { throw new ApiError('INVALID_ID', 'Malformed path identity.'); }
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) || value === '..') throw new ApiError('INVALID_ID', 'Invalid path identity.');
        body[name] = value;
      });
      if (matched.lease && (!Number.isSafeInteger(body.leaseEpoch) || Number(body.leaseEpoch) < 1)) throw new ApiError('LEASE_REQUIRED', 'A current leaseEpoch is required for this mutation.', 409);
      if (!matched.mutate) {
        const result = await dispatch(matched.operation, body);
        if (matched.binary) {
          const binary = result as { binary?: Uint8Array; mediaType?: string };
          if (!(binary?.binary instanceof Uint8Array)) throw new ApiError('ARTIFACT_UNAVAILABLE', 'Artifact binary body is unavailable.', 404);
          const mediaType = typeof binary.mediaType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(binary.mediaType) ? binary.mediaType : 'application/octet-stream';
          response.writeHead(200, { 'Content-Type': mediaType, 'Content-Length': binary.binary.byteLength, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment', 'Content-Security-Policy': "default-src 'none'; sandbox" }); response.end(binary.binary); return;
        }
        json(response, 200, result); return;
      }
      const headerKey = request.headers['idempotency-key'];
      if (Array.isArray(headerKey) || headerKey && body.idempotencyKey && headerKey !== body.idempotencyKey) throw new ApiError('INVALID_IDEMPOTENCY_KEY', 'Conflicting idempotency keys.');
      const key = headerKey ?? body.idempotencyKey ?? randomUUID();
      if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(key)) throw new ApiError('INVALID_IDEMPOTENCY_KEY', 'Idempotency key must contain 1–200 identifier characters.');
      delete body.idempotencyKey;
      const fingerprint = createHash('sha256').update(`${verb}\n${url.pathname}\n${canonical(body)}`).digest('hex');
      const prior = idempotency.get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new ApiError('IDEMPOTENCY_CONFLICT', 'This key already identifies a different request.', 409);
        const priorJob = jobs.get(prior.jobId)!;
        json(response, 202, { jobId: prior.jobId, status: priorJob.public.status, idempotencyKey: key }); return;
      }
      if (jobs.size >= 1000) throw new ApiError('JOB_LIMIT', 'This instance has reached 1000 jobs; restart after active work finishes.', 429);
      const now = new Date().toISOString(), id = randomUUID();
      const job: InternalJob = { public: { id, status: 'queued', operation: matched.operation, createdAt: now, updatedAt: now }, body };
      jobs.set(id, job); idempotency.set(key, { fingerprint, jobId: id });
      json(response, 202, { jobId: id, status: 'queued', idempotencyKey: key });
      setImmediate(() => runJob(job));
    })().catch((error: unknown) => {
      if (!response.headersSent && !response.destroyed) { const details = failure(error); json(response, details.status, { error: details }); } else response.destroy();
    });
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 2000;
  server.on('upgrade', (_request, socket) => { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const listening = server.address();
  if (!listening || typeof listening === 'string') throw new Error('Expected a loopback TCP address.');
  address = `http://127.0.0.1:${listening.port}`;
  let file: string;
  try { file = await connectionFile(options.root, { schemaVersion: 1, address, token, instanceId, processId: process.pid, createdAt: new Date().toISOString() }); }
  catch (error) { server.close(); throw error; }
  return { address, connectionFile: file, async close() {
    if (stopped) return;
    stopped = true;
    for (const job of jobs.values()) if (['queued', 'running', 'waiting-human'].includes(job.public.status)) { job.public.status = 'failed'; job.public.error = { code: 'APPLICATION_CLOSED', message: 'Application closed before the job completed; inspect run recovery.', status: 503 }; job.public.updatedAt = new Date().toISOString(); }
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    try { const current = JSON.parse(await fs.readFile(file, 'utf8')); if (current.instanceId === instanceId) await fs.unlink(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  } };
}
