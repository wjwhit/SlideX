// Bridge for the viewer pages: open decks and toggle native full screen.
const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('slidexApp', {
  open: (p) => ipcRenderer.invoke('slidex:open', p || null),
  fullscreen: () => ipcRenderer.invoke('slidex:fullscreen'),
  exitFullscreen: () => ipcRenderer.invoke('slidex:exit-fullscreen'),
  pathForFile: (file) => webUtils.getPathForFile(file),
});
