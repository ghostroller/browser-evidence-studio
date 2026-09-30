import { access, lstat, mkdir, readdir, realpath, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { ensure } from '@/shared/errors';
/** Do not pass inherited proxy, credential, Node preload or browser override values to child processes. */
export function childEnvironment(env:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv {
  const result:NodeJS.ProcessEnv={};
  for(const key of ['PATH','HOME','LANG','LC_ALL','LC_CTYPE','TZ','DISPLAY','XAUTHORITY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','TMPDIR','TEMP','TMP','SystemRoot','WINDIR'])if(env[key]!==undefined)result[key]=env[key];
  return result;
}
export async function chromiumExecutable(input?:string){
  const candidates=input?[input]:['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'];
  for(const candidate of candidates){try{ensure(path.isAbsolute(candidate),'Chromium executable must be absolute');const file=await realpath(candidate);ensure((await lstat(file)).isFile(),'Chromium executable is not a file');await access(file,constants.X_OK);return file;}catch(error){if(input)throw error;}}
  throw new Error('Chromium executable was not found; pass --chromium with the installed executable path.');
}
/** OS-owned loopback lease avoids stale PID lock recovery and is released on crash.
 * Hash collisions fail closed. The canonical path means symlink aliases cannot acquire a second writer. */
export async function lockNodeWorkspace(root:string){
  ensure(path.isAbsolute(root)&&path.resolve(root)===root,'Node data root must be canonical and absolute');
  await mkdir(root,{recursive:true,mode:0o700});
  const info=await lstat(root);ensure(info.isDirectory()&&!info.isSymbolicLink()&&await realpath(root)===root,'Node data root cannot be a symlink');
  ensure(typeof process.getuid!=='function'||info.uid===process.getuid()&&(info.mode&0o077)===0,'Node data root must be private and owned by the current user');
  const port=32000+createHash('sha256').update(root).digest().readUInt16BE(0)%25000;
  const guard=createServer(socket=>socket.destroy());
  try{await new Promise<void>((resolve,reject)=>{guard.once('error',reject);guard.listen(port,'127.0.0.1',resolve);});}catch{throw new Error('This Node workspace is already open or its exclusive local writer lease is occupied. No data was changed.');}
  try{
    const files=await readdir(root),marker=path.join(root,'node-workbench.json');
    if(!files.length)await writeFile(marker,JSON.stringify({schemaVersion:1,provider:'chromium',createdAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
    else{const value=JSON.parse(await readFile(marker,'utf8'));ensure(value.schemaVersion===1&&value.provider==='chromium','This is not a dedicated Node workspace. No Electron profile was migrated.');}
  }catch(error){await new Promise<void>(resolve=>guard.close(()=>resolve()));throw error;}
  return {close:()=>new Promise<void>(resolve=>guard.close(()=>resolve()))};
}
