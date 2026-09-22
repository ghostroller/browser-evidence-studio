import React from 'react';
import {createRoot} from 'react-dom/client';
import './style.css';
import { App } from './app';
import { ThemeProvider, type Preferences } from './components/theme-provider';

async function start() {
  let preferences: Preferences = { theme: 'light', layout: {} };
  try { preferences = await window.studio.call('uiPreferences'); } catch { /* Main falls back to light if preferences cannot be read. */ }
  document.documentElement.classList.toggle('dark', preferences.theme === 'dark');
  document.documentElement.style.colorScheme = preferences.theme;
  createRoot(document.getElementById('root')!).render(<ThemeProvider initial={preferences}><App /></ThemeProvider>);
}
void start();
