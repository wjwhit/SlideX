// Bridge for the viewer pages: open decks and toggle native full screen.
const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');
contextBridge.exposeInMainWorld('slidexApp', {
  open: (p) => ipcRenderer.invoke('slidex:open', p || null),
  fullscreen: () => ipcRenderer.invoke('slidex:fullscreen'),
  exitFullscreen: () => ipcRenderer.invoke('slidex:exit-fullscreen'),
  edit: () => ipcRenderer.invoke('slidex:edit'),
  frameGroups: () => ipcRenderer.invoke('slidex:frameGroups'),
  welcomeInfo: () => ipcRenderer.invoke('slidex:welcomeInfo'),
  forgetRecent: (pdf) => ipcRenderer.invoke('slidex:forgetRecent', pdf),
  openSource: () => ipcRenderer.invoke('slidex:openSource'),
  openDocs: () => ipcRenderer.invoke('slidex:openDocs'),
  newDeck: (id) => ipcRenderer.invoke('slidex:newDeck', id),
  openExample: () => ipcRenderer.invoke('slidex:openExample'),
  notesLoad: () => ipcRenderer.invoke('slidex:notesLoad'),
  notesSave: (page, text) => ipcRenderer.invoke('slidex:notesSave', page, text),
  pathForFile: (file) => webUtils.getPathForFile(file),
});

// Editor windows (SlideX editor mode): source, compiles and SyncTeX lookups.
contextBridge.exposeInMainWorld('slidexEditor', {
  init: () => ipcRenderer.invoke('slidex-ed:init'),
  compileFrame: (text, line) => ipcRenderer.invoke('slidex-ed:compileFrame', text, line),
  compileDeck: (text, force) => ipcRenderer.invoke('slidex-ed:compileDeck', text, force),
  lineAt: (page, x, y) => ipcRenderer.invoke('slidex-ed:lineAt', page, x, y),
  boxesForLine: (line, opts) => ipcRenderer.invoke('slidex-ed:boxesForLine', line, opts),
  save: (text, force) => ipcRenderer.invoke('slidex-ed:save', text, force),
  projectInfo: (text) => ipcRenderer.invoke('slidex-ed:projectInfo', text),
  importMedia: (src) => ipcRenderer.invoke('slidex-ed:importMedia', src),
  pathForFile: (file) => webUtils.getPathForFile(file),
  present: (key) => ipcRenderer.invoke('slidex-ed:present', key),
  onShown: (fn) => ipcRenderer.on('slidex-ed:shown', () => fn()),
  noteChange: (text, key, note) => ipcRenderer.invoke('slidex-ed:noteChange', text, key, note),
  parseFrames: (text) => ipcRenderer.invoke('slidex-ed:parseFrames', text),
  misspelled: (words) => words.filter((w) => { try { return webFrame.isWordMisspelled(w); } catch { return false; } }),   // the system spell checker
  onNote: (fn) => ipcRenderer.on('slidex-ed:note', (e, d) => fn(d)),
  setPref: (k, v) => ipcRenderer.invoke('slidex-ed:setPref', k, v),
  acceptDisk: (text) => ipcRenderer.invoke('slidex-ed:acceptDisk', text),
  readDisk: () => ipcRenderer.invoke('slidex-ed:readDisk'),
  onDisk: (fn) => ipcRenderer.on('slidex-ed:disk', (e, d) => fn(d)),
  recovery: (text) => ipcRenderer.invoke('slidex-ed:recovery', text),
  discardRecovery: () => ipcRenderer.invoke('slidex-ed:discardRecovery'),
  deckInfo: (text) => ipcRenderer.invoke('slidex-ed:deckInfo', text),
  deckEdit: (text, edit) => ipcRenderer.invoke('slidex-ed:deckEdit', text, edit),
});
