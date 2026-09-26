'use strict';
// Review evidence only. Extracted control-flow model, not an Electron/project test.
// Corresponds to ReplayHost.open/close/closeActive at commit 046a52e.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
class LifecycleModel {
  constructor() { this.lifetime = 0; this.active = { id: 'current-B' }; }
  async open(id, barrier) {
    const request = ++this.lifetime;
    await barrier;
    if (request !== this.lifetime) return { id, status: 'closed' };
    this.closeActive();
    this.active = { id };
    return { id, status: 'ready' };
  }
  require(id) {
    if (this.active?.id !== id) throw new Error('Replay view is no longer active');
    return this.active;
  }
  close(id) { this.lifetime++; return this.closeActive(id); }
  closeActive(id) {
    const active = id ? this.require(id) : this.active;
    if (!active) return;
    this.active = undefined;
    return { id: active.id, status: 'closed' };
  }
}
(async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const host = new LifecycleModel();
  const opening = host.open('wanted-C', barrier);
  const before = host.lifetime;
  let staleCloseError;
  try { host.close('old-A'); } catch (error) { staleCloseError = error.message; }
  release();
  const result = await opening;
  assert.equal(staleCloseError, 'Replay view is no longer active');
  assert.equal(result.status, 'closed');
  assert.equal(host.active.id, 'current-B');

  // A lower-bound size calculation using the actual exported checkpoint shape.
  // Does NOT call exportFixedTaskHandoff or assert a specific common page count.
  const recordingId = randomUUID(), pageId = randomUUID(), documentId = randomUUID(), streamEpoch = randomUUID();
  const checkpoints = Array.from({ length: 250 }, (_, i) => ({
    id: `checkpoint-${randomUUID()}`, kind: 'observation',
    anchor: { recordingId, pageId, documentId, streamEpoch, sourceTimeMs: 1790390000000 + i, eventSeq: i },
    requirementIds: [],
  }));
  const checkpointProjectionBytes = Buffer.byteLength(JSON.stringify({ checkpoints }, null, 2) + '\n');
  assert(checkpointProjectionBytes > 64 * 1024);
  const report = {
    node: process.version,
    scope: 'Extracted lifecycle methods and export-shape arithmetic; no project dependencies or Electron execution',
    lifecycle: { beforeStaleClose: before, afterStaleClose: host.lifetime, staleCloseError, wantedOpen: result, remainingActive: host.active.id },
    exportSize: { checkpointCount: checkpoints.length, checkpointProjectionBytes, manifestLimit: 65536, includesOtherManifestSections: false },
  };
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
