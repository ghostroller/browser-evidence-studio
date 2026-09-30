import type { eventWithTime } from '@rrweb/types';
import type { HistoricalElementRef, ReplayPosition } from './recording';
export const WEB_REPLAY_BUDGET = Object.freeze({ requestBytes: 16384, responseBytes: 16 * 1024 * 1024, eventBytes: 8 * 1024 * 1024, resourceBytes: 8 * 1024 * 1024, resources: 128 });
export interface WebReplayIdentity { projectId: string; replayId: string; generation: number; position: ReplayPosition }
export interface WebReplayBundle extends WebReplayIdentity {
  events: eventWithTime[];
  offsets: Array<{ position: ReplayPosition; offset: number }>;
  resources: Array<{ key: string; mime: string; base64: string }>;
  diagnostics: Array<{ status: string; reason: string }>;
}
export interface WebReplayMethods {
  webReplayBundle: { input: WebReplayIdentity; result: WebReplayBundle };
  webReplaySelection: { input: WebReplayIdentity & { nodeId: number }; result: WebReplayIdentity & { target: HistoricalElementRef } };
}
export type WebReplayMethod = keyof WebReplayMethods;
export type WebReplayInput<M extends WebReplayMethod> = WebReplayMethods[M]['input'];
export type WebReplayResult<M extends WebReplayMethod> = WebReplayMethods[M]['result'];
export interface WebReplayClient { call<M extends WebReplayMethod>(method: M, input: WebReplayInput<M>, signal?: AbortSignal): Promise<WebReplayResult<M>> }
