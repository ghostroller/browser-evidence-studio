import type { DatasetIdentity } from './execution';
import type { BrowserSessionStatus } from '../main/browser/browser-controls';
import type { Project, Profile } from '../main/services/workspace-management';
import type { NODE_HOST_CAPABILITIES } from './host-capabilities';
/** Separate short-lived local-owner surface. Never exposed by Electron or project workbench grants. */
export interface NodeOwnerSessionIdentity {projectId:string;profileId:string;sessionId:string;leaseEpoch:number}
export interface NodeOwnerIdentity extends NodeOwnerSessionIdentity {
  pageId:string;targetId:string;generation:number;
}
/** Launch-time capability, not an owner RPC setting or a noninterference guarantee. */
export interface NodeExecutionPolicy {
  executionMode:'disabled'|'cooperative-dev-test';
  inputIsolation:'none';
  physicalInputExclusive:false;
  interferenceDetection:'partial';
  humanHandoff:'unsupported';
}
export interface NodeOwnerState {
  instanceId:string;backendKind:'node';runtimeProvider:'chromium';providerStatus:'not-open'|'connected'|'disconnected'|'renderer-failed';
  capabilities:NodeExecutionPolicy&typeof NODE_HOST_CAPABILITIES;
  projects:Project[];profiles:Profile[];
  session:BrowserSessionStatus|null;
  active:null|{id:string;projectId:string;profileId:string;controller:string;leaseEpoch:number;capture:string;execution:string;locked:boolean;selectedPageId:string;checkpoint:unknown};
  runs:Array<{id:string;projectId?:string;profileId?:string;status?:string;kind?:string;capture?:string;execution?:string}>;
  validations:Array<{id:string;runId:string;projectId:string;status:string;executionId?:string;validation?:unknown}>;
  validationStarting:null|{validationId:string;validationRunId:string};
}
export interface NodeOwnerMethods {
  state:{input:Record<string,never>;output:NodeOwnerState};
  createProject:{input:{name:string;objective:string;scriptDirectory?:string;operationId:string};output:Project};
  registerWorkflow:{input:{projectId:string;expectedRevision:number;scriptDirectory:string;operationId:string};output:Project};
  createProfile:{input:{projectId:string;name:string;entryUrl:string;operationId:string};output:Profile};
  openEnvironment:{input:{projectId:string;profileId:string};output:BrowserSessionStatus};
  startRun:{input:{projectId:string;profileId:string;expectedSessionId:string|null;leaseEpoch?:number;url:string};output:unknown};
  browserCommand:{input:(NodeOwnerSessionIdentity&{command:'new';url?:string})|(NodeOwnerIdentity&{command:'select'|'close'|'navigate'|'back'|'forward'|'reload'|'stop';url?:string});output:unknown};
  checkpoint:{input:NodeOwnerIdentity&{key:string;title:string;description:string};output:unknown};
  seal:{input:NodeOwnerSessionIdentity;output:unknown};
  closeSession:{input:NodeOwnerSessionIdentity;output:{closed:true;sessionId:string;profilePersistence:'flushed'|'unconfirmed';warning?:string}};
  saveProfile:{input:NodeOwnerSessionIdentity;output:unknown};
  endInterruptedSession:{input:NodeOwnerSessionIdentity;output:{closed:true;sessionId:string;recordingId?:string;status:'interrupted';cleanupFailures:number}};
  startValidation:{input:NodeOwnerIdentity&{materialRevisionId:string;materialContentHash:string;executionMode:'current-page-test'|'from-start-validation';input:unknown;startUrl?:string};output:unknown};
  stopRunner:{input:{sessionId:string};output:unknown};
  executionDatasets:{input:{projectId:string;executionId:string};output:{items:Array<{executionId:string;attemptId:string;datasetId:string;status:string;committedRecords:number;committedBatches:number;diagnostic?:{code:string;message:string}}>}};
  assessExecution:{input:{projectId:string;executionId:string;datasetIdentities:DatasetIdentity[]};output:unknown};
  revokeOwner:{input:Record<string,never>;output:{revoked:true}};
  pairWorkbench:{input:{projectId:string};output:{ticket:string;expiresAt:number;instanceId:string}};
  revokeWorkbench:{input:Record<string,never>;output:{revoked:true}};
  shutdown:{input:Record<string,never>;output:{closing:true}};
}
export type NodeOwnerMethod=keyof NodeOwnerMethods;
export type NodeOwnerInput<M extends NodeOwnerMethod>=NodeOwnerMethods[M]['input'];
export type NodeOwnerOutput<M extends NodeOwnerMethod>=NodeOwnerMethods[M]['output'];
