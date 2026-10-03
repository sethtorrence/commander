const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('check', {
  onUpdate: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  manual: (key, value) => ipcRenderer.send('manual', key, value),
  report: (key, value) => ipcRenderer.send('report', key, value),
});
