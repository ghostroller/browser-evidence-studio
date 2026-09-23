import { app, type Session } from 'electron';

const policy = 'chrome-compatible-v1';

/** Configure the native browser before any session or WebContents is created. */
export function configureBrowserEnvironment(): void {
  const native = app.userAgentFallback;
  const parts = /^(Mozilla\/5\.0 \([^)]+\) AppleWebKit\/[\d.]+ \(KHTML, like Gecko\)).*Chrome\/[\d.]+.* (Safari\/[\d.]+)$/.exec(native);
  const major = /^(\d+)\./.exec(process.versions.chrome ?? '')?.[1];
  if (!parts || !major) throw new Error('Cannot derive the browser compatibility User-Agent from the native Chromium environment');

  // Use Chrome's reduced desktop UA with the real Chromium major and native OS.
  // A native fallback also covers the first popup/worker request before CDP attaches.
  app.userAgentFallback = `${parts[1]} Chrome/${major}.0.0.0 ${parts[2]}`;
  const disabled = new Set(app.commandLine.getSwitchValue('disable-blink-features').split(',').map(value => value.trim()).filter(Boolean));
  disabled.add('AutomationControlled');
  app.commandLine.appendSwitch('disable-blink-features', [...disabled].join(','));
}

export function browserEnvironmentMetadata(browserSession: Session) {
  return {
    policy,
    userAgent: browserSession.getUserAgent(),
    chromiumVersion: process.versions.chrome,
    clientHintsPolicy: 'native-chromium',
    automationControlled: app.commandLine.getSwitchValue('disable-blink-features').split(',').includes('AutomationControlled') ? 'disabled-at-startup' : 'default',
  };
}
