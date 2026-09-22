import { BrowserWindow, WebContentsView } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
export class StudioWindow {
  readonly uiUrl = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL!=='undefined'&&MAIN_WINDOW_VITE_DEV_SERVER_URL ? new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).href : pathToFileURL(path.join(import.meta.dirname,'../renderer/main_window/index.html')).href;
  readonly window: BrowserWindow;
  readonly mask: WebContentsView;
  private views: WebContentsView[] = [];
  private active?: WebContentsView;
  private rect = {x: 236, y: 160, width: 700, height: 610};
  private locked = false;
  private browserVisible = true;
  constructor() {
    this.window = new BrowserWindow({ width: 1460, height: 940, minWidth: 1100, minHeight: 760, title: 'Browser Evidence Studio', backgroundColor:'#10151c', show: true, webPreferences: { preload: path.join(import.meta.dirname,'preload.cjs'), nodeIntegration:false, contextIsolation:true, sandbox:true,backgroundThrottling:false } });
    this.window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    this.window.webContents.on('will-navigate', event => event.preventDefault());
    this.mask = new WebContentsView({webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    // Keep the underlying compositor surface visible while this native view owns input.
    // An opaque covering view can stop IntersectionObserver updates used by Puppeteer.
    this.mask.setBackgroundColor('#00000000');
    this.mask.webContents.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><html><body style="margin:0;background:#17212d22;color:#c9d4e3;display:flex;justify-content:center;align-items:flex-start;height:100vh;font:13px system-ui"><div style="margin:12px;padding:10px 18px;background:#17212de8;border-radius:8px;text-align:center"><b>操作已锁定</b><span> · 采集与网页后台活动继续进行</span></div></body></html>'));
    this.window.contentView.addChildView(this.mask);
    this.mask.setVisible(false);
  }
  async load(){await this.window.loadURL(this.uiUrl);}
  add(view: WebContentsView) {
    this.views.push(view); this.window.contentView.addChildView(view);
    this.window.contentView.removeChildView(this.mask); this.window.contentView.addChildView(this.mask);
    this.show(view);
  }
  private contents(view:WebContentsView) {try{const contents=view.webContents;return contents&&!contents.isDestroyed()?contents:undefined;}catch{return undefined;}}
  show(view?: WebContentsView) { this.active = view&&this.views.includes(view)&&this.contents(view)?view:undefined; this.layout(); }
  setBrowserVisible(visible: boolean) { this.browserVisible=visible;this.layout(); }
  bounds(rect: {x:number;y:number;width:number;height:number}) {
    if (Object.values(rect).some(n => !Number.isFinite(n))) return;
    this.rect = { x:Math.max(0,Math.round(rect.x)),y:Math.max(0,Math.round(rect.y)),width:Math.max(1,Math.round(rect.width)),height:Math.max(1,Math.round(rect.height)) }; this.layout();
  }
  lock(value: boolean) { this.locked = value; this.layout(); if (value && this.active && this.browserVisible) this.contents(this.mask)?.focus(); }
  private layout() {
    if(this.window.isDestroyed())return;
    for (const v of this.views) {if(!this.contents(v)){if(this.active===v)this.active=undefined;continue;}v.setBounds(this.rect); v.setVisible(this.browserVisible&&v===this.active); }
    if(!this.contents(this.mask))return;
    this.mask.setBounds(this.rect); this.mask.setVisible(this.browserVisible && this.locked && !!this.active);
  }
  remove(view: WebContentsView) {
    const contents=this.contents(view),registered=this.views.includes(view),wasActive=this.active===view;
    this.views = this.views.filter(v=>v!==view);
    if(wasActive)this.active=undefined;
    if(registered&&!this.window.isDestroyed()&&this.window.contentView.children.includes(view))this.window.contentView.removeChildView(view);
    // Remove registry/native ownership before close(), which synchronously emits
    // `destroyed` and can call remove again through the run lifecycle handler.
    contents?.close();
    if(wasActive&&!this.active)this.show([...this.views].reverse().find(candidate=>this.contents(candidate)));
    else this.layout();
  }
  closeViews() { for(const view of [...this.views]) this.remove(view);this.contents(this.mask)?.close(); }
}
