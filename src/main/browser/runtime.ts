import type { EvidenceStore } from '@/evidence/store';
import type { BrowserDownloadStatus } from './browser-controls';
import { ensure } from '@/shared/errors';

export type RuntimeProvider = 'electron' | 'chromium';
/** Missing provider is the historical Electron format. Reading does not migrate it. */
export function profileProvider(profile: { provider?: RuntimeProvider;storageRef?:string }): RuntimeProvider {
  ensure(profile.provider === undefined || profile.provider === 'electron' || profile.provider === 'chromium', 'Unsupported browser environment provider', 409);
  return profile.provider ?? 'electron';
}
export function assertProfileProvider(profile: {provider?:RuntimeProvider;storageRef?:string}, provider:RuntimeProvider) {
  ensure(profileProvider(profile) === provider, 'This environment belongs to a different browser provider; create a new environment. Existing storage was not migrated.', 409);
  if(provider==='chromium')ensure(typeof profile.storageRef==='string'&&/^chromium:[a-f0-9-]{36}$/.test(profile.storageRef),'Invalid dedicated Chromium storage reference',409);
}
export interface PageStatusReader {
  getURL():string; getTitle():string;
  navigationHistory:{canGoBack():boolean;canGoForward():boolean};
  isLoadingMainFrame():boolean;getZoomFactor():number;
}
/** Provider presentation only. Domain capture, ownership and runner state live in StudioCore. */
export interface BrowserPresentation<V> {
  lock(value:boolean):void;
  awaitInput():Promise<void>;
  show(view?:V):void;
  remove(view:V):void;
  closeViews():void;
  assertInputReady(view:V):void;
  withBackgroundInteraction<T>(view:V,run:()=>Promise<T>):Promise<T>;
}
export interface RuntimeDownloads {
  list():BrowserDownloadStatus[];
  beginRecording(recordingId:string,store:EvidenceStore):void;
  finishRecording():Promise<void>;
  dispose():Promise<void>;
  cancel(id:string):void;
  location(id:string):string;
}
