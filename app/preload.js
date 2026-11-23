// Bridge for the viewer pages: open decks and toggle native full screen.
const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('slidexApp', {
  open: (p) => ipcRenderer.invoke('slidex:open', p || null),
  fullscreen: () => ipcRenderer.invoke('slidex:fullscreen'),
  exitFullscreen: () => ipcRenderer.invoke('slidex:exit-fullscreen'),
  edit: () => ipcRenderer.invoke('slidex:edit'),
  pathForFile: (file) => webUtils.getPathForFile(file),
});

// Editor windows (SlideX editor mode): source, compiles and SyncTeX lookups.
contextBridge.exposeInMainWorld('slidexEditor', {
  init: () => ipcRenderer.invoke('slidex-ed:init'),
  compileFrame: (text, line) => ipcRenderer.invoke('slidex-ed:compileFrame', text, line),
  compileDeck: (text) => ipcRenderer.invoke('slidex-ed:compileDeck', text),
  lineAt: (page, x, y) => ipcRenderer.invoke('slidex-ed:lineAt', page, x, y),
  boxesForLine: (line) => ipcRenderer.invoke('slidex-ed:boxesForLine', line),
  save: (text) => ipcRenderer.invoke('slidex-ed:save', text),
  present: (key) => ipcRenderer.invoke('slidex-ed:present', key),
  onShown: (fn) => ipcRenderer.on('slidex-ed:shown', () => fn()),
});
