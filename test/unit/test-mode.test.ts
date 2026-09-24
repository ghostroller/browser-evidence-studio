import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { resolveStudioDataRoot } from '@/main/test-mode';

const appData = path.join(os.tmpdir(), 'bes-test-mode-app-data');
const isolated = path.join(os.tmpdir(), 'bes-test-mode-isolated');

test('normal launches retain their development and packaged data roots', () => {
  assert.equal(resolveStudioDataRoot({}, appData, false), path.join(appData, 'BrowserEvidenceStudio-dev'));
  assert.equal(resolveStudioDataRoot({}, appData, true), path.join(appData, 'BrowserEvidenceStudio'));
});

test('desktop regression mode requires an isolated explicit absolute data root', () => {
  assert.equal(resolveStudioDataRoot({ BES_TEST: '1', BES_DATA: isolated }, appData, true), isolated);
  assert.throws(() => resolveStudioDataRoot({ BES_TEST: '1' }, appData, true), /explicit absolute BES_DATA/);
  assert.throws(() => resolveStudioDataRoot({ BES_TEST: '1', BES_DATA: 'relative-output' }, appData, true), /explicit absolute BES_DATA/);
  for (const root of [appData, path.join(appData, 'BrowserEvidenceStudio'), path.join(appData, 'other')]) {
    assert.throws(() => resolveStudioDataRoot({ BES_TEST: '1', BES_DATA: root }, appData, true), /outside the application data directory/);
  }
  assert.throws(() => resolveStudioDataRoot({ BES_TEST: '0', BES_DATA: isolated }, appData, true), /BES_TEST must be 1/);
});
