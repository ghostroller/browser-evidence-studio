/** Host facts, never authorization. Browser grants and runtime ownership are
 * checked independently. A browser UI cannot embed a native view even when its
 * backend is Electron. Keep these facts shared by adapters and their UI. */
export type RuntimeProvider = 'electron' | 'chromium';
export type WorkbenchBackend = 'electron' | 'electron-companion' | 'node';
export const ELECTRON_HOST_CAPABILITIES = Object.freeze({
  nativeEmbedding: true, nativeDialogs: true, downloads: 'managed', popups: 'managed', persistentProfiles: true,
} as const);
export const NODE_HOST_CAPABILITIES = Object.freeze({
  nativeEmbedding: false, nativeDialogs: false, downloads: 'denied', popups: 'rejected', persistentProfiles: true,
} as const);
export type HostCapabilities = typeof ELECTRON_HOST_CAPABILITIES | typeof NODE_HOST_CAPABILITIES;
export interface WorkbenchHost {
  readonly backend: WorkbenchBackend;
  readonly provider: RuntimeProvider;
  /** Backend support only; use client.nativePresentation for this UI surface.
   * nativeDialogs describes host facilities, not support for every website dialog. */
  readonly capabilities: HostCapabilities;
}
export function workbenchHost(backend: WorkbenchBackend): Readonly<WorkbenchHost> {
  if (!['electron', 'electron-companion', 'node'].includes(backend)) throw new Error('Unrecognized workbench backend');
  return Object.freeze({ backend, provider: backend === 'node' ? 'chromium' : 'electron',
    capabilities: backend === 'node' ? NODE_HOST_CAPABILITIES : ELECTRON_HOST_CAPABILITIES });
}
/** Historical omission means Electron; an unknown value is never guessed. */
export function compatibleProfileProvider(profile: { provider?: unknown }): RuntimeProvider | null {
  return profile.provider === undefined ? 'electron' : profile.provider === 'electron' || profile.provider === 'chromium' ? profile.provider : null;
}
export function profileProviderLabel(profile: { provider?: unknown }): string {
  const provider = compatibleProfileProvider(profile);
  return provider === null ? '未知宿主（不能打开）' : provider === 'electron' ? 'Electron' : 'Chromium';
}
export function profileCanOpen(profile: { provider?: unknown; lifecycle?: string } | undefined, provider: RuntimeProvider): boolean {
  return !!profile && compatibleProfileProvider(profile) === provider && profile.lifecycle !== 'disabled';
}
