import { contextBridge, ipcRenderer } from 'electron';
import type { BrowserWorkbenchGrant } from '../contracts/browser-workbench';
contextBridge.exposeInMainWorld('studio', {
  call: (method: string, body: unknown = {}) => ipcRenderer.invoke('studio:call', method, body),
  onChanged: (listener:()=>void)=>{const receive=()=>listener();ipcRenderer.on('studio:changed',receive);return()=>ipcRenderer.removeListener('studio:changed',receive);},
  bounds: (rect: unknown) => ipcRenderer.send('studio:bounds', rect),
});
contextBridge.exposeInMainWorld('workbenchPairing', {
  status: () => ipcRenderer.invoke('studio:workbench-pairing:status'),
  begin: (projectId: string, grant: BrowserWorkbenchGrant = 'project-metadata') => ipcRenderer.invoke('studio:workbench-pairing:begin', { projectId, grant }),
  revoke: () => ipcRenderer.invoke('studio:workbench-pairing:revoke'),
});
