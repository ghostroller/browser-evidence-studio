import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('studio', {
  call: (method: string, body: unknown = {}) => ipcRenderer.invoke('studio:call', method, body),
  bounds: (rect: unknown) => ipcRenderer.send('studio:bounds', rect),
});
