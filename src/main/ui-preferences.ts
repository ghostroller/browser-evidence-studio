import { closeSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { atomicJson } from '../evidence/files';
import { ensure } from '../shared/errors';

export type UiTheme = 'light' | 'dark';
export interface UiPreferences { theme: UiTheme; layout: Record<string, number[]>; }
const PANEL_KEYS = new Set(['workspace', 'checkpoints', 'validation', 'evidence', 'inspection']);
const MAX_FILE_BYTES = 4096;

function validatedPatch(value: unknown): Partial<UiPreferences> {
  ensure(value && typeof value === 'object' && !Array.isArray(value), 'Invalid UI preferences');
  const patch = value as Record<string, unknown>;
  ensure(Object.keys(patch).every(key => key === 'theme' || key === 'layout'), 'Unknown UI preference');
  const result: Partial<UiPreferences> = {};
  if ('theme' in patch) {
    ensure(patch.theme === 'light' || patch.theme === 'dark', 'Invalid UI theme');
    result.theme = patch.theme;
  }
  if ('layout' in patch) {
    ensure(patch.layout && typeof patch.layout === 'object' && !Array.isArray(patch.layout), 'Invalid panel layout');
    result.layout = {};
    for (const [key, sizes] of Object.entries(patch.layout)) {
      ensure(PANEL_KEYS.has(key), 'Unknown layout panel');
      ensure(Array.isArray(sizes) && sizes.length >= 2 && sizes.length <= 4 && sizes.every(size => typeof size === 'number' && Number.isFinite(size) && size > 0 && size < 100), 'Invalid panel percentages');
      ensure(Math.abs(sizes.reduce((sum, size) => sum + size, 0) - 100) < 0.1, 'Panel percentages must total 100');
      result.layout[key] = [...sizes];
    }
  }
  return result;
}

/** Small UI-only preferences; paths and business state never come from the renderer. */
export class UiPreferencesStore {
  private value: UiPreferences = { theme: 'light', layout: {} };
  private pending: Promise<unknown> = Promise.resolve();
  readonly file: string;
  constructor(directory: string) {
    this.file = path.join(directory, 'ui-preferences.json');
    // A bounded synchronous read lets the native window use the saved theme on its first frame.
    let descriptor: number | undefined;
    try {
      descriptor = openSync(this.file, 'r');
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1), bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
      if (bytes > MAX_FILE_BYTES) return;
      const patch = validatedPatch(JSON.parse(buffer.subarray(0, bytes).toString('utf8')));
      this.value = { theme: patch.theme ?? 'light', layout: patch.layout ?? {} };
    } catch { /* Missing or invalid preferences are not evidence corruption. Use safe UI defaults. */ }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
  read(): UiPreferences { return structuredClone(this.value); }
  update(value: unknown): Promise<UiPreferences> {
    const patch = validatedPatch(value);
    if (!Object.keys(patch).length) return Promise.resolve(this.read());
    const result = this.pending.then(async () => {
      const next: UiPreferences = {
        theme: patch.theme ?? this.value.theme,
        layout: patch.layout ? Object.keys(patch.layout).length ? { ...this.value.layout, ...patch.layout } : {} : this.value.layout,
      };
      await atomicJson(this.file, next);
      this.value = next;
      return this.read();
    });
    this.pending = result.catch(() => undefined);
    return result;
  }
}
