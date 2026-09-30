import type { MaterialContent } from '@/contracts/materials';
import type { BoundedPage } from '@/contracts/recording';
import type { BrowserMaterialInput, BrowserMaterialMethod, BrowserMaterialResult } from '@/contracts/browser-materials';
import type { MaterialCollection, MaterialEntityCollection, MaterialEntityResult } from '@/contracts/workbench-project';
import type { WorkbenchClient } from '@/contracts/workbench';

/** The shared editor needs only this material surface. Native capture, source-node
 * inspection and implementation tools are separate, optional Electron delegates. */
export type MaterialEditorMethod = Exclude<BrowserMaterialMethod, 'materialRecordings' | 'recordingStreams' | 'recordingPositions'>;
type Result<M extends MaterialEditorMethod> = M extends 'workingMaterialDraft' ? { draftId: string } : BrowserMaterialResult<M>;
type WithoutProject<T> = T extends unknown ? Omit<T, 'projectId'> & { projectId?: string } : never;
type Input<M extends MaterialEditorMethod> = WithoutProject<BrowserMaterialInput<M>>;
type OptionalMethod = { [M in MaterialEditorMethod]: {} extends Input<M> ? M : never }[MaterialEditorMethod];
export interface MaterialEditorCall {
  <M extends MaterialEditorMethod>(method: M, body: BrowserMaterialInput<M>): Promise<Result<M>>;
}
export interface ScopedMaterialCall {
  <C extends MaterialCollection>(method: 'materialCollection', body: Input<'materialCollection'> & { collection: C }): Promise<BoundedPage<MaterialContent[C][number]>>;
  <C extends MaterialEntityCollection>(method: 'materialEntity', body: Input<'materialEntity'> & { collection: C }): Promise<Omit<MaterialEntityResult, 'item'> & { item: MaterialContent[C][number] }>;
  <M extends MaterialEditorMethod>(method: M, body: Input<M>): Promise<Result<M>>;
  <M extends OptionalMethod>(method: M): Promise<Result<M>>;
}
export interface EditorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface MaterialWorkbenchClient {
  call: MaterialEditorCall;
  storage: EditorStorage;
  host: 'browser' | 'electron';
  canEdit(): boolean;
  /** Only a successful write result from this same session may bridge to its
   * remaining UI steps. It waits for authority; it never retries a mutation. */
  waitAfterWrite?(acknowledgement: object): Promise<void>;
}
export function scopedMaterialCall(client: MaterialWorkbenchClient, projectId: string): ScopedMaterialCall {
  return (<M extends MaterialEditorMethod>(method: M, body?: Input<M>) =>
    client.call(method, { ...body, projectId } as BrowserMaterialInput<M>)) as ScopedMaterialCall;
}
export function electronMaterialClient(client: WorkbenchClient): MaterialWorkbenchClient {
  return { call: client.call as MaterialEditorCall, host: 'electron', storage: localStorage, canEdit: () => true };
}
/** A browser session owns and erases this map. It never uses Web Storage. */
export function memoryEditorStorage(): EditorStorage & { clear(): void } {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); }, clear: () => values.clear() };
}
