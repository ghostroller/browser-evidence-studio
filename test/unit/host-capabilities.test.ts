import { expect, test, vi } from 'vitest';
import { compatibleProfileProvider, profileCanOpen, profileProviderLabel, workbenchHost } from '@/contracts/host-capabilities';
import { createElectronWorkbenchClient } from '@/renderer/lib/electron-workbench-client';
import { BrowserWorkbenchClient } from '@/renderer/lib/browser-workbench-client';
import { assertProfileProvider } from '@/main/browser/runtime';

test('backend support is distinct from the current frontend presentation and authority', () => {
  const native = createElectronWorkbenchClient({ call: vi.fn(), onChanged: () => () => {}, bounds: vi.fn() });
  const companion = new BrowserWorkbenchClient({ instanceId: 'instance', backend: 'electron-companion' });
  const node = new BrowserWorkbenchClient({ instanceId: 'instance', backend: 'node' });
  expect(native.host.provider).toBe('electron'); expect(native.nativePresentation).not.toBeNull();
  expect(companion.host.provider).toBe('electron'); expect(companion.nativePresentation).toBeNull();
  expect(companion.host.capabilities).toEqual(native.host.capabilities);
  expect(node.host.provider).toBe('chromium'); expect(node.nativePresentation).toBeNull();
  expect(node.host.capabilities).toMatchObject({ downloads: 'denied', popups: 'rejected', nativeDialogs: false });
  for (const client of [node, companion]) {
    expect(client.materials.canEdit()).toBe(false); expect(client.results.canRead()).toBe(false);
    expect(client.getSnapshot().grant).toBeUndefined();
    expect(Object.isFrozen(client.host)).toBe(true); expect(Object.isFrozen(client.host.capabilities)).toBe(true);
  }
  expect(() => workbenchHost('unknown' as never)).toThrow('Unrecognized');
});
test.each([{}, { storageRef: 'persist:historical-custom-partition' }, { provider: 'electron', storageRef: 'persist:historical-custom-partition' }])('historical Electron identity remains readable and byte-identical: %j', profile => {
  const before = JSON.stringify(profile);
  expect(compatibleProfileProvider(profile)).toBe('electron'); expect(profileCanOpen(profile, 'electron')).toBe(true);
  expect(profileCanOpen(profile, 'chromium')).toBe(false); expect(profileProviderLabel(profile)).toBe('Electron');
  expect(() => assertProfileProvider(profile as never, 'chromium')).toThrow('different browser provider');
  expect(JSON.stringify(profile)).toBe(before);
});
test('unsupported and disabled environments are never promoted to usable profiles', () => {
  expect(compatibleProfileProvider({ provider: 'unknown' })).toBeNull();
  expect(profileProviderLabel({ provider: 'unknown' })).not.toContain('Electron');
  for (const provider of ['electron', 'chromium'] as const) {
    expect(profileCanOpen({ provider: 'unknown' }, provider)).toBe(false);
    expect(profileCanOpen({ provider, lifecycle: 'disabled' }, provider)).toBe(false);
    expect(profileCanOpen(undefined, provider)).toBe(false);
  }
});
