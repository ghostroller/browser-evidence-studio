import { app, BrowserWindow, WebContentsView } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { UiPreferencesStore, type UiTheme } from './ui-preferences';
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
  private readonly occlusion = new Set<'overlay' | 'layout'>();
  private readonly preferences = new UiPreferencesStore(app.getPath('userData'));
  private readonly maskReady: Promise<void>;
  private appliedTheme: UiTheme;
  private uiDocumentReady = false;
  private uiNeedsBounds = true;
  private readonly uiBoundsWaiters = new Set<() => void>();
  private readonly startupEvents = { commits:0, domReady:0, boundsReports:0, blockedNavigations:0, preloadFailed:false, rendererExitCode:null as number|null };
  constructor() {
    const theme = this.preferences.read().theme;
    this.appliedTheme = theme;
    this.window = new BrowserWindow({ width: 1460, height: 940, minWidth: 1100, minHeight: 760, title: 'Browser Evidence Studio', autoHideMenuBar:true, backgroundColor:theme === 'dark' ? '#171717' : '#ffffff', show: true, webPreferences: { preload: path.join(import.meta.dirname,'preload.cjs'), nodeIntegration:false, contextIsolation:true, sandbox:true,backgroundThrottling:false } });
    this.window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    this.window.webContents.on('will-navigate', (event, url) => {
      // Vite/Forge recover stale modules and update preload via location.reload().
      // Permit only the exact trusted document, never other paths on the dev server.
      if(url !== this.uiUrl){this.startupEvents.blockedNavigations++;event.preventDefault();}
    });
    this.mask = new WebContentsView({webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    // Keep the underlying compositor surface visible while this native view owns input.
    // An opaque covering view can stop IntersectionObserver updates used by Puppeteer.
    this.mask.setBackgroundColor('#00000000');
    this.maskReady = this.mask.webContents.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<!doctype html><html data-theme="${theme}"><head><style>:root{color-scheme:light;--fg:#262626;--bg:#fffffff2;--line:#d4d4d4;--tint:#73737312}:root[data-theme=dark]{color-scheme:dark;--fg:#e5e5e5;--bg:#262626f2;--line:#525252;--tint:#00000012}body{margin:0;background:var(--tint);color:var(--fg);display:flex;justify-content:center;align-items:flex-start;height:100vh;font:12px system-ui}div{margin:8px;padding:6px 10px;background:var(--bg);border:1px solid var(--line);border-radius:4px;text-align:center}</style></head><body><div><b>操作已锁定</b><span> · 采集与网页后台活动继续进行</span></div></body></html>`));
    // Only this transparent input view receives the UI theme, never the business page.
    void this.maskReady.catch(() => undefined);
    this.window.contentView.addChildView(this.mask);
    this.mask.setVisible(false);
    this.window.on('resize', () => this.layout());
    this.window.on('blur', () => { if(this.occlusion.delete('layout'))this.layout(); });
    this.window.webContents.on('did-navigate', (_event, url) => {
      // Only a committed document replaces the previous UI. A renderer navigation
      // rejected by will-navigate must retain its valid bounds and occlusion state.
      this.resetUiPresentation();
      this.uiDocumentReady = url === this.uiUrl;
      this.startupEvents.commits++;
    });
    this.window.webContents.on('dom-ready', () => {this.startupEvents.domReady++;});
    this.window.webContents.on('preload-error', () => {this.startupEvents.preloadFailed=true;});
    this.window.webContents.on('render-process-gone', (_event, details) => {
      this.startupEvents.rendererExitCode=details.exitCode;this.resetUiPresentation();
    });
  }
  startupStatus() {
    const destroyed=this.window.isDestroyed() || this.window.webContents.isDestroyed();
    return {...this.startupEvents,destroyed,documentReady:this.uiDocumentReady,needsBounds:this.uiNeedsBounds,
      loading:!destroyed && this.window.webContents.isLoadingMainFrame()};
  }
  /** Read-only diagnostics: explain native visibility without overriding any lock. */
  presentationStatus() {
    return { browserVisible:this.browserVisible, needsBounds:this.uiNeedsBounds, occlusion:[...this.occlusion],
      rect:{...this.rect}, locked:this.locked, activeWebContentsId:this.active && this.contents(this.active)?.id,
      views:this.views.map(view=>({webContentsId:this.contents(view)?.id,visible:view.getVisible(),bounds:view.getBounds()})) };
  }
  async load() {
    await this.window.loadURL(this.uiUrl);
    if(this.window.isDestroyed() || this.window.webContents.isDestroyed())throw new Error('Trusted UI was destroyed before its layout became ready');
    if(this.uiDocumentReady && !this.uiNeedsBounds)return;
    // Vite can finish HTML navigation before module imports and the async
    // preference bootstrap mount React. Do not announce ui-ready in that gap.
    await new Promise<void>((resolve, reject) => {
      const contents = this.window.webContents;
      const cleanup = () => {
        clearTimeout(timer); this.uiBoundsWaiters.delete(ready);
        this.window.off('closed', destroyed); contents.off('destroyed', destroyed);
      };
      const ready = () => {
        if(!this.uiDocumentReady || this.uiNeedsBounds)return;
        cleanup(); resolve();
      };
      const destroyed = () => { cleanup(); reject(new Error('Trusted UI was destroyed before its layout became ready')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Trusted UI did not report a usable browser layout within 20 seconds')); }, 20_000);
      this.uiBoundsWaiters.add(ready);
      this.window.once('closed', destroyed); contents.once('destroyed', destroyed);
      ready();
    });
  }
  add(view: WebContentsView) {
    this.views.push(view); this.window.contentView.addChildView(view);
    this.window.contentView.removeChildView(this.mask); this.window.contentView.addChildView(this.mask);
    this.show(view);
  }
  private contents(view:WebContentsView) {try{const contents=view.webContents;return contents&&!contents.isDestroyed()?contents:undefined;}catch{return undefined;}}
  show(view?: WebContentsView) { this.active = view&&this.views.includes(view)&&this.contents(view)?view:undefined; this.layout(); }
  setBrowserVisible(visible: boolean) { this.browserVisible=visible;this.layout(); }
  private resetUiPresentation() {
    // A new trusted document has no ownership of the old document's drag/dialogs.
    // Keep native views hidden until it reports fresh bounds, without changing the run lock.
    this.uiDocumentReady = false; this.uiNeedsBounds = true;
    this.occlusion.clear(); this.browserVisible = true; this.layout();
  }
  setPresentation(reason: 'overlay' | 'layout', hidden: boolean) {
    if(!this.uiDocumentReady)return;
    // Pointer IPC may arrive after the OS blur event. It must not revive a drag
    // or steal focus back from the user's other application.
    if(reason === 'layout' && hidden && !this.window.isFocused())return;
    if (hidden) this.occlusion.add(reason); else this.occlusion.delete(reason);
    this.layout();
    if (hidden && !this.window.isDestroyed() && this.window.isFocused() && !this.window.webContents.isFocused()) this.window.webContents.focus();
  }
  async uiPreferences(patch: unknown) {
    const preferences = await this.preferences.update(patch);
    await this.applyTheme(preferences.theme);
    return preferences;
  }
  private async applyTheme(theme: UiTheme) {
    if (this.window.isDestroyed() || this.appliedTheme === theme) return;
    this.appliedTheme = theme;
    this.window.setBackgroundColor(theme === 'dark' ? '#171717' : '#ffffff');
    try {
      await this.maskReady;
      if(this.appliedTheme !== theme)return;
      await this.contents(this.mask)?.executeJavaScript(`document.documentElement.dataset.theme = '${theme}'`);
    } catch { /* The mask may be closing with the window; preferences remain persisted. */ }
  }
  bounds(rect: {x:number;y:number;width:number;height:number}) {
    this.startupEvents.boundsReports++;
    if (this.window.isDestroyed() || !this.uiDocumentReady || !rect || !['x','y','width','height'].every(key => typeof rect[key as keyof typeof rect] === 'number' && Number.isFinite(rect[key as keyof typeof rect]))) return;
    const [width,height] = this.window.getContentSize();
    const usable = rect.width > 0 && rect.height > 0 && Math.min(width,rect.x+rect.width)>Math.max(0,rect.x) && Math.min(height,rect.y+rect.height)>Math.max(0,rect.y);
    if(usable)this.uiNeedsBounds = false;
    this.rect = { x:rect.x,y:rect.y,width:Math.max(0,rect.width),height:Math.max(0,rect.height) }; this.layout();
    if(usable)for(const ready of this.uiBoundsWaiters)ready();
  }
  lock(value: boolean) { this.locked = value; this.layout(); if (value && this.mask.getVisible()) this.contents(this.mask)?.focus(); }
  private place(view: WebContentsView, rect: {x:number;y:number;width:number;height:number}, visible: boolean) {
    const current = view.getBounds();
    // Repeated native layout calls can provoke hover/focus work on Windows.
    // Hidden views still receive changed bounds before visibility is restored.
    if(current.x !== rect.x || current.y !== rect.y || current.width !== rect.width || current.height !== rect.height)view.setBounds(rect);
    if(view.getVisible() !== visible)view.setVisible(visible);
  }
  private layout() {
    if(this.window.isDestroyed())return;
    const [width,height] = this.window.getContentSize();
    const x = Math.max(0,Math.min(width,Math.round(this.rect.x))),y = Math.max(0,Math.min(height,Math.round(this.rect.y)));
    const right = Math.max(x,Math.min(width,Math.round(this.rect.x+this.rect.width))),bottom = Math.max(y,Math.min(height,Math.round(this.rect.y+this.rect.height)));
    const rect = {x:Math.min(x,Math.max(0,width-1)),y:Math.min(y,Math.max(0,height-1)),width:Math.max(1,right-x),height:Math.max(1,bottom-y)};
    const visible = this.browserVisible && !this.uiNeedsBounds && !this.occlusion.size && right>x && bottom>y;
    // Commit the latest bounds before restoring visibility after a dialog or drag.
    for (const v of this.views) {if(!this.contents(v)){if(this.active===v)this.active=undefined;continue;}this.place(v,rect,visible&&v===this.active); }
    if(!this.contents(this.mask))return;
    this.place(this.mask,rect,visible && this.locked && !!this.active);
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
