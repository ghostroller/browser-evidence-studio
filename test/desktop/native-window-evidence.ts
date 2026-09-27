import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { desktopCapturer, type BrowserWindow } from 'electron';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Opt-in developer evidence: captures only this exact native window, including
 * its WebContentsViews. No display capture or same-title fallback is permitted. */
export async function recordNativeWindow(window:BrowserWindow,directory:string){
  await mkdir(directory,{recursive:true});
  const sourceFiles=['src/main/app.ts','src/main/services/studio.ts','src/main/services/dispatch.ts','src/main/api/server.ts','src/renderer/components/material-workbench.tsx','test/desktop/product-journey.ts','test/desktop/native-window-evidence.ts'];
  const candidate={sha:execFileSync('git',['-c','safe.directory='+process.cwd().replaceAll('\\','/'),'rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceHashes:Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,createHash('sha256').update(await readFile(file)).digest('hex')])))};
  const expectedSourceId=window.getMediaSourceId();
  const frames:Array<{file:string;at:number}>=[],operations:Array<{at:number;action:string}>=[],captureErrors:Array<unknown>=[];let recording=true,missingFrames=0;
  const mark=(action:string)=>{operations.push({at:Date.now(),action});};
  const loop=(async()=>{while(recording){
    try{const sources=await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:1460,height:940}}),source=sources.find(item=>item.id===expectedSourceId);
      if(source&&!source.thumbnail.isEmpty()){const file=`frame-${String(frames.length).padStart(5,'0')}.png`;await writeFile(path.join(directory,file),source.thumbnail.toPNG());frames.push({file,at:Date.now()});}
      else{missingFrames++;if(captureErrors.length<100)captureErrors.push({at:Date.now(),expectedSourceId,availableCount:sources.length,reason:source?'empty-thumbnail':'exact-window-source-unavailable'});}
    }catch(error){missingFrames++;if(captureErrors.length<100)captureErrors.push({at:Date.now(),expectedSourceId,error:String(error)});}
    await writeFile(path.join(directory,'capture-progress.json'),JSON.stringify({candidate,expectedSourceId,frames,operations,missingFrames,captureErrors}));await delay(700);
  }})();
  let finishing:Promise<any>|undefined;
  const stop=(report:any={})=>finishing??=(async()=>{
    recording=false;await loop;
    const concat=frames.map((frame,index)=>`file '${frame.file}'\nduration ${((frames[index+1]?.at??frame.at+700)-frame.at)/1000}`).join('\n');await writeFile(path.join(directory,'frames.txt'),concat+'\n');
    let videoLog='',videoCode:number|null=-1;
    if(frames.length){const encoder=spawn('ffmpeg',['-hide_banner','-loglevel','warning','-f','concat','-safe','0','-i','frames.txt','-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-fps_mode','vfr','-c:v','libx264','-pix_fmt','yuv420p','continuous-window.mp4'],{cwd:directory,windowsHide:true,stdio:['ignore','ignore','pipe']});encoder.stderr.on('data',chunk=>videoLog=(videoLog+String(chunk)).slice(-16000));videoCode=await new Promise((resolve,reject)=>{encoder.once('error',reject);encoder.once('close',resolve);}).catch(error=>{videoLog+=String(error);return -1;}) as number|null;}
    await writeFile(path.join(directory,'video-capture.log'),videoLog);
    const continuousVideo={expectedSourceId,missingFrames,captureErrors,exitCode:videoCode,path:'continuous-window.mp4',kind:'continuous exact native-window samples at original timestamps',frames:frames.length,maxGapMs:Math.max(0,...frames.slice(1).map((frame,index)=>frame.at-frames[index].at))};
    Object.assign(report,{candidate,continuousVideo});if(videoCode!==0||frames.length===0)report.passed=false;
    await writeFile(path.join(directory,'timeline.json'),JSON.stringify({frames,operations,report},null,2));await writeFile(path.join(directory,'index.html'),`<!doctype html><meta charset="utf-8"><title>连续实际窗口证据</title><style>body{font:16px system-ui;background:#222;color:white}img,video{width:95vw}input{width:90vw}</style><h1>连续实际窗口操作证据</h1><video src="continuous-window.mp4" controls></video><h2>帧索引</h2><button onclick="playing=!playing">播放 / 暂停</button><input id="seek" type="range" min="0" max="${frames.length-1}" value="0"><p id="caption"></p><img id="frame"><script>const frames=${JSON.stringify(frames)},operations=${JSON.stringify(operations)};let i=0,playing=true;function render(){document.querySelector('#frame').src=frames[i].file;document.querySelector('#caption').textContent=new Date(frames[i].at).toISOString()+' '+(operations.findLast(o=>o.at<=frames[i].at)?.action||'');document.querySelector('#seek').value=i;}document.querySelector('#seek').oninput=e=>{i=+e.target.value;render()};setInterval(()=>{if(playing){i=(i+1)%frames.length;render()}},700);if(frames.length)render();</script>`);
    return continuousVideo;
  })();
  return {frames,mark,stop,candidate,directory};
}
