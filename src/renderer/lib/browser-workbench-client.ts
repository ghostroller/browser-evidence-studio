import { WEB_REPLAY_BUDGET, type WebReplayClient, type WebReplayMethod, type WebReplayInput, type WebReplayResult } from '@/contracts/web-replay';
import { BROWSER_MATERIAL_METHODS, BROWSER_MATERIAL_WRITE_METHODS, type BrowserMaterialMethod, type BrowserMaterialInput, type BrowserMaterialResult } from '@/contracts/browser-materials';
import { memoryEditorStorage, type MaterialWorkbenchClient, type MaterialEditorCall } from './material-workbench-client';
import { BROWSER_RESULT_METHODS, BROWSER_RESULT_BUDGET, type BrowserResultMethod, type BrowserResultInput, type BrowserResultResult } from '@/contracts/browser-results';
import type { ResultWorkbenchClient, ResultReadCall } from './result-workbench-client';
import type { BrowserProjectMetadata, BrowserUpdateProject, BrowserWorkbenchErrorCode, BrowserWorkbenchSession, BrowserWorkbenchState, BrowserWorkbenchGrant } from '@/contracts/browser-workbench';
import { workbenchHost, type WorkbenchHost, type WorkbenchBackend } from '@/contracts/host-capabilities';

export type BrowserConnectionStatus = 'disconnected' | 'exchanging' | 'connecting' | 'connected' | 'stale' | 'expired' | 'error';
export interface BrowserWorkbenchSnapshot {
  status: BrowserConnectionStatus;
  state: BrowserWorkbenchState | null;
  error: string;
  projectId?: string;
  expiresAt?: number;
  grant?: BrowserWorkbenchGrant;
  refreshToken?: number;
  sessionEpoch?: number;
}
const messages: Record<BrowserWorkbenchErrorCode | 'network' | 'protocol', string> = {
  unauthorized: '配对已失效或会话已撤销，请重新配对。', forbidden: '此连接没有当前实例或项目的权限，请重新配对。',
  invalid_request: '项目请求不符合允许的字段格式。', not_found: '项目或工作台服务不可用。',
  conflict: '项目已被其他操作修改。输入已保留，请撤销输入以读取最新版本后再编辑。',
  busy: '工作台正在处理其他请求，请稍后重试。', cancelled: '请求已取消；已开始的保存可能已经完成，请刷新核对。',
  unavailable: '工作台暂时不可用。', internal_error: '工作台未能完成请求。',
  network: '连接中断，显示的资料可能已过时；恢复读取前不能保存。', protocol: '工作台返回的数据无法验证，未将它当作空项目。',
};
export class BrowserWorkbenchClientError extends Error {
  constructor(readonly code: keyof typeof messages, readonly resultUncertain = false) { super(messages[code]); this.name = 'BrowserWorkbenchClientError'; }
}
const failure = (code: keyof typeof messages) => new BrowserWorkbenchClientError(code);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('protocol');
  return value as Record<string, unknown>;
};
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
function project(value: unknown, projectId: string): BrowserProjectMetadata {
  const data = object(value);
  if (data.id !== projectId || typeof data.name !== 'string' || !data.name.trim() || data.name.length > 200 || typeof data.objective !== 'string' || data.objective.length > 4000 || !Number.isSafeInteger(data.revision) || (data.revision as number) < 0) throw failure('protocol');
  // Never retain a service DTO, credentials or fields beyond the authorized projection.
  return Object.freeze({ id: projectId, name: data.name, objective: data.objective, revision: data.revision as number });
}

/** B1.2's scoped HTTP client intentionally does not implement the 90-method
 * Electron WorkbenchClient. Credentials are private memory, never a URL or store. */
export class BrowserWorkbenchClient {
  readonly host: WorkbenchHost;
  readonly nativePresentation = null;
  #editorStorage = memoryEditorStorage();
  readonly materials: MaterialWorkbenchClient = {
    host: 'browser', storage: {
      getItem: key => this.#session ? this.#editorStorage.getItem(key) : null,
      setItem: (key, value) => { if (this.#session) this.#editorStorage.setItem(key, value); },
      removeItem: key => this.#editorStorage.removeItem(key),
    },
    call: ((method, input) => this.materialCall(method, input)) as MaterialEditorCall,
    canEdit: () => (this.#session?.grant === 'project-materials' || (this.#session?.grant === 'project-workbench' || this.#session?.grant === 'project-replay')) && this.#snapshot.status === 'connected',
    waitAfterWrite: acknowledgement => this.waitAfterMaterialWrite(acknowledgement),
  };
  readonly results: ResultWorkbenchClient = {
    host: 'browser', call: ((method, input) => this.resultCall(method, input)) as ResultReadCall,
    canRead: () => (this.#session?.grant === 'project-workbench' || this.#session?.grant === 'project-replay') && this.#snapshot.status === 'connected',
  };
  readonly instanceId: string;
  readonly #fetch: typeof fetch;
  readonly #retryDelays: readonly number[];
  #session: BrowserWorkbenchSession | null = null;
  #snapshot: BrowserWorkbenchSnapshot = Object.freeze({ status: 'disconnected', state: null, error: '' });
  #listeners = new Set<() => void>();
  #controllers = new Set<AbortController>();
  #generation = 0;
  #readSequence = 0;
  #reads = new Set<number>();
  #writeAcks = new WeakMap<object, { generation: number; projectId: string }>();
  #expiry?: ReturnType<typeof setTimeout>;
  #reconnect?: ReturnType<typeof setTimeout>;
  #streamController?: AbortController;
  #streamActive = false;
  #attempt = 0;
  #mutation = false;
  constructor(options: { instanceId: string; backend?: Exclude<WorkbenchBackend, 'electron'>; fetch?: typeof fetch; retryDelaysMs?: readonly number[] }) {
    if (!identifier(options.instanceId)) throw failure('protocol');
    this.instanceId = options.instanceId;
    this.host = workbenchHost(options.backend ?? 'electron-companion');
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#retryDelays = options.retryDelaysMs ?? [250, 500, 1000, 2000, 4000, 8000];
  }
  getSnapshot = (): BrowserWorkbenchSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #emit(update: Partial<BrowserWorkbenchSnapshot>): void {
    this.#snapshot = Object.freeze({ ...this.#snapshot, ...update });
    for (const listener of this.#listeners) listener();
  }
  #clear(status: BrowserConnectionStatus, error = ''): void {
    ++this.#generation; ++this.#readSequence;
    this.#editorStorage.clear();this.#writeAcks=new WeakMap();this.#reads.clear();
    this.#session = null; this.#streamActive = false; this.#mutation = false; this.#attempt = 0;
    clearTimeout(this.#expiry); clearTimeout(this.#reconnect);
    this.#expiry = undefined; this.#reconnect = undefined;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear(); this.#streamController = undefined;
    this.#snapshot = Object.freeze({ status, state: null, error });
    for (const listener of this.#listeners) listener();
  }
  disconnect = (): void => this.#clear('disconnected');
  #active(generation: number): boolean { return generation === this.#generation && !!this.#session; }
  #handle(error: unknown, generation: number): BrowserWorkbenchClientError {
    const safe = error instanceof BrowserWorkbenchClientError ? error : failure('network');
    if (generation !== this.#generation) return safe;
    if (safe.code === 'unauthorized' || safe.code === 'forbidden') this.#clear('expired', safe.message);
    else this.#emit({ status: this.#session ? 'stale' : 'error', error: safe.message });
    return safe;
  }
  async #request(path: 'session' | 'rpc' | 'events', body: unknown, controller: AbortController): Promise<Response> {
    const token = path === 'session' ? undefined : this.#session?.token;
    if (path !== 'session' && !token) throw failure('unauthorized');
    const response = await this.#fetch(`/workbench/${path}`, {
      method: 'POST', mode: 'same-origin', credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'x-workbench-instance': this.instanceId, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body), signal: controller.signal,
    });
    if (!response.ok) {
      let code: keyof typeof messages = response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : 'unavailable';
      try { const received = object(object(await response.json()).error).code; if (response.status !== 401 && response.status !== 403 && typeof received === 'string' && Object.hasOwn(messages, received)) code = received as keyof typeof messages; } catch { /* Never expose response/error bodies. */ }
      throw failure(code);
    }
    return response;
  }
  async #json(path: 'session' | 'rpc', body: unknown, maximum?: number, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController(); this.#controllers.add(controller);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    try {
      const response = await this.#request(path, body, controller);
      if (!response.headers.get('content-type')?.includes('application/json')) throw failure('protocol');
      try {
        if (maximum === undefined) return await response.json();
        if (!response.body || Number(response.headers.get('content-length') ?? 0) > maximum) throw failure('protocol');
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
        try { while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > maximum) throw failure('protocol'); chunks.push(chunk.value); } }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const output = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
        return JSON.parse(new TextDecoder().decode(output));
      } catch { throw failure('protocol'); }
    } finally { this.#controllers.delete(controller); signal?.removeEventListener('abort', abort); }
  }
  async connect(ticket: string): Promise<void> {
    this.#clear('exchanging');
    const generation = this.#generation;
    try {
      if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw failure('unauthorized');
      const data = object(await this.#json('session', { instanceId: this.instanceId, ticket }));
      if (generation !== this.#generation) return;
      if (data.instanceId !== this.instanceId || !identifier(data.projectId) || typeof data.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.token) || !Number.isSafeInteger(data.expiresAt) || (data.expiresAt as number) <= Date.now() || (data.expiresAt as number) > Date.now() + 15 * 60_000) throw failure('protocol');
      const grant = data.grant === undefined ? 'project-metadata' : data.grant;
      if (grant !== 'project-metadata' && grant !== 'project-materials' && grant !== 'project-workbench' && grant !== 'project-replay') throw failure('protocol');
      this.#session = { grant, token: data.token, expiresAt: data.expiresAt as number, instanceId: this.instanceId, projectId: data.projectId };
      this.#emit({ grant, sessionEpoch: generation, status: 'connecting', projectId: data.projectId, expiresAt: data.expiresAt as number });
      this.#expiry = setTimeout(() => this.#clear('expired', messages.unauthorized), Math.max(0, this.#session.expiresAt - Date.now()));
      await this.#openStream(generation);
    } catch (error) { throw this.#handle(error, generation); }
  }
  /** A manual refresh also resumes an exhausted event connection. */
  refresh = async (): Promise<void> => {
    const generation = this.#generation;
    if (!this.#session) throw failure('unauthorized');
    if (!this.#streamActive && !this.#streamController) {
      clearTimeout(this.#reconnect); this.#reconnect = undefined; this.#attempt = 0;
      await this.#openStream(generation); return;
    }
    await this.#read(generation);
  };
  async #read(generation: number): Promise<void> {
    const session = this.#session; if (!session || !this.#active(generation)) return;
    const sequence = ++this.#readSequence;
    this.#reads.add(sequence);
    try {
      const data = object(await this.#json('rpc', { instanceId: this.instanceId, method: 'state', body: { projectId: session.projectId } }));
      if (!this.#active(generation) || sequence !== this.#readSequence) return;
      const next = project(data.project, session.projectId);
      const current = this.#snapshot.state?.project;
      if (current && next.revision < current.revision) throw failure('protocol');
      this.#emit({ state: Object.freeze({ project: next }), status: this.#streamActive ? 'connected' : 'stale', error: '', refreshToken: (this.#snapshot.refreshToken ?? 0) + 1 });
    } catch (error) { if (sequence === this.#readSequence) throw this.#handle(error, generation); }
    finally { this.#reads.delete(sequence); }
  }
  updateProject = async (input: BrowserUpdateProject): Promise<BrowserProjectMetadata> => {
    const generation = this.#generation, session = this.#session;
    if (!session || this.#snapshot.status !== 'connected') throw failure('unavailable');
    if (this.#mutation) throw failure('busy');
    if (input.projectId !== session.projectId) throw failure('forbidden');
    if (Object.keys(input).some(key => !['projectId', 'expectedRevision', 'operationId', 'name', 'objective'].includes(key)) || !identifier(input.operationId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || (!Object.hasOwn(input, 'name') && !Object.hasOwn(input, 'objective'))) throw failure('invalid_request');
    if ((Object.hasOwn(input, 'name') && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200)) || (Object.hasOwn(input, 'objective') && (typeof input.objective !== 'string' || input.objective.length > 4000))) throw failure('invalid_request');
    const body: BrowserUpdateProject = { projectId: input.projectId, expectedRevision: input.expectedRevision, operationId: input.operationId, ...(input.name === undefined ? {} : { name: input.name }), ...(input.objective === undefined ? {} : { objective: input.objective }) };
    this.#mutation = true;
    try {
      // No generated operation ID and no automatic mutation retry: the editor owns both.
      const result = await this.#json('rpc', { instanceId: this.instanceId, method: 'updateProject', body });
      if (!this.#active(generation)) throw failure('cancelled');
      const next = project(result, session.projectId);
      ++this.#readSequence;
      if (!this.#snapshot.state || next.revision >= this.#snapshot.state.project.revision) this.#emit({ state: Object.freeze({ project: next }) });
      void this.#read(generation).catch(() => {});
      return next;
    } catch (error) {
      const safe = this.#handle(error, generation);
      if (this.#active(generation)) void this.#read(generation).catch(() => {});
      throw safe;
    } finally { if (generation === this.#generation) this.#mutation = false; }
  };
  /** A distinct narrow RPC surface, never a pretend full WorkbenchClient. */
  materialCall = async <M extends BrowserMaterialMethod>(method: M, input: BrowserMaterialInput<M>): Promise<BrowserMaterialResult<M>> => {
    const generation = this.#generation, session = this.#session;
    if (!session) throw failure('unauthorized');
    if ((session.grant !== 'project-materials' && session.grant !== 'project-workbench' && session.grant !== 'project-replay') || input.projectId !== session.projectId || !BROWSER_MATERIAL_METHODS.includes(method)) throw failure('forbidden');
    const writes = BROWSER_MATERIAL_WRITE_METHODS.includes(method);
    // These reads need a write grant for ensure/repair, but a transport failure
    // is not a reason to recursively refresh the same directory.
    const userMutation = writes && !['workingMaterialDraft', 'materialCatalog', 'materialDrafts', 'materialRevisions'].includes(method);
    if (this.#snapshot.status !== 'connected' && (writes || this.#snapshot.status !== 'stale')) throw failure('unavailable');
    try {
      // The editor owns operation IDs and original parameters. Never replay an edit.
      const value = await this.#json('rpc', { instanceId: this.instanceId, method, body: input });
      if (!this.#active(generation)) throw failure('cancelled');
      const result=object(value); // Empty/malformed transport payloads must not become empty materials.
      if(writes)this.#writeAcks.set(result,{generation,projectId:session.projectId});
      return value as BrowserMaterialResult<M>;
    } catch (error) {
      const safe = error instanceof BrowserWorkbenchClientError ? error : failure('network');
      if (this.#active(generation)) {
        if (safe.code === 'unauthorized' || safe.code === 'forbidden') this.#handle(safe, generation);
        else if (safe.code === 'network' || safe.code === 'protocol') {
          this.#emit({ status: 'stale', error: safe.message });
          // A failed material read must not create a metadata-refresh -> material
          // read loop. Manual refresh or stream reconnection resumes reads.
          if (userMutation) void this.#read(generation).catch(() => {});
        }
        // Explicit domain failures leave the authenticated connection alone.
        // The editor displays them, and retry is always a user action.
      }
      throw userMutation && ['network', 'protocol', 'cancelled', 'unavailable', 'internal_error'].includes(safe.code) ? new BrowserWorkbenchClientError(safe.code, true) : safe;
    }
  };
  /** Read-only result calls never issue mutations or trigger refresh/read loops.
   * A result from a cleared/replaced session cannot reach the result view. */
  resultCall = async <M extends BrowserResultMethod>(method: M, input: BrowserResultInput<M>): Promise<BrowserResultResult<M>> => {
    const generation = this.#generation, session = this.#session;
    if (!session) throw failure('unauthorized');
    if (session.grant !== 'project-workbench' && session.grant !== 'project-replay' || input.projectId !== session.projectId || !BROWSER_RESULT_METHODS.includes(method)) throw failure('forbidden');
    if (!this.results.canRead()) throw failure('unavailable');
    try {
      const value = object(await this.#json('rpc', { instanceId: this.instanceId, method, body: input }));
      if (!this.#active(generation)) throw failure('cancelled');
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > BROWSER_RESULT_BUDGET.responseBytes) throw failure('protocol');
      if (method === 'execution' || method === 'executionReport') {
        const binding = object(value.binding);
        if (binding.projectId !== session.projectId || binding.executionId !== (input as BrowserResultInput<'execution'>).executionId ||
          (method === 'executionReport' && value.reportId !== (input as BrowserResultInput<'executionReport'>).reportId)) throw failure('protocol');
      } else if (!Array.isArray(value.items) || typeof value.outputTruncated !== 'boolean' || !Number.isSafeInteger(value.returnedBytes) ||
        (value.nextCursor !== undefined && (typeof value.nextCursor !== 'string' || !value.nextCursor.length || value.nextCursor.length > 4096))) throw failure('protocol');
      return value as unknown as BrowserResultResult<M>;
    } catch (error) {
      const safe = error instanceof BrowserWorkbenchClientError ? error : failure('network');
      if (this.#active(generation)) {
        if (safe.code === 'unauthorized' || safe.code === 'forbidden') this.#handle(safe, generation);
        else if (safe.code === 'network' || safe.code === 'protocol') this.#emit({ status: 'stale', error: safe.message });
      }
      throw safe;
    }
  };
  readonly replay: WebReplayClient = { call: (method, input, signal) => this.replayCall(method, input, signal) };
  replayCall = async <M extends WebReplayMethod>(method: M, input: WebReplayInput<M>, signal?: AbortSignal): Promise<WebReplayResult<M>> => {
    const generation = this.#generation, session = this.#session;
    if (!session || session.grant !== 'project-replay' || session.projectId !== input.projectId) throw failure('forbidden');
    if (this.#snapshot.status !== 'connected') throw failure('unavailable');
    const result = object(await this.#json('rpc', { instanceId: this.instanceId, method, body: input }, WEB_REPLAY_BUDGET.responseBytes, signal));
    if (!this.#active(generation)) throw failure('cancelled');
    if (result.projectId !== input.projectId || result.replayId !== input.replayId || result.generation !== input.generation || JSON.stringify(result.position) !== JSON.stringify(input.position) || new TextEncoder().encode(JSON.stringify(result)).byteLength > WEB_REPLAY_BUDGET.responseBytes) throw failure('protocol');
    return result as unknown as WebReplayResult<M>;
  };
  /** Bridge only an acknowledged write to its existing continuation. New user
   * writes still fail closed while stale, and no business request is replayed. */
  waitAfterMaterialWrite = async (acknowledgement: object): Promise<void> => {
    const scope=this.#writeAcks.get(acknowledgement);
    if(!scope||!this.#active(scope.generation)||this.#session?.projectId!==scope.projectId)throw failure('cancelled');
    if(!this.#streamActive)throw failure('unavailable');
    if(this.#snapshot.status==='connected')return;
    if(this.#snapshot.status!=='stale')throw failure('unavailable');
    await new Promise<void>((resolve,reject)=>{
      let settled=false;
      const finish=(error?:BrowserWorkbenchClientError)=>{
        if(settled)return;settled=true;clearTimeout(timeout);unsubscribe();
        if(error)reject(error);else resolve();
      };
      const check=()=>{
        if(!this.#active(scope.generation)||this.#session?.projectId!==scope.projectId){finish(failure('cancelled'));return;}
        if(!this.#streamActive){finish(failure('unavailable'));return;}
        if(this.#snapshot.status==='connected')finish();
      };
      const unsubscribe=this.subscribe(check);
      const timeout=setTimeout(()=>finish(failure('unavailable')),5000);
      check();
      // Prefer the already-running invalidation read. If there is none, perform
      // one read-only preflight; no polling, event reconnect or mutation retries.
      if(!settled&&!this.#reads.size)void this.#read(scope.generation).catch(error=>finish(error instanceof BrowserWorkbenchClientError?error:failure('network')));
    });
  };
  async #openStream(generation: number): Promise<void> {
    const session = this.#session; if (!session || !this.#active(generation) || this.#streamController) return;
    const controller = new AbortController(); this.#controllers.add(controller); this.#streamController = controller;
    try {
      const response = await this.#request('events', { instanceId: this.instanceId, projectId: session.projectId }, controller);
      if (!this.#active(generation)) { await response.body?.cancel(); return; }
      if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw failure('protocol');
      this.#streamActive = true;
      // Install the reader before refreshing so invalidations cannot fall between subscription and read.
      void this.#consume(response.body, controller, generation, session.projectId);
      await this.#read(generation);
    } catch (error) {
      controller.abort(); this.#controllers.delete(controller);
      if (this.#streamController === controller) this.#streamController = undefined;
      if (this.#active(generation)) { this.#streamActive = false; this.#handle(error, generation); this.#scheduleReconnect(generation); }
      throw error;
    }
  }
  async #consume(body: ReadableStream<Uint8Array>, controller: AbortController, generation: number, projectId: string): Promise<void> {
    const reader = body.getReader();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    controller.signal.addEventListener('abort', cancel, { once: true });
    let pending = ''; const decoder = new TextDecoder();
    let refreshing = false, invalidated = false;
    const refreshInvalidation = async () => {
      invalidated = true;
      if (refreshing) return;
      refreshing = true;
      try {
        while (invalidated && this.#active(generation) && !controller.signal.aborted) {
          invalidated = false;
          await this.#read(generation).catch(() => {});
        }
      } finally { refreshing = false; }
    };
    try {
      while (this.#active(generation) && !controller.signal.aborted) {
        const chunk = await reader.read();
        if (!this.#active(generation) || controller.signal.aborted) return;
        if (chunk.done) throw failure('network');
        pending += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
        if (pending.length > 16_384) throw failure('protocol');
        let boundary: number;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const event = frame.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
          if (event !== 'scope-invalidated') continue;
          let value: Record<string, unknown>;
          try { value = object(JSON.parse(frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'))); } catch { throw failure('protocol'); }
          if (value.projectId !== projectId || Object.keys(value).length !== 1) throw failure('protocol');
          // Even a coalesced notification invalidates a read already in flight.
          ++this.#readSequence;
          this.#emit({ status: 'stale' });
          void refreshInvalidation();
        }
      }
    } catch (error) {
      if (this.#active(generation) && !controller.signal.aborted) { this.#streamActive = false; this.#handle(error, generation); }
    } finally {
      controller.signal.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => {}); reader.releaseLock();
      this.#controllers.delete(controller);
      if (this.#streamController === controller) this.#streamController = undefined;
      if (this.#active(generation) && !controller.signal.aborted) { this.#streamActive = false; this.#scheduleReconnect(generation); }
    }
  }
  #scheduleReconnect(generation: number): void {
    if (!this.#active(generation) || this.#reconnect || this.#attempt >= this.#retryDelays.length) return;
    const delay = this.#retryDelays[this.#attempt++];
    this.#reconnect = setTimeout(() => { this.#reconnect = undefined; void this.#openStream(generation).catch(() => {}); }, delay);
  }
}
