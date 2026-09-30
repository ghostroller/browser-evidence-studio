import type { CDPSession, Page } from 'puppeteer-core';
import type { BrowserPresentation, PageStatusReader } from '../main/browser/runtime';
import { ensure } from '@/shared/errors';
export interface ChromiumView extends PageStatusReader {
  page:Page;cdp:CDPSession;title:string;loading:boolean;back:boolean;forward:boolean;inputBlocked:boolean;
}
export class ChromiumPresentation implements BrowserPresentation<ChromiumView> {
  constructor(private readonly cooperativeInput=false){}
  private views=new Set<ChromiumView>();
  private locked=false;
  private tail:Promise<void>=Promise.resolve();
  private failures=new Map<ChromiumView,unknown>();
  add(view:ChromiumView){this.views.add(view);this.apply(view);}
  private apply(view:ChromiumView){const locked=this.locked;this.tail=this.tail.then(async()=>{
    if(!this.views.has(view)||view.page.isClosed())return;
    // Cooperative DEV/TEST keeps lock() as logical ownership only. Chromium's
    // WebContents-wide ignore flag blocks Puppeteer as well as physical input.
    // Never briefly unlock around commands or imply native input is exclusive.
    if(this.cooperativeInput){view.inputBlocked=false;return;}
    try{await view.cdp.send('Input.setIgnoreInputEvents',{ignore:locked});view.inputBlocked=locked;this.failures.delete(view);}catch(error){if(this.views.has(view)&&!view.page.isClosed())this.failures.set(view,error);}
  });}
  lock(value:boolean){this.locked=value;for(const view of this.views)this.apply(view);}
  async awaitInput(){await this.tail;ensure(!this.failures.size,'Chromium input ownership could not be established',409);}
  show(view?:ChromiumView){if(view&&!view.page.isClosed())void view.page.bringToFront().catch(()=>{});}
  remove(view:ChromiumView){this.failures.delete(view);if(!this.views.delete(view))return;if(!view.page.isClosed())void view.page.close().catch(()=>{});}
  closeViews(){for(const view of [...this.views])this.remove(view);}
  assertInputReady(view:ChromiumView){ensure(this.views.has(view)&&!view.page.isClosed()&&!this.failures.has(view),'Chromium target is not available for input',409);}
  async withBackgroundInteraction<T>(view:ChromiumView,run:()=>Promise<T>){this.assertInputReady(view);await this.awaitInput();return run();}
}
