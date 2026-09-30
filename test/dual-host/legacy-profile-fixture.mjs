/** Proposed durable bytes for the test/dual-host owner to adopt.
 * This is NEW synthetic legacy-format metadata, not a preserved old profile,
 * real account, login migration, or proof of historical-cookie compatibility.
 * This module performs no I/O and never copies a profile directory.
 */
import assert from 'node:assert/strict';
export const LEGACY_PROFILE_ID = 'b4-synthetic-legacy-profile';
export const LEGACY_PROJECT_ID = 'b4-synthetic-legacy-project';
export const LEGACY_STORAGE_REF = 'persist:b4-synthetic-custom-partition';
export function createLegacyWorkspace(entryUrl) {
  const url = new URL(entryUrl);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert(url.port, 'Use the tester-owned ephemeral fixture port');
  return {
    schemaVersion: 1,
    projects: [{ id: LEGACY_PROJECT_ID, name: 'B4 合成旧格式兼容', objective: '只验证旧格式读取与自定义分区保留', createdAt: '2026-09-30T00:00:00.000Z' }],
    profiles: [{ id: LEGACY_PROFILE_ID, projectId: LEGACY_PROJECT_ID, name: '合成旧格式环境', entryUrl: url.href, instructions: '只有本地合成 Cookie，无真实账户', storageRef: LEGACY_STORAGE_REF, loginStatus: 'unknown', configRevision: 3, checkSelector: '#logged-in', expectedOrigin: url.origin }],
    syntheticCompatibilityExtension: { fixture: 'B4-new-synthetic-old-format-metadata', retained: true },
  };
}
export function assertLegacyProfilePreserved(workspace) {
  const profile = workspace.profiles.find(item => item.id === LEGACY_PROFILE_ID);
  assert(profile, 'Exact legacy fixture profile remains present');
  assert.equal(profile.projectId, LEGACY_PROJECT_ID);
  assert.equal(profile.storageRef, LEGACY_STORAGE_REF);
  assert.equal(Object.hasOwn(profile, 'provider'), false, 'Read/open/check/save/rename must not migrate metadata');
  assert.deepEqual(workspace.syntheticCompatibilityExtension, { fixture: 'B4-new-synthetic-old-format-metadata', retained: true });
  return profile;
}
