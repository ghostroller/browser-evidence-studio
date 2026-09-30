import React from 'react';
import {createRoot} from 'react-dom/client';
import './style.css';
import { App } from './app';
import { ThemeProvider, type Preferences } from './components/theme-provider';
import { WorkbenchClientProvider } from './lib/workbench-client';
import { electronWorkbenchClient } from './lib/electron-workbench-client';

async function start() {
  const root = createRoot(document.getElementById('root')!);
  try {
    const client = electronWorkbenchClient();
    let preferences: Preferences = { theme: 'light', layout: {} };
    try { preferences = await client.call('uiPreferences'); } catch { /* Main falls back to light if preferences cannot be read. */ }
    document.documentElement.classList.toggle('dark', preferences.theme === 'dark');
    document.documentElement.style.colorScheme = preferences.theme;
    root.render(<WorkbenchClientProvider client={client}><ThemeProvider initial={preferences}><App /></ThemeProvider></WorkbenchClientProvider>);
  } catch (failure) {
    root.render(<main role="alert"><h1>工作台无法启动</h1><p>{failure instanceof Error ? failure.message : String(failure)}</p></main>);
  }
}
void start();
