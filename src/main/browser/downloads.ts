import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DownloadItem, Session, WebContents } from 'electron';
import type { EvidenceStore } from '@/evidence/store';
import type { BrowserDownloadStatus } from './browser-controls';
import { ensure } from '@/shared/errors';

/** Session downloads outlive a recording. Evidence captures the writer at start. */
export class SessionDownloads {
  private readonly records=new Map<string,{status:BrowserDownloadStatus;item:DownloadItem;store?:EvidenceStore}>();
  private readonly writes=new Set<Promise<unknown>>();
  private recording?:{id:string;store:EvidenceStore};
  private listener?: (event:Electron.Event,item:DownloadItem,wc:WebContents)=>void;
  constructor(private readonly session:Session,private readonly directory:string,private readonly pageId:(wc:WebContents)=>string|undefined,private readonly changed:()=>void){}
  async start(){
    await mkdir(this.directory,{recursive:true});
    this.listener=(event,item,wc)=>{
      const pageId=this.pageId(wc);if(!pageId){event.preventDefault();return;}
      const id=randomUUID(),filename=path.basename(item.getFilename()).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')||'download';
      const status:BrowserDownloadStatus={id,pageId,filename,path:path.join(this.directory,id+'-'+filename),receivedBytes:0,totalBytes:item.getTotalBytes(),state:'progressing',startedAt:new Date().toISOString(),recordingId:this.recording?.id,evidence:this.recording?'pending':undefined};
      const record={status,item,store:this.recording?.store};this.records.set(id,record);item.setSavePath(status.path);
      item.on('updated',(_event,state)=>{status.state=state;status.receivedBytes=item.getReceivedBytes();status.totalBytes=item.getTotalBytes();this.changed();});
      item.once('done',(_event,state)=>{
        status.state=state;status.receivedBytes=item.getReceivedBytes();const store=record.store;
        if(store){const write=this.import(record,store).catch(error=>{status.evidence='failed';status.error=String(error);return store.appendEvent({type:'gap',source:'electron',pageId,data:{reason:'download-capture-failed',error:String(error)}}).catch(()=>{});}).finally(()=>{this.writes.delete(write);this.changed();});this.writes.add(write);}
        this.changed();
      });
      // Keep bounded metadata; unfinished files and current evidence are never evicted.
      for(const [key,value] of this.records){if(this.records.size<=100)break;if(value.status.state!=='progressing'&&value.status.evidence!=='pending')this.records.delete(key);}
      this.changed();
    };
    this.session.on('will-download',this.listener);
  }
  beginRecording(id:string,store:EvidenceStore){this.recording={id,store};}
  async finishRecording(){
    const previous=this.recording;this.recording=undefined;
    for(const record of this.records.values())if(record.store===previous?.store&&['progressing','interrupted'].includes(record.status.state)){
      record.store=undefined;record.status.evidence='excluded';
      await previous?.store.appendEvent({type:'gap',source:'electron',pageId:record.status.pageId,data:{reason:'download-not-finished-at-recording-end',downloadId:record.status.id}});
    }
    await Promise.allSettled(this.writes);this.changed();
  }
  private async import(record:{status:BrowserDownloadStatus;item:DownloadItem},store:EvidenceStore){
    const {status,item}=record,source={pageId:status.pageId,url:item.getURL(),filename:status.filename};
    if(status.state!=='completed'){status.evidence='failed';await store.appendEvent({type:'gap',source:'electron',data:{reason:'download-'+status.state,...source}});return;}
    const size=(await stat(status.path)).size;
    const artifact=await store.putArtifact(size>64*1024*1024?{kind:'download',mediaType:item.getMimeType()||'application/octet-stream',captureStatus:'excluded',reason:'Download exceeds the 64 MiB evidence import budget; local file retained',source:{...source,downloadBytes:size},metadata:{localDownloadId:status.id}}:{kind:'download',mediaType:item.getMimeType()||'application/octet-stream',data:await readFile(status.path),source});
    status.evidence=artifact.captureStatus==='excluded'?'excluded':'imported';await store.appendEvent({type:'download',source:'electron',artifactRefs:[artifact.id],data:{captureStatus:artifact.captureStatus}});
  }
  list(){return [...this.records.values()].reverse().map(record=>({...record.status}));}
  cancel(id:string){const record=this.records.get(id);ensure(record&&['progressing','interrupted'].includes(record.status.state),'下载已结束或不存在',409);record.item.cancel();}
  location(id:string){const record=this.records.get(id);ensure(record?.status.state==='completed','只有已完成下载可定位',409);return record.status.path;}
  async dispose(){if(this.listener)this.session.removeListener('will-download',this.listener);this.listener=undefined;for(const record of this.records.values())if(['progressing','interrupted'].includes(record.status.state))record.item.cancel();await Promise.allSettled(this.writes);}
}
