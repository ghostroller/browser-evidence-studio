import { app, BrowserWindow, Menu, WebContentsView, session, type WebContents, type WebPreferences } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { configureBrowserEnvironment, browserEnvironmentMetadata } from './environment';

// Intentionally separate from app.ts: no Studio, debugger, Puppeteer, recorder,
// business preload, evidence store or agent control server is initialized here.
const root = process.env.BES_BASELINE_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('Start with npm run browser:baseline');
const verify = process.env.BES_BASELINE_VERIFY === '1';
configureBrowserEnvironment();
const userData = path.join(root, 'profile');
const sessionData = path.join(userData, 'session-data');
mkdirSync(sessionData, { recursive: true });
app.setPath('userData', userData);
app.setPath('sessionData', sessionData);
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
if (['remote-debugging-port', 'remote-debugging-pipe'].some(flag => app.commandLine.hasSwitch(flag))) {
  throw new Error('The baseline cannot run with remote debugging enabled');
}
const windows = new Map<BrowserWindow, WebContentsView>();
const closedContents: WebContents[] = [];
const allowedUrl = (url: string) => url === 'about:blank' || /^https?:\/\//i.test(url);
app.on('window-all-closed', () => { if (!verify) app.quit(); });

app.whenReady().then(async () => {
  await mkdir(root, { recursive: true });
  const browserSession = session.fromPartition('persist:baseline');
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  const preferences: WebPreferences = { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false };
  const initialUrl = process.env.BES_BASELINE_URL || 'https://www.jd.com/';
  if (!allowedUrl(initialUrl)) throw new Error('Only HTTP(S) or about:blank is supported');
  function open(view = new WebContentsView({ webPreferences: preferences })) {
    const host = new BrowserWindow({ width: 1400, height: 940, show: true, title: 'Electron 无采集对照 · 人工控制', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    windows.set(host, view);
    host.contentView.addChildView(view);
    const layout = () => { const [width, height] = host.getContentSize(); view.setBounds({ x: 0, y: 0, width, height }); };
    layout(); host.on('resize', layout);
    const contents = view.webContents;
    const load = (url: string) => { void contents.loadURL(url).catch(() => { if (!host.isDestroyed()) host.setTitle('Electron 无采集对照 · 页面加载失败'); }); };
    host.setMenu(Menu.buildFromTemplate([{ label: '浏览', submenu: [
      { label: '回到起始页面', click: () => load(initialUrl) },
      { label: '后退', accelerator: 'Alt+Left', click: () => { if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); } },
      { label: '前进', accelerator: 'Alt+Right', click: () => { if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); } },
      { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => contents.reload() },
      { type: 'separator' }, { label: '关闭窗口', accelerator: 'CmdOrCtrl+W', click: () => host.close() },
    ] }, { label: '无采集 · 独立登录环境 · 仅人工操作', enabled: false }]));
    contents.on('will-navigate', (event, url) => { if (!allowedUrl(url)) event.preventDefault(); });
    contents.on('will-redirect', (event, url) => { if (!allowedUrl(url)) event.preventDefault(); });
    contents.setWindowOpenHandler(details => !allowedUrl(details.url) ? { action: 'deny' } : {
      action: 'allow', overrideBrowserWindowOptions: { webPreferences: preferences },
      createWindow: options => open(new WebContentsView(options)).webContents,
    });
    contents.on('page-title-updated', (_event, title) => { if (!host.isDestroyed()) host.setTitle(`Electron 无采集对照 · ${title}`); });
    contents.on('destroyed', () => { if (!host.isDestroyed()) host.close(); });
    host.on('closed', () => {
      windows.delete(host); closedContents.push(contents);
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    });
    return view;
  }
  const metadata = {
    mode: 'electron-no-capture', processId: process.pid, createdAt: new Date().toISOString(),
    versions: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
    environment: browserEnvironmentMetadata(browserSession), userData: app.getPath('userData'), sessionData: app.getPath('sessionData'),
    remoteDebugging: false, capture: false, controller: verify ? 'synthetic-test' : 'human', freshProfile: true,
  };
  if (verify) {
    const { verifyBaseline } = await import('../../../test/desktop/browser-baseline');
    try {
      const report = await verifyBaseline({ open, windows, closedContents, browserSession, root });
      await writeFile(path.join(root, 'verification.json'), JSON.stringify({ ...metadata, ...report, passed: true }, null, 2));
      app.exit(0);
    } catch (error) {
      await writeFile(path.join(root, 'verification.json'), JSON.stringify({ ...metadata, passed: false, error: String(error), stack: (error as Error).stack }, null, 2));
      throw error;
    }
  } else {
    const view = open();
    await writeFile(path.join(root, 'ready.json'), JSON.stringify(metadata, null, 2));
    console.log('No-capture browser ready. Human control; no recording or agent connection.');
    try {
      await view.webContents.loadURL(initialUrl);
      await writeFile(path.join(root, 'initial-load.json'), JSON.stringify({ status: 'loaded', at: new Date().toISOString() }));
    } catch (error) {
      // Keep the manually controlled page open for inspection/retry. A failed
      // initial navigation is neither a startup failure nor a login verdict.
      await writeFile(path.join(root, 'initial-load.json'), JSON.stringify({ status: 'failed', code: (error as { code?: string }).code || 'unknown', at: new Date().toISOString() }));
    }
  }
}).catch(error => { console.error(error); app.exit(1); });
