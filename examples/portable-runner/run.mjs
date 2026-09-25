/** Ordinary Puppeteer business code. Copy the separately built portable-runner.mjs alongside
 * this file for standalone use; Studio supplies the same helper through `steps`. */
export async function run({ page, input, reporter, steps: suppliedSteps, selection, priorAttempts = {}, verifyRerun, onStep, onData }) {
  const steps = suppliedSteps ?? (await import('./portable-runner.mjs')).createStepRunner({
    executionId: input.executionId,
    signal: reporter?.signal ?? new AbortController().signal,
    selection,
    save: onStep ?? (async event => { console.info(JSON.stringify(event)); }),
    // Standalone caller owns this page. A timeout closes it before the helper returns.
    interrupt: async () => { await page.close(); },
  });
  if (!reporter?.appendBatch && !onData) throw new Error('Supply an awaited durable onData callback or an incremental reporter');
  const results = [];
  for (const id of input.orderIds) {
    if (!steps.selected('orders.detail', id)) continue;
    const prior = priorAttempts[id];
    const result = await steps.run({
      stepId: 'orders.detail', entityKey: id, timeoutMs: 15_000,
      ...(prior ? { prior: { identity: prior, validate: async context => verifyRerun
        ? verifyRerun({ page, input, prior, signal: context.signal })
        : { valid: false, evidenceRefs: [], reason: 'Recheck login, inputs, prerequisite records and code/material compatibility before rerunning' } } } : {}),
      run: async ({ signal }) => {
        signal.throwIfAborted();
        await page.goto(`${input.baseUrl}/orders/${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded' });
        return page.$eval('#detail-data', element => JSON.parse(element.textContent));
      },
      commit: async (record, context) => {
        const identity = { executionId: context.identity.executionId, attemptId: context.identity.attemptId, datasetId: 'details' };
        const provenance = { origin: 'browser', sourceRefs: input.sourceRefsByOrder[id] ?? [] };
        if (reporter?.appendBatch) {
          await reporter.beginDataset(identity);
          await reporter.appendBatch({ ...identity, batchId: id, records: [record], provenance });
          await reporter.finishDataset({ ...identity, status: 'complete', committedBatches: 1, committedRecords: 1 });
        } else await onData({ ...identity, batchId: id, records: [record], provenance });
      },
    });
    // Summary only. Business rows were committed before this result is returned.
    results.push({ identity: result.identity, status: result.status, ...('error' in result ? { error: result.error } : {}) });
  }
  return { results, selectedEntities: results.map(result => result.identity.entityKey) };
}
