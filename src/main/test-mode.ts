import path from 'node:path';

/** Desktop regression mode must never inherit a normal user's data root. */
export function resolveStudioDataRoot(env: NodeJS.ProcessEnv, appDataRoot: string, packaged: boolean): string {
  const defaultRoot = path.join(appDataRoot, packaged ? 'BrowserEvidenceStudio' : 'BrowserEvidenceStudio-dev');
  if (env.BES_TEST === undefined) return env.BES_DATA || defaultRoot;
  if (env.BES_TEST !== '1') throw new Error('BES_TEST must be 1 when desktop regression mode is enabled.');
  if (!env.BES_DATA || !path.isAbsolute(env.BES_DATA)) throw new Error('BES_TEST requires an explicit absolute BES_DATA directory.');

  const root = path.resolve(env.BES_DATA);
  const dataParent = path.resolve(appDataRoot);
  const relative = path.relative(dataParent, root);
  if (!relative || relative === '.' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    throw new Error('BES_TEST data must be outside the application data directory.');
  }
  return root;
}
