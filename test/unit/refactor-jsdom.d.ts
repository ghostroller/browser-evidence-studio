/** Narrow declarations for the existing jsdom dev dependency used by A tests. */
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string; runScripts?: 'dangerously' | 'outside-only'; pretendToBeVisual?: boolean });
    window: Window & typeof globalThis;
  }
}
