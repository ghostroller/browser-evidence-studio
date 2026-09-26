import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import asar from '@electron/asar';

const archive = process.argv[2];
if (!archive) throw new Error('Usage: node test/release/package-assets.mjs PATH_TO_APP_ASAR');
assert.ok(statSync(archive).isFile(), 'Packaged app.asar is required');
const entries = new Set(asar.listPackage(archive, { isPack: true }).map(item => item.replace(/^\/+/, '').replaceAll('\\', '/')));
const required = ['.vite/build/index.js', '.vite/build/runner-worker.js', '.vite/build/preload.cjs', '.vite/build/portable-runner.mjs'];
for (const file of required) {
  assert.ok(entries.has(file), `Packaged file is missing: ${file}`);
  assert.ok(asar.extractFile(archive, file).length > 0, `Packaged file is empty: ${file}`);
}
const resources = path.dirname(archive);
const external = [
  'browser-evidence-studio/SKILL.md',
  'browser-evidence-studio/references/api.md', 'browser-evidence-studio/references/handoff.md',
  'browser-evidence-studio/references/explore.md', 'browser-evidence-studio/references/validation.md',
  'orders/package.json', 'orders/package-lock.json', 'orders/standalone.mjs', 'orders/run.mjs',
  'orders/input.schema.json', 'orders/output.schema.json',
];
for (const file of external) assert.ok(statSync(path.join(resources, file)).isFile(), `External resource is missing: ${file}`);
assert.ok(!entries.has('examples/jd-account-export/run.mjs'), 'Account example must not enter the application archive');
assert.ok(!entries.has('skills/browser-evidence-studio/SKILL.md'), 'Agent skill should be externally readable after Studio exits');
assert.ok(!entries.has('examples/orders/standalone.mjs'), 'Business script should be externally copyable');
assert.ok(![...entries].some(file => /^(?:output|docs|\.git|test)\//.test(file)), 'Development evidence or source tests entered the release');
const packageJson = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
assert.equal(packageJson.main, '.vite/build/index.js');
const example = JSON.parse(readFileSync(path.join(resources, 'orders/package.json'), 'utf8'));
assert.ok(example.dependencies['puppeteer-core'] && example.dependencies.ajv, 'Independent dependencies must be declared');
console.log(JSON.stringify({ archive: path.resolve(archive), requiredFiles: required.length, externalFiles: external.length, entries: entries.size, skill: path.join(resources, 'browser-evidence-studio/SKILL.md'), standalone: path.join(resources, 'orders/standalone.mjs') }));
