import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutionSnapshot } from './snapshot';

/** Install after trusted runner imports, before importing business code. This constrains code
 * loading, not arbitrary Node filesystem/network access: the workflow is still trusted code. */
export function installSnapshotLoader(snapshot: ExecutionSnapshot): { deregister(): void } {
  const expected = new Map(snapshot.files.map(file => [file.path, file.sha256]));
  const local = (url: string): string => {
    if (!url.startsWith('file:')) throw new Error(`Execution snapshot refuses non-file module: ${url.slice(0, 128)}`);
    const filename = fileURLToPath(url);
    const relative = path.relative(snapshot.directory, filename).split(path.sep).join('/');
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) || !expected.has(relative)) throw new Error('Business module is outside the frozen execution snapshot');
    return relative;
  };
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (!result.url.startsWith('node:')) local(result.url);
      return result;
    },
    load(url, context, nextLoad) {
      if (url.startsWith('node:')) return nextLoad(url, context);
      const relative = local(url);
      // Execute these exact checked bytes. A downstream loader may transform source;
      // hashing its transformed text would compare two different representations.
      const source = readFileSync(fileURLToPath(url));
      if (createHash('sha256').update(source).digest('hex') !== expected.get(relative)) throw new Error(`Frozen module changed before loading: ${relative}`);
      const result = nextLoad(url, context);
      if (result.source === undefined || result.source === null) throw new Error(`Snapshot loader cannot verify this module format: ${relative}`);
      return { ...result, source };
    },
  });
}
