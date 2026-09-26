import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { EvidenceStore } from '@/evidence/store';
import { safeFile } from '@/evidence/files';
import { inspectWriterLock, recoverWriterLock } from '@/evidence/writer-lock';
import { RecordingArchive } from '@/replay/archive';
import { ResourceArchive } from '@/resources/archive';
import { ensure } from '@/shared/errors';
import type { Studio } from './studio';

async function recoveryTarget(studio: Studio, runId: unknown) {
  ensure(typeof runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(runId), 'Invalid recovery run identity');
  const record = studio.runs.find(run => run.id === runId);
  ensure(record, 'Unknown recovery run', 404);
  const root = await realpath(studio.root), runsDirectory = path.join(root, 'runs'), runDir = path.join(runsDirectory, runId);
  for (const directory of [runsDirectory, runDir]) {
    const info = await lstat(directory);
    ensure(info.isDirectory() && !info.isSymbolicLink(), 'Recovery requires a regular run directory', 409);
  }
  const actual = await realpath(runDir), relative = path.relative(root, actual);
  ensure(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Recovery run escapes the workspace', 409);
  return { record, runDir: actual };
}

type IndexState = 'published'|'legacy'|'missing'|'unverified'|'corrupt'|'read-failed';
async function inspectProjection(runDir:string,kind:'replay'|'resource'):Promise<{state:IndexState;reason:string}>{
  const pointer=kind==='replay'?'replay-index-current.json':'resource-url-index-current.json';
  const base=kind==='replay'?'replay-index':'resource-url-index';
  const generations=kind==='replay'?'replay-index-generations':'resource-url-index-generations';
  let pointerFound=false;
  try{
    const file=await safeFile(runDir,pointer);
    pointerFound=true;
    if((await stat(file)).size>4096)return{state:'corrupt',reason:'generation-pointer-over-budget'};
    const value=JSON.parse(await readFile(file,'utf8')) as {version?:unknown;generation?:unknown};
    if(value.version!==1||typeof value.generation!=='string'||!/^[a-f0-9-]{36}$/.test(value.generation))return{state:'corrupt',reason:'invalid-generation-pointer'};
    const manifest=await safeFile(runDir,`${generations}/${value.generation}/index-manifest.json`);
    if((await stat(manifest)).size>(kind==='replay'?4096:2*1024*1024))return{state:'corrupt',reason:'generation-manifest-over-budget'};
    const metadata=JSON.parse(await readFile(manifest,'utf8')) as {version?:unknown;generation?:unknown};
    if(metadata.version!==1||metadata.generation!==value.generation)return{state:'corrupt',reason:'generation-manifest-mismatch'};
    return{state:'published',reason:'generation-manifest-present'};
  }catch(error){
    if(pointerFound&&(error as NodeJS.ErrnoException).code==='ENOENT')return{state:'missing',reason:'published-generation-manifest-missing'};
    if((error as NodeJS.ErrnoException).code!=='ENOENT')return{state:error instanceof SyntaxError?'corrupt':'read-failed',reason:String(error)};
    try{await lstat(path.join(runDir,generations));return{state:'missing',reason:'generation-pointer-missing'};}
    catch(problem){if((problem as NodeJS.ErrnoException).code!=='ENOENT')return{state:'read-failed',reason:String(problem)};}
    try{
      const baseInfo=await lstat(path.join(runDir,base));
      if(!baseInfo.isDirectory()||baseInfo.isSymbolicLink())return{state:'corrupt',reason:'legacy-index-not-regular-directory'};
      if(kind==='resource'){
        try{await safeFile(runDir,`${base}/url-census.jsonl`);}catch(problem){return{state:(problem as NodeJS.ErrnoException).code==='ENOENT'?'unverified':'read-failed',reason:'legacy-url-census-unavailable'};}
      }
      return{state:'legacy',reason:'legacy-index-directory-present'};
    }catch(problem){return{state:(problem as NodeJS.ErrnoException).code==='ENOENT'?'missing':'read-failed',reason:String(problem)};}
  }
}

export async function inspectRunRecovery(studio: Studio, body: { runId?: unknown }) {
  const { record, runDir } = await recoveryTarget(studio, body.runId);
  const inspection = await inspectWriterLock(runDir);
  const indexDiagnostics=await Promise.all([inspectProjection(runDir,'replay'),inspectProjection(runDir,'resource')]);
  return { runId: record.id, status: record.status, error: record.error, inspection, canRecover: !studio.active && record.status === 'unreadable' && ['unlocked', 'dead', 'pid-reused'].includes(inspection.state),
    canRecoverIndexes:!studio.active&&record.status==='sealed'&&inspection.state==='unlocked',indexDiagnostics:{replay:indexDiagnostics[0],resources:indexDiagnostics[1]} };
}

/** Directed projection repair for one saved run. The originals remain read-only;
 * neither historical resource recovery nor replay recovery can fetch a URL. */
export async function recoverRunIndexes(studio: Studio, body: { runId?: unknown; expectedFingerprint?: unknown }) {
  const { record, runDir } = await recoveryTarget(studio, body.runId);
  ensure(!studio.active || studio.active.id !== record.id, 'Stop the run before rebuilding its indexes', 409);
  const inspection = await inspectWriterLock(runDir);
  ensure(body.expectedFingerprint === inspection.lockFingerprint, 'Writer ownership changed; inspect the archive again', 409);
  ensure(inspection.state === 'unlocked', `Index recovery refused (${inspection.state}): ${inspection.message}`, 409);
  const replay = await new RecordingArchive(runDir).rebuild();
  const resources = await new ResourceArchive(runDir).rebuildUrlIndex();
  return { runId: record.id, replay, resources };
}

/** Only the trusted UI invokes this after displaying the currently inspected ownership. */
export async function recoverRun(studio: Studio, body: { runId?: unknown; expectedFingerprint?: unknown }) {
  const { record, runDir } = await recoveryTarget(studio, body.runId);
  ensure(!studio.active, 'Seal the current run before recovering an archive', 409);
  ensure(record.status === 'unreadable', 'This run is already readable; open its saved evidence', 409);
  const inspection = await inspectWriterLock(runDir);
  ensure(body.expectedFingerprint === inspection.lockFingerprint, 'Writer ownership changed; inspect the archive again', 409);
  ensure(['unlocked', 'dead', 'pid-reused'].includes(inspection.state), `Writer recovery refused (${inspection.state}): ${inspection.message}`, 409);
  const manifestPath = await safeFile(runDir, 'manifest.json');
  ensure((await stat(manifestPath)).size <= 64 * 1024, 'Run manifest exceeds the recovery metadata budget', 413);
  const storedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  ensure(storedManifest.id === record.id, 'Run manifest identity does not match its archive', 409);
  let recovery: Awaited<ReturnType<typeof recoverWriterLock>> | undefined;
  try {
    if (inspection.state !== 'unlocked') {
      ensure(typeof body.expectedFingerprint === 'string', 'A current writer fingerprint is required', 409);
      recovery = await recoverWriterLock(runDir, { expectedFingerprint: body.expectedFingerprint });
    }
    const store = await EvidenceStore.open(runDir);
    let manifest;
    try {
      ensure(store.manifest.id === record.id, 'Run manifest identity does not match its archive', 409);
      manifest = { ...store.manifest };
    } finally { await store.close(); }
    studio.runs = studio.runs.map(run => run.id === record.id ? manifest : run);
    const validations = await studio.refreshValidations();
    studio.onChanged();
    return { runId: record.id, status: manifest.status, recovered: true, ...(recovery ? { preservedLockPath: recovery.preservedLockPath, diagnosticPath: recovery.diagnosticPath } : {}), validationDiagnostics: validations.diagnostics.filter(diagnostic => !diagnostic.runId || diagnostic.runId === record.id).slice(0, 20) };
  } catch (error) {
    // A failed reopen remains visible and retryable without claiming a live execution.
    studio.runs = studio.runs.map(run => run.id === record.id ? { ...record, status: 'unreadable', error: String(error) } : run);
    studio.onChanged();
    throw error;
  }
}
