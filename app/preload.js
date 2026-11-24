// Bridge for the viewer pages: open decks and toggle native full screen.
const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('slidexApp', {
  open: (p) => ipcRenderer.invoke('slidex:open', p || null),
  fullscreen: () => ipcRenderer.invoke('slidex:fullscreen'),
  exitFullscreen: () => ipcRenderer.invoke('slidex:exit-fullscreen'),
  edit: () => ipcRenderer.invoke('slidex:edit'),
  frameGroups: () => ipcRenderer.invoke('slidex:frameGroups'),
  notesLoad: () => ipcRenderer.invoke('slidex:notesLoad'),
  notesSave: (page, text) => ipcRenderer.invoke('slidex:notesSave', page, text),
  pathForFile: (file) => webUtils.getPathForFile(file),
});

// Editor windows (SlideX editor mode): source, compiles and SyncTeX lookups.
contextBridge.exposeInMainWorld('slidexEditor', {
  init: () => ipcRenderer.invoke('slidex-ed:init'),
  compileFrame: (text, line) => ipcRenderer.invoke('slidex-ed:compileFrame', text, line),
  compileDeck: (text) => ipcRenderer.invoke('slidex-ed:compileDeck', text),
  lineAt: (page, x, y) => ipcRenderer.invoke('slidex-ed:lineAt', page, x, y),
  boxesForLine: (line, opts) => ipcRenderer.invoke('slidex-ed:boxesForLine', line, opts),
  save: (text) => ipcRenderer.invoke('slidex-ed:save', text),
  projectInfo: (text) => ipcRenderer.invoke('slidex-ed:projectInfo', text),
  importMedia: (src) => ipcRenderer.invoke('slidex-ed:importMedia', src),
  pathForFile: (file) => webUtils.getPathForFile(file),
  present: (key) => ipcRenderer.invoke('slidex-ed:present', key),
  onShown: (fn) => ipcRenderer.on('slidex-ed:shown', () => fn()),
  noteChange: (text, key, note) => ipcRenderer.invoke('slidex-ed:noteChange', text, key, note),
  onNote: (fn) => ipcRenderer.on('slidex-ed:note', (e, d) => fn(d)),
  setPref: (k, v) => ipcRenderer.invoke('slidex-ed:setPref', k, v),
});
