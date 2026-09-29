import { ensure } from '@/shared/errors';

export interface BrowserPageStatus {
  pageId:string; targetId:string; webContentsId:number; generation:number; url:string; title:string;
  openerPageId?:string; inspecting:boolean; canGoBack:boolean; canGoForward:boolean; loading:boolean;
  zoomFactor:number; loadError?:{kind:'url'|'network'|'certificate'|'denied'|'renderer';url:string;message:string;code?:number};
  find?:{requestId:number;activeMatchOrdinal:number;matches:number};
  dialog?:{id:string;type:string;message:string;defaultValue:string};
}
export interface BrowserDownloadStatus {
  id:string;pageId:string;filename:string;path:string;receivedBytes:number;totalBytes:number;
  state:'progressing'|'interrupted'|'completed'|'cancelled';startedAt:string;recordingId?:string;
  evidence?:'pending'|'imported'|'excluded'|'failed';error?:string;
}
export interface BrowserCommand {
  sessionId:string;leaseEpoch:number;pageId?:string;targetId?:string;generation?:number;
  command:'new'|'reopen'|'select'|'close'|'navigate'|'back'|'forward'|'reload'|'stop'|'find'|'find-close'|'zoom'|'dialog'|'download-cancel'|'download-show'|'notice-dismiss';
  url?:string;text?:string;forward?:boolean;findNext?:boolean;zoomFactor?:number;dialogId?:string;accept?:boolean;downloadId?:string;
}
export interface BrowserSessionStatus {
  sessionId:string;projectId:string;profileId:string;recordingId?:string;controller:string;leaseEpoch:number;locked:boolean;
  selectedPageId:string;pages:BrowserPageStatus[];closedPageCount:number;downloads:BrowserDownloadStatus[];
  notice?:string;uiAction?:{id:string;action:'address'|'find'|'save'|'cancel';pageId:string};
}
export function browserUrl(input:unknown):string {
  ensure(typeof input==='string'&&input.trim().length>0&&input.length<=4096,'请输入 HTTP(S) 网址');
  let value=input.trim();if(value==='about:blank')return value;
  if(!/^[a-z][a-z\d+.-]*:/i.test(value)||/^localhost:\d/i.test(value))value='https://'+value;
  let parsed:URL;try{parsed=new URL(value);}catch{throw new Error('网址格式无效；请输入 HTTP(S) 地址');}
  ensure(['http:','https:'].includes(parsed.protocol)&&!!parsed.hostname&&!parsed.username&&!parsed.password&&!/\s/.test(value),'只支持 HTTP(S) 地址；不支持脚本、本地路径或带密码的网址');
  return parsed.href;
}
export function browserShortcut(input:{type:string;key:string;control?:boolean;meta?:boolean;shift?:boolean;alt?:boolean}):string|undefined {
  if(input.type!=='keyDown'||input.alt)return;
  if(input.key==='Escape')return 'cancel';
  if(!input.control&&!input.meta)return;
  const key=input.key.toLowerCase();
  if(key==='t')return input.shift?'reopen':'new';
  return ({l:'address',w:'close',r:'reload',f:'find',s:'save','+':'zoom-in','=':'zoom-in','-':'zoom-out','0':'zoom-reset'} as Record<string,string>)[key];
}
