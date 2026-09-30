import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('studio', {
  call: (method: string, body: unknown = {}) => ipcRenderer.invoke('studio:call', method, body),
  onChanged: (listener:()=>void)=>{const receive=()=>listener();ipcRenderer.on('studio:changed',receive);return()=>ipcRenderer.removeListener('studio:changed',receive);},
  bounds: (rect: unknown) => ipcRenderer.send('studio:bounds', rect),
});
contextBridge.exposeInMainWorld('workbenchPairing', {
  status: () => ipcRenderer.invoke('studio:workbench-pairing:status'),
  begin: (projectId: string) => ipcRenderer.invoke('studio:workbench-pairing:begin', { projectId }),
  revoke: () => ipcRenderer.invoke('studio:workbench-pairing:revoke'),
});
