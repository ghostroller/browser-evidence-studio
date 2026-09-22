import puppeteer from 'puppeteer-core';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { run } from './run.mjs';

// Use a dedicated temporary Chrome profile created by Puppeteer. Existing real
// browser profiles are never opened or copied by this example.
const args = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  args.set(key, process.argv[index + 1]?.startsWith('--') || !process.argv[index + 1] ? true : process.argv[++index]);
}
if (!args.has('--url') || !(args.get('--executable-path') || process.env.BROWSER_EXECUTABLE_PATH)) {
  console.error('Usage: node examples/orders/standalone.mjs --url http://127.0.0.1:PORT --executable-path PATH_TO_CHROME [--login] [--review] [--headed] [--variant normal|duplicate|missing|wrong-image|empty-middle] [--output PATH]');
  process.exitCode = 2;
} else {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const output = path.resolve(String(args.get('--output') || `artifacts/standalone-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  await mkdir(output, { recursive: true });
  const input = { baseUrl: String(args.get('--url')), variant: String(args.get('--variant') || 'normal'), requireLogin: args.has('--login'), requireHumanReview: args.has('--review') };
  const ajv = new Ajv({ allErrors: true, strict: false });
  const inputValidator = ajv.compile(JSON.parse(await readFile(path.join(directory, 'input.schema.json'), 'utf8')));
  if (!inputValidator(input)) throw new Error(`Invalid input: ${ajv.errorsText(inputValidator.errors)}`);
  const browser = await puppeteer.launch({ executablePath: String(args.get('--executable-path') || process.env.BROWSER_EXECUTABLE_PATH), headless: !args.has('--headed') && !input.requireLogin && !input.requireHumanReview, defaultViewport: { width: 1280, height: 800 } });
  const page = await browser.newPage();
  const events = [];
  events.push({ type: 'runtime', time: new Date().toISOString(), node: process.version, browser: await browser.version(), workflowSha256: createHash('sha256').update(await readFile(path.join(directory, 'run.mjs'))).digest('hex') });
  const controller = new AbortController();
  const append = event => { events.push({ time: new Date().toISOString(), ...event }); };
  let artifactCounter = 0;
  const reporter = {
    signal: controller.signal,
    async progress(message) { console.log(message); append({ type: 'progress', message }); },
    async checkpoint(key, details) {
      const id = `checkpoint-${++artifactCounter}`;
      const startedAt = new Date().toISOString();
      await page.screenshot({ path: path.join(output, `${id}.png`) });
      await writeFile(path.join(output, `${id}.html`), await page.content());
      append({ type: 'checkpoint', id, key, details, url: page.url(), startedAt, endedAt: new Date().toISOString(), consistency: 'sequential captures; site scripts may continue' });
      return { id };
    },
    async attachArtifact(name, content, mediaType) {
      const id = `artifact-${++artifactCounter}`;
      const body = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
      const filename = `${id}-${path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      await writeFile(path.join(output, filename), body);
      append({ type: 'artifact', id, filename, mediaType, bytes: body.byteLength, sha256: createHash('sha256').update(body).digest('hex') });
      return { id };
    },
    async emitData(name, records, provenance) { await writeFile(path.join(output, `${name}.json`), JSON.stringify(records, null, 2)); append({ type: 'dataset', name, records, ...provenance }); },
    async assertion(assertion) { append({ type: 'assertion', ...assertion }); },
    async requestHuman(request) {
      // The business workflow awaits here and has no other action tasks running.
      // This standalone entry is intentionally not a general transport gate.
      append({ type: 'human-request', ...request });
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      const timeout = AbortSignal.timeout(request.timeoutMs);
      try {
        await terminal.question(`${request.instructions}\n完成页面操作后按 Enter 交还控制：`, { signal: timeout });
        const complete = await page.$eval(request.completionCheck.selector, (element, text) => !text || element.textContent.includes(text), request.completionCheck.text).catch(() => false);
        if (!complete) throw new Error('Human returned control, but the real page completion condition is not satisfied.');
        append({ type: 'human-return', id: request.id, verified: true });
      } finally { terminal.close(); }
    },
  };
  let execution = 'failed';
  try {
    const result = await run({ page, input, reporter });
    const outputValidator = ajv.compile(JSON.parse(await readFile(path.join(directory, 'output.schema.json'), 'utf8')));
    const schemaPass = outputValidator(result);
    const machinePass = schemaPass && events.filter(event => event.type === 'assertion').every(event => event.verdict === 'pass') && result.pagination.complete && result.orders.length === result.pagination.expectedTotal && result.details.length === result.orders.length && result.orders.every(order => order.id === order.imageOrderId) && result.details.every(detail => detail.id === detail.imageOrderId);
    await writeFile(path.join(output, 'result.json'), JSON.stringify({ input, result, schemaPass, schemaErrors: outputValidator.errors, machineVerdict: machinePass ? 'pass' : 'fail' }, null, 2));
    execution = 'completed';
    console.log(`Standalone machine verdict: ${machinePass ? 'pass' : 'fail'}. Evidence: ${output}`);
    if (!machinePass) process.exitCode = 1;
  } catch (error) {
    append({ type: 'error', message: String(error) });
    process.exitCode = 1;
    console.error(error);
  } finally {
    append({ type: 'execution', state: execution });
    await writeFile(path.join(output, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
    await browser.close();
  }
}
