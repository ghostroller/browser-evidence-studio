import puppeteer from 'puppeteer-core';
import Ajv from 'ajv';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { run } from './run.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (!key.startsWith('--')) continue;
  args.set(key, process.argv[index + 1]?.startsWith('--') || !process.argv[index + 1] ? true : process.argv[++index]);
}
const executablePath = String(args.get('--executable-path') || process.env.BROWSER_EXECUTABLE_PATH || '');
if (!executablePath) {
  console.error('Usage: node examples/jd-account-export/standalone.mjs --executable-path PATH_TO_CHROME [--headed] [--start-date YYYY-MM-DD --end-date YYYY-MM-DD] [--output PATH]');
  process.exitCode = 2;
} else {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const input = {
    ...(args.has('--start-date') ? { startDate: String(args.get('--start-date')) } : {}),
    ...(args.has('--end-date') ? { endDate: String(args.get('--end-date')) } : {}),
    ...(args.has('--max-pages') ? { maxPages: Number(args.get('--max-pages')) } : {}),
    ...(args.has('--max-orders') ? { maxOrders: Number(args.get('--max-orders')) } : {}),
  };
  const ajv = new Ajv({ allErrors: true, strict: false });
  const inputValidator = ajv.compile(JSON.parse(await readFile(path.join(directory, 'input.schema.json'), 'utf8')));
  if (!inputValidator(input)) throw new Error(`Invalid input: ${ajv.errorsText(inputValidator.errors)}`);
  const outputValidator = ajv.compile(JSON.parse(await readFile(path.join(directory, 'output.schema.json'), 'utf8')));
  const defaultOutput = args.has('--output') ? null : await mkdtemp(path.join(os.tmpdir(), 'bes-jd-output-'));
  const output = path.resolve(String(args.get('--output') || defaultOutput));
  const profileRoot = path.resolve(os.tmpdir());
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length > 0) throw new Error('Output directory must be empty so earlier evidence is not overwritten.');
  const profileDirectory = await mkdtemp(path.join(profileRoot, 'bes-jd-profile-'));
  const events = [];
  const append = event => events.push({ time: new Date().toISOString(), ...event });
  const workflowHash = createHash('sha256').update(await readFile(path.join(directory, 'run.mjs'))).digest('hex');
  let browser;
  let page;
  let counter = 0;
  const reporter = {
    signal: new AbortController().signal,
    async progress(message) { console.log(message); append({ type: 'progress', message }); },
    async checkpoint(key, details) {
      const id = `checkpoint-${++counter}`;
      const startedAt = new Date().toISOString();
      await page.screenshot({ path: path.join(output, `${id}.png`) });
      await writeFile(path.join(output, `${id}.html`), await page.content());
      append({ type: 'checkpoint', id, key, details, startedAt, endedAt: new Date().toISOString(), consistency: 'sequential screenshot and DOM; page scripts may continue' });
      return { id };
    },
    async attachArtifact(name, content, mediaType) {
      const id = `artifact-${++counter}`;
      const safeName = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
      const body = Buffer.from(content);
      await writeFile(path.join(output, `${id}-${safeName}`), body);
      append({ type: 'artifact', id, mediaType, bytes: body.byteLength, sha256: createHash('sha256').update(body).digest('hex') });
      return { id };
    },
    async emitData(name, records, provenance) {
      await writeFile(path.join(output, `${name}.json`), JSON.stringify(records, null, 2));
      append({ type: 'dataset', name, rows: records.length, ...provenance });
    },
    async assertion(value) { append({ type: 'assertion', ...value }); },
    async requestHuman(request) {
      append({ type: 'human-request', id: request.id, timeoutMs: request.timeoutMs });
      if (!args.has('--headed')) throw new Error('QR login requires --headed so you can see the dedicated browser.');
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      const timeout = AbortSignal.timeout(request.timeoutMs);
      try {
        await terminal.question(`${request.instructions}\n完成后按 Enter 明确交还控制：`, { signal: timeout });
        const complete = await page.$eval(request.completionCheck.selector, (element, text) => !text || (element.innerText || element.textContent || '').includes(text), request.completionCheck.text).catch(() => false);
        if (!complete) throw new Error('Human returned control, but the visible completion condition was not met.');
        append({ type: 'human-return', id: request.id, controlReturned: true });
      } finally { terminal.close(); }
    },
  };
  let result;
  let verdict = 'fail';
  let safeError;
  try {
    browser = await puppeteer.launch({
      executablePath,
      userDataDir: profileDirectory,
      headless: !args.has('--headed'),
      defaultViewport: { width: 1440, height: 1000 },
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    page = await browser.newPage();
    append({ type: 'runtime', node: process.version, browser: await browser.version(), workflowSha256: workflowHash });
    result = await run({ page, input, reporter });
    const schemaPass = outputValidator(result);
    const assertions = events.filter(event => event.type === 'assertion');
    const verdictPass = schemaPass && assertions.length > 0 && assertions.every(item => item.verdict === 'pass') &&
      result.pagination.complete && result.assertions?.detailComplete && result.deletedOrdersState;
    verdict = verdictPass ? 'pass' : 'fail';
    await writeFile(path.join(output, 'result.json'), JSON.stringify({ input, result, schemaPass, machineVerdict: verdict }, null, 2));
    if (!verdictPass) process.exitCode = 1;
  } catch (error) {
    safeError = String(error?.message || error?.name || 'Workflow failed')
      .replace(/https?:\/\/[^\s)]+/g, '[URL]')
      .replace(/\b\d{8,}\b/g, '[redacted-id]');
    append({ type: 'error', message: safeError });
    process.exitCode = 1;
  } finally {
    append({ type: 'execution', state: safeError ? 'failed' : 'completed', machineVerdict: verdict });
    await writeFile(path.join(output, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
    if (browser) await browser.close().catch(() => {});
    const resolvedProfile = path.resolve(profileDirectory);
    if (path.dirname(resolvedProfile) === profileRoot && path.basename(resolvedProfile).startsWith('bes-jd-profile-')) {
      await rm(resolvedProfile, { recursive: true, force: true });
    }
  }
  console.log(`Standalone verdict: ${verdict}. Local evidence directory: ${output}`);
  if (safeError) console.error(`Workflow failed: ${safeError}`);
}
