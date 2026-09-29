import type { CDPSession } from 'puppeteer-core';
import { RESOURCE_MAX_BYTES } from '@/resources/archive';

interface Sheet { id:string;frameId:string;loaderId:string;url:string;version:number;addedAt:number }

/** Page.getResourceContent may use a response-default decoder which differs
 * from the stylesheet's document encoding. Read the renderer's decoded text,
 * never reverse a suspected mojibake string or reacquire it from the network. */
export class StylesheetTextCapture {
  private readonly sheets=new Map<string,Sheet>();
  private readonly listeners=new Set<()=>void>();
  private epoch=0;
  private finishing=false;
  get revision(){return this.epoch;}
  constructor(private readonly cdp:CDPSession,private readonly loader:(frameId:string)=>string|undefined){}
  async start(){
    this.cdp.on('CSS.styleSheetAdded',({header})=>{
      const loaderId=this.loader(header.frameId);
      if(!loaderId||header.isInline||!header.sourceURL||header.sourceURL.length>16384||this.sheets.size>=1000)return;
      this.epoch++;
      this.sheets.set(header.styleSheetId,{id:header.styleSheetId,frameId:header.frameId,loaderId,url:header.sourceURL,version:0,addedAt:Date.now()});
      for(const notify of this.listeners)notify();
    });
    this.cdp.on('CSS.styleSheetRemoved',({styleSheetId})=>{if(this.sheets.delete(styleSheetId))this.epoch++;});
    this.cdp.on('CSS.styleSheetChanged',({styleSheetId})=>{const sheet=this.sheets.get(styleSheetId);if(sheet){sheet.version++;this.epoch++;}});
    this.cdp.on('Page.frameNavigated',({frame})=>{for(const [id,sheet] of this.sheets)if(!frame.parentId||sheet.frameId===frame.id)this.sheets.delete(id);for(const notify of this.listeners)notify();});
    this.cdp.on('Disconnected',()=>this.finishWaiting());
    await this.cdp.send('DOM.enable');await this.cdp.send('CSS.enable');
  }
  finishWaiting(){this.finishing=true;for(const notify of this.listeners)notify();}
  async read(frameId:string,loaderId:string,url:string,requestStartedAt?:string):Promise<{data:Buffer;styleSheetId:string}> {
    const started=requestStartedAt===undefined?undefined:Date.parse(requestStartedAt);
    const candidates=()=>[...this.sheets.values()].filter(sheet=>sheet.frameId===frameId&&sheet.loaderId===loaderId&&sheet.url===url&&(started===undefined||sheet.addedAt>=started));
    if(started!==undefined&&!candidates().length&&!this.finishing&&this.loader(frameId)===loaderId){
      // Main-thread parsing can lag loadingFinished. Wait for its event within
      // the existing five-second capture boundary; no polling or network retry.
      await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);this.listeners.delete(ready);resolve();},ready=()=>{if(candidates().length||this.finishing||this.loader(frameId)!==loaderId)done();},timer=setTimeout(done,5000);this.listeners.add(ready);});
    }
    const matches=candidates();
    if(this.loader(frameId)!==loaderId)throw new Error('renderer-stylesheet-scope-changed');
    if(!matches.length&&this.finishing)throw new Error('renderer-stylesheet-unobserved-at-capture-stop');
    if(matches.length!==1)throw new Error(matches.length?'renderer-stylesheet-version-ambiguous':'renderer-stylesheet-unavailable');
    const sheet=matches[0],version=sheet.version;
    if(this.loader(frameId)!==loaderId||started!==undefined&&version!==0)throw new Error('renderer-stylesheet-scope-changed');
    const {text}=await this.cdp.send('CSS.getStyleSheetText',{styleSheetId:sheet.id},{timeout:5000});
    if(this.loader(frameId)!==loaderId||this.sheets.get(sheet.id)!==sheet||sheet.version!==version)throw new Error('renderer-stylesheet-scope-changed');
    if(text.length>RESOURCE_MAX_BYTES||Buffer.byteLength(text)>RESOURCE_MAX_BYTES)throw new Error('resource-byte-budget');
    return {data:Buffer.from(text,'utf8'),styleSheetId:sheet.id};
  }
}
