import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fingerprintWorkflow, loadWorkflow } from '@/runner/fingerprint';

interface Binding {
  executionId: string; projectId: string; materialRevisionId: string; materialContentHash: string;
  codeFingerprint: string; inputFingerprint: string; mode: string;
}
interface Execution {
  binding: Binding; status: string; finishedAt?: string; snapshotVerified: boolean;
  codeFingerprint?: string; inputFingerprint?: string; workflowAttemptId?: string;
}
interface Report {
  binding: Binding; reportId: string; overall: string; coverage: string; attemptId: string;
  version: { verdict: string }; counts: { requirements: number; datasets: number };
}
interface Requirement {
  requirementId: string; verdict: string; coverage: string; sourceVerdict: string;
  checks: Array<{ name: string; verdict: string }>;
}
interface Dataset {
  identity: { executionId: string; attemptId: string; datasetId: string };
  status: string; committedRecords: number; inspectedRecords: number;
}
interface Reader {
  summary(projectId: string, executionId: string): Promise<Execution>;
  reportSummary(projectId: string, executionId: string, reportId: string): Promise<Report>;
  reportItems(projectId: string, executionId: string, reportId: string, collection: 'requirements' | 'datasets', budget: { limit: number; maxBytes: number }):
    Promise<{ items: Array<Requirement | Dataset>; outputTruncated: boolean }>;
}
interface Signal { nonce: string; status: 'completed' | 'failed'; executionId?: string; reportId?: string; evidenceDirectory?: string }
interface Delivery { present: boolean; codeFingerprint?: string }

/** The evidence directory is a review artifact, never a source of the business verdict.
 * The final code fingerprint must still match the host's executed snapshot. */
export async function inspectAt39Delivery(workflowDir: string, evidenceDirectory: string | undefined, dependencyLockPath: string): Promise<Delivery> {
  try {
    if (!evidenceDirectory || !path.isAbsolute(evidenceDirectory)) return { present: false };
    const { manifest } = await loadWorkflow(workflowDir);
    if (manifest.driver !== 'puppeteer' || !(await stat(path.join(evidenceDirectory, 'verdict.md'))).isFile()) return { present: false };
    const fingerprint = await fingerprintWorkflow(workflowDir, dependencyLockPath);
    return { present: true, codeFingerprint: fingerprint.sha256 };
  } catch { return { present: false }; }
}

/** Only IDs come from the coordination signal. All acceptance facts come from
 * host-owned execution/report originals and the actual delivered code tree. */
export async function assessAt39Completion(input: {
  nonce: string; fixed: { projectId: string; revisionId: string; contentHash: string }; signal: Signal;
  reader: Reader; delivered: () => Promise<Delivery>;
}) {
  const reasons: string[] = [];
  const harnessCompleted = input.signal.nonce === input.nonce && input.signal.status === 'completed';
  if (!harnessCompleted) reasons.push('Missing matching completed coordination signal');
  const delivery = await input.delivered();
  let agentDelivered = delivery.present && typeof delivery.codeFingerprint === 'string';
  if (!agentDelivered) reasons.push('Workflow or implementation evidence is missing');
  let businessVerified = false;
  let verifiedIdentity: { materialRevisionId: string; materialContentHash: string; codeFingerprint: string; inputFingerprint: string } | undefined;
  const { executionId, reportId } = input.signal;
  if (!executionId || !reportId) reasons.push('Exact execution and report IDs are required');
  else if (harnessCompleted && agentDelivered) {
    try {
      const { projectId, revisionId, contentHash } = input.fixed;
      const execution = await input.reader.summary(projectId, executionId);
      const report = await input.reader.reportSummary(projectId, executionId, reportId);
      const binding = execution.binding;
      const identity = (other: Binding) => other.executionId === executionId && other.projectId === projectId &&
        other.materialRevisionId === revisionId && other.materialContentHash === contentHash &&
        other.codeFingerprint === binding.codeFingerprint && other.inputFingerprint === binding.inputFingerprint &&
        other.mode === 'from-start-validation';
      if (!identity(binding) || !identity(report.binding) || report.reportId !== reportId ||
          execution.status !== 'completed' || !execution.finishedAt || !execution.workflowAttemptId ||
          !execution.snapshotVerified || execution.codeFingerprint !== binding.codeFingerprint ||
          execution.inputFingerprint !== binding.inputFingerprint || delivery.codeFingerprint !== binding.codeFingerprint ||
          report.attemptId !== execution.workflowAttemptId || report.version.verdict !== 'pass' ||
          report.overall !== 'pass' || report.coverage !== 'complete') {
        reasons.push('Fixed revision, executed code/input, completion, or report verdict differs');
      } else {
        verifiedIdentity = { materialRevisionId: binding.materialRevisionId, materialContentHash: binding.materialContentHash,
          codeFingerprint: binding.codeFingerprint, inputFingerprint: binding.inputFingerprint };
        const budget = { limit: 20, maxBytes: 65_536 };
        const [requirementsPage, datasetsPage] = await Promise.all([
          input.reader.reportItems(projectId, executionId, reportId, 'requirements', budget),
          input.reader.reportItems(projectId, executionId, reportId, 'datasets', budget),
        ]);
        const requirements = requirementsPage.items as Requirement[];
        const datasets = datasetsPage.items as Dataset[];
        const checksPass = (item: Requirement, names: string[]) => item.verdict === 'pass' && item.coverage === 'complete' &&
          item.sourceVerdict === 'pass' && names.every(name => item.checks.some(check => check.name === name && check.verdict === 'pass'));
        const list = requirements.find(item => item.requirementId === 'all-orders');
        const details = requirements.find(item => item.requirementId === 'matching-details');
        const orders = datasets.find(item => item.identity.datasetId === 'orders');
        businessVerified = !requirementsPage.outputTruncated && !datasetsPage.outputTruncated &&
          requirements.length === report.counts.requirements && datasets.length === report.counts.datasets &&
          requirements.length === 2 && !!list && !!details &&
          checksPass(list, ['min-rows', 'unique:id', 'pagination-complete', 'source:order-id']) &&
          checksPass(details, ['required:imageOrderId', 'same-entity:imageOrderId', 'source:image-order-id']) &&
          !!orders && orders.identity.executionId === executionId && orders.identity.attemptId === report.attemptId &&
          orders.status === 'complete' && orders.committedRecords >= 7 && orders.inspectedRecords >= 7;
        if (!businessVerified) reasons.push('Synthetic orders, pagination, image identity, or source-backed requirement checks are incomplete');
      }
    } catch (error) { reasons.push(`Host execution/report could not be verified: ${String(error)}`); }
  }
  return { harnessCompleted, agentDelivered, businessVerified, passed: harnessCompleted && agentDelivered && businessVerified,
    ...(executionId && reportId ? { executionId, reportId } : {}), ...(verifiedIdentity ? { verifiedIdentity } : {}), reasons };
}
