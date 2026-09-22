import React, { createContext, useContext, useRef, useState } from 'react';

export type Preferences = { theme: 'light' | 'dark'; layout: Record<string, number[]> };
const PreferenceContext = createContext<{
  preferences: Preferences; revision: number; error: string;
  setTheme(theme: Preferences['theme']): Promise<void>;
  saveLayout(key: string, values: number[]): void;
  resetLayout(): Promise<void>;
  clearError(): void;
} | null>(null);

export function ThemeProvider({ initial, children }: { initial: Preferences; children: React.ReactNode }) {
  const [preferences, setPreferences] = useState(initial);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const writes = useRef(Promise.resolve());
  const saveLayout = (key: string, values: number[]) => {
    // Serialize only preference writes; never put them behind capture/runner operations.
    writes.current = writes.current.then(async () => {
      await window.studio.call('uiPreferences', { layout: { [key]: values } });
      setPreferences(current => ({ ...current, layout: { ...current.layout, [key]: values } }));
    }).catch(failure => setError(`布局偏好未保存：${String(failure)}`));
  };
  const setTheme = async (theme: Preferences['theme']) => {
    await window.studio.call('uiPreferences', { theme });
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
    setPreferences(current => ({ ...current, theme }));
  };
  const resetLayout = async () => {
    await writes.current;
    await window.studio.call('uiPreferences', { layout: {} });
    setPreferences(current => ({ ...current, layout: {} })); setRevision(current => current + 1);
  };
  return <PreferenceContext.Provider value={{ preferences, revision, error, setTheme, saveLayout, resetLayout, clearError: () => setError('') }}>{children}</PreferenceContext.Provider>;
}

export function usePreferences() {
  const context = useContext(PreferenceContext);
  if (!context) throw new Error('ThemeProvider is required');
  return context;
}
