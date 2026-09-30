import React from 'react';
import {createRoot} from 'react-dom/client';
import './style.css';
import { App } from './app';
import { ThemeProvider, SessionThemeProvider, type Preferences } from './components/theme-provider';
import { WorkbenchClientProvider } from './lib/workbench-client';
import { BrowserWorkbenchClient } from './lib/browser-workbench-client';
import { electronWorkbenchClient, electronWorkbenchPairing } from './lib/electron-workbench-client';

async function start() {
  const root = createRoot(document.getElementById('root')!);
  try {
    const host = document.documentElement.dataset.workbenchHost;
    if (host === 'browser') {
      const instanceId = document.querySelector<HTMLMetaElement>('meta[name="workbench-instance"]')?.content;
      if (!instanceId) throw new Error('浏览器工作台未配置合成实例，请使用合成启动器提供的 browser.html 地址。');
      const client = new BrowserWorkbenchClient({ instanceId });
      document.documentElement.classList.remove('dark');
      document.documentElement.style.colorScheme = 'light';
      root.render(<SessionThemeProvider><App host="browser" client={client} /></SessionThemeProvider>);
      return;
    }
    if (host !== 'electron') throw new Error('未识别工作台宿主，请使用明确的 Electron 或 browser.html 入口。');
    const client = electronWorkbenchClient();
    let preferences: Preferences = { theme: 'light', layout: {} };
    try { preferences = await client.call('uiPreferences'); } catch { /* Main falls back to light if preferences cannot be read. */ }
    document.documentElement.classList.toggle('dark', preferences.theme === 'dark');
    document.documentElement.style.colorScheme = preferences.theme;
    root.render(<WorkbenchClientProvider client={client}><ThemeProvider initial={preferences}><App host="electron" pairing={electronWorkbenchPairing()} /></ThemeProvider></WorkbenchClientProvider>);
  } catch (failure) {
    root.render(<main role="alert"><h1>工作台无法启动</h1><p>{failure instanceof Error ? failure.message : String(failure)}</p></main>);
  }
}
void start();
