/** Type-only client port. All operations use the existing studio.call channel. */
import type { HistoricalElementRef, ReplayPosition, ReplayState } from '@/contracts/recording';
import type { TaskCapability, TaskAuthorization } from './task-authorization';
export type { MaterialEdit } from './project-materials';
export type { TaskCapability, TaskAuthorization } from './task-authorization';
export type { ExecutionSummary, ReportSummary } from './project-executions';
export interface AuthorizeTaskInput {
  projectId: string; capabilities: TaskCapability[]; durationMs: number; maxOperations: number;
  /** Required only for live-browser capabilities. The UI explicitly transfers control. */
  sessionId?: string; profileId?: string; leaseEpoch?: number;
  pageIds?: string[]; origins?: string[];
}
export interface ReplayHostState {
  replayId: string; projectId: string; generation: number; status: 'loading' | 'ready' | 'failed' | 'closed';
  position?: ReplayPosition; state?: ReplayState; selection?: HistoricalElementRef;
  selecting: boolean; selectionSequence: number; error?: string;
  resources?: { status:'loading'|'ready'|'partial'; blockedRequests:number; failures:Array<{resourceId?:string;generation:number;code?:string;name:string;message:string}> };
  selectionError?: string;
}
export interface ReplayOpenInput { projectId: string; position: ReplayPosition }
export interface ReplaySeekInput extends ReplayOpenInput { replayId: string }
export interface ReplaySelectInput { replayId: string; enabled: boolean }
export interface ReplayCloseInput { replayId: string }
export interface TaskAuthorizationResult extends TaskAuthorization { leaseEpoch?: number }
// call('openReplay', ReplayOpenInput): Promise<ReplayHostState>
// call('seekReplay', ReplaySeekInput): Promise<ReplayHostState>
// call('replayStatus', { replayId }): Promise<ReplayHostState>
// call('selectReplay', ReplaySelectInput): Promise<ReplayHostState>
// call('closeReplay', ReplayCloseInput): Promise<ReplayHostState>
// Every seek is exact eventSeq; UI play advances positions/time through seekReplay.
// Poll replayStatus for selections; stale seek generations cannot publish selection.
