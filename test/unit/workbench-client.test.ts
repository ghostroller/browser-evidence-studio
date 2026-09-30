import { describe, expect, test, vi } from 'vitest';
import type { WorkbenchClient, WorkbenchInput, WorkbenchMethod, WorkbenchResult } from '@/contracts/workbench';
import { createElectronWorkbenchClient, WorkbenchStartupError, type ElectronWorkbenchBridge } from '@/renderer/lib/electron-workbench-client';
import { requireNativePresentation, scopedWorkbenchCall, WorkbenchCapabilityError } from '@/renderer/lib/workbench-client';

function transport() {
  return { call: vi.fn(async (_method: WorkbenchMethod, _body?: unknown): Promise<unknown> => ({})), bounds: vi.fn(), onChanged: vi.fn((_listener: () => void) => vi.fn()) };
}
describe('Electron WorkbenchClient contract', () => {
  test('forwards exact bodies, operation identity and asynchronous results without scheduling or rewriting', async () => {
    const bridge = transport();
    let resolve!: (result: unknown) => void;
    const pending = new Promise(done => { resolve = done; });
    bridge.call.mockReturnValueOnce(pending);
    const client = createElectronWorkbenchClient(bridge);
    const body = { projectId: 'project', name: 'profile', operationId: 'same-operation' };
    const request = client.call('createProfile', body);
    expect(request).toBe(pending);
    expect(bridge.call).toHaveBeenCalledExactlyOnceWith('createProfile', body);
    expect(bridge.call.mock.calls[0][1]).toBe(body);
    const result = { id: 'profile', projectId: 'project', name: 'profile', loginStatus: 'unknown' };
    resolve(result);
    expect(await request).toBe(result);
    expect(body).toEqual({ projectId: 'project', name: 'profile', operationId: 'same-operation' });
  });
  test('defaults omitted bodies to a fresh empty object and preserves call order', async () => {
    const bridge = transport(), client = createElectronWorkbenchClient(bridge);
    await client.call('state'); await client.call('uiPreferences');
    const explicit = {};
    await client.call('state', explicit);
    expect(bridge.call.mock.calls).toEqual([['state', {}], ['uiPreferences', {}], ['state', {}]]);
    expect(bridge.call.mock.calls[0][1]).not.toBe(bridge.call.mock.calls[1][1]);
    expect(bridge.call.mock.calls[2][1]).toBe(explicit);
  });
  test('propagates the original rejected error without retries', async () => {
    const bridge = transport(), error = new Error('source generation changed');
    bridge.call.mockRejectedValueOnce(error);
    await expect(createElectronWorkbenchClient(bridge).call('history', { runId: 'run' })).rejects.toBe(error);
    expect(bridge.call).toHaveBeenCalledTimes(1);
  });
  test('forwards changed callbacks and the exact unsubscribe lifetime', () => {
    const bridge = transport(), listener = vi.fn();
    const stop = vi.fn(); bridge.onChanged.mockReturnValueOnce(stop);
    const dispose = createElectronWorkbenchClient(bridge).onChanged(listener);
    expect(bridge.onChanged).toHaveBeenCalledExactlyOnceWith(listener);
    bridge.onChanged.mock.calls[0][0](); expect(listener).toHaveBeenCalledTimes(1);
    expect(dispose).toBe(stop); dispose(); expect(stop).toHaveBeenCalledTimes(1);
  });
  test('preserves fire-and-forget bounds and explicit native presentation requests', async () => {
    const bridge = transport(), native = requireNativePresentation(createElectronWorkbenchClient(bridge));
    const bounds = { x: 12, y: 34, width: 560, height: 400 };
    expect(native.bounds(bounds)).toBeUndefined();
    expect(bridge.bounds).toHaveBeenCalledExactlyOnceWith(bounds);
    expect(bridge.bounds.mock.calls[0][0]).toBe(bounds);
    const body = { reason: 'layout' as const, hidden: true };
    await native.set(body);
    expect(bridge.call).toHaveBeenCalledExactlyOnceWith('presentation', body);
  });
  test('fails explicitly for missing or incomplete preload bridges', () => {
    expect(() => createElectronWorkbenchClient(undefined)).toThrow(WorkbenchStartupError);
    for (const key of ['call', 'bounds', 'onChanged'] as const) {
      const incomplete = { ...transport(), [key]: undefined };
      expect(() => createElectronWorkbenchClient(incomplete as unknown as ElectronWorkbenchBridge)).toThrow(WorkbenchStartupError);
    }
  });
  test('unsupported native capability fails instead of silently acknowledging it', () => {
    const client = createElectronWorkbenchClient(transport());
    expect(() => requireNativePresentation({ ...client, nativePresentation: null })).toThrow(WorkbenchCapabilityError);
  });
  test('typed project scope preserves explicit identity precedence and body data', async () => {
    const bridge = transport(), call = scopedWorkbenchCall(createElectronWorkbenchClient(bridge), { projectId: 'default', executionId: 'execution' });
    const body = { projectId: 'explicit', draftId: 'draft', expectedDraftRevision: 2, operationId: 'operation' };
    await call('copyMaterialDraft', body);
    expect(bridge.call).toHaveBeenCalledExactlyOnceWith('copyMaterialDraft', { projectId: 'explicit', executionId: 'execution', draftId: 'draft', expectedDraftRevision: 2, operationId: 'operation' });
    expect(body).toEqual({ projectId: 'explicit', draftId: 'draft', expectedDraftRevision: 2, operationId: 'operation' });
    await call('materialCatalog');
    expect(bridge.call.mock.calls[1]).toEqual(['materialCatalog', { projectId: 'default', executionId: 'execution' }]);
  });
});

// Compile-only checks: invalid method names, bodies and result use must fail.
function typeContract(client: WorkbenchClient) {
  // @ts-expect-error There is no string escape hatch for unknown methods.
  client.call('unknownOperation');
  // @ts-expect-error A recording identity is mandatory.
  client.call('history');
  // @ts-expect-error A navigation generation is numeric.
  client.call('browserCommand', { sessionId: 's', leaseEpoch: 1, command: 'reload', generation: 'old' });
  // @ts-expect-error Mutation revision conflicts cannot be omitted.
  client.call('updateProject', { projectId: 'p', name: 'new' });
  client.call('recoverRunIndexes', { runId: 'sealed', expectedFingerprint: null });
  // @ts-expect-error An absent writer fingerprint is null, not undefined.
  client.call('recoverRunIndexes', { runId: 'sealed', expectedFingerprint: undefined });
  const read = client.call('syntheticSite');
  read.then(result => {
    const url: string = result.url; void url;
    // @ts-expect-error Results are not any.
    const invalid: number = result.url; void invalid;
  });
  const booleanSchema: WorkbenchResult<'workflowInputSchema'> = { schema: false };
  const noSchema: WorkbenchResult<'workflowInputSchema'> = { schema: null };
  // @ts-expect-error IPC schema payloads are JSON values, not undefined.
  const invalidSchema: WorkbenchResult<'workflowInputSchema'> = { schema: undefined };
  void booleanSchema; void noSchema; void invalidSchema;
  client.call('materialDrafts', { projectId: 'p' }).then(page => {
    const row = page.items[0];
    // @ts-expect-error Unavailable draft entries have no revision payload.
    const beforeNarrowing: number = row.draftRevision; void beforeNarrowing;
    if (row.status === 'available') { const revision: number = row.draftRevision; void revision; }
    else { const reason: string = row.reason; void reason; }
  });
  client.call('materialRevisions', { projectId: 'p' }).then(page => {
    const row = page.items[0];
    // @ts-expect-error Unavailable fixed entries have no verified content hash.
    const beforeNarrowing: string = row.contentHash; void beforeNarrowing;
    if (row.status === 'available') { const hash: string = row.contentHash; void hash; }
    else { const reason: string = row.reason; void reason; }
  });
  const scoped = scopedWorkbenchCall(client, { projectId: 'p' });
  scoped('materialCollection', { kind: 'draft', draftId: 'd', collection: 'checkpoints' }).then(page => {
    const title: string = page.items[0].title; void title;
    // @ts-expect-error Checkpoints are not field definitions.
    page.items[0].valueType;
  });
  scoped('materialCollection', { kind: 'revision', revisionId: 'r', contentHash: 'hash', collection: 'fields' });
  // @ts-expect-error Draft selection needs a draft identity.
  scoped('materialCollection', { kind: 'draft', collection: 'fields' });
  // @ts-expect-error Fixed revisions require the expected hash.
  scoped('materialCollection', { kind: 'revision', revisionId: 'r', collection: 'fields' });
  // @ts-expect-error Another branch's ID cannot replace the draft identity.
  scoped('materialEntity', { kind: 'draft', revisionId: 'r', entityId: 'e', collection: 'fields' });
}
void typeContract;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type UntypedResults = { [M in WorkbenchMethod]: IsAny<WorkbenchResult<M>> extends true ? M : never }[WorkbenchMethod];
const allResultsHaveTypes: UntypedResults extends never ? true : never = true;
void allResultsHaveTypes;

type UntypedInputs = { [M in WorkbenchMethod]: IsAny<WorkbenchInput<M>> extends true ? M : never }[WorkbenchMethod];
const allInputsHaveTypes: UntypedInputs extends never ? true : never = true;
const noStringFallback: string extends WorkbenchMethod ? never : true = true;
void allInputsHaveTypes; void noStringFallback;
