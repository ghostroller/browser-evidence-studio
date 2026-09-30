import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

export interface SyntheticWorkbenchMode { origin: string; dataRoot: string }
/** Called before Electron writes userData. Explicit development mode can only
 * use a brand-new empty directory outside the user's application data tree.
 * A normal launch does not configure or create a workbench transport. */
export function resolveSyntheticWorkbenchMode(env: NodeJS.ProcessEnv, appData: string, packaged: boolean): SyntheticWorkbenchMode | undefined {
  if (env.BES_WORKBENCH_SYNTHETIC === undefined) return undefined;
  if (env.BES_WORKBENCH_SYNTHETIC !== '1' || packaged || env.BES_TEST !== undefined) throw new Error('Synthetic workbench requires an unpackaged, separate launch.');
  if (!env.BES_DATA || !path.isAbsolute(env.BES_DATA)) throw new Error('Synthetic workbench requires a fresh absolute data directory.');
  const dataRoot = path.resolve(env.BES_DATA);
  if (dataRoot !== env.BES_DATA) throw new Error('Synthetic workbench data requires a canonical absolute path.');
  let origin: URL;
  try { origin = new URL(env.BES_WORKBENCH_ORIGIN ?? ''); } catch { throw new Error('Synthetic workbench requires an exact loopback origin.'); }
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.origin !== env.BES_WORKBENCH_ORIGIN) throw new Error('Synthetic workbench requires an exact loopback origin.');
  if (!existsSync(dataRoot) || !lstatSync(dataRoot).isDirectory() || lstatSync(dataRoot).isSymbolicLink() || readdirSync(dataRoot).length !== 0) throw new Error('Synthetic workbench data directory must already exist and be empty.');
  const info = lstatSync(dataRoot);
  if (typeof process.getuid === 'function' && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) throw new Error('Synthetic workbench data must be owned by the current user with private permissions.');
  if (realpathSync(dataRoot) !== dataRoot) throw new Error('Synthetic workbench does not follow data directory symlinks.');
  const applicationData = existsSync(appData) ? realpathSync(appData) : path.resolve(appData);
  const relative = path.relative(applicationData, dataRoot);
  if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error('Synthetic workbench data must be outside application data.');
  return { origin: origin.origin, dataRoot };
}
