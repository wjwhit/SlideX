// SlideX desktop app: the slide viewer in its own windows.
//
// A tiny HTTP server on 127.0.0.1 (byte ranges for video) serves the viewer
// and each opened deck's folder; Chromium windows show them. Opening a deck:
// File > Open, drag a PDF onto the window or the Dock icon, Finder "Open With",
// or `SlideX.app/Contents/MacOS/SlideX deck.pdf`.
'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, screen, shell } = require('electron');
const editor = require('./editor');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');

const VIEWER = path.join(__dirname, 'viewer');

/* A development build ("SlideX Dev") or a run from source keeps its own
 * profile, so it can run next to the installed SlideX instead of handing its
 * windows over to it (Chromium allows one running app per profile). */
{
  const exe = path.basename(process.execPath);
  const profile = exe === 'SlideX' ? null : exe === 'SlideX Dev' ? 'SlideX Dev' : 'SlideX (source)';
  if (profile) { app.setName(profile); app.setPath('userData', path.join(app.getPath('appData'), profile)); }
}
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4',
  '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.json': 'application/json',
};

/* ---------------------------------------------------------------- server */
const decks = [];          // index -> root folder served at /deck/<index>/
let port = 0;

function inside(base, full) {
  return full === base || full.startsWith(base + path.sep);
}

function resolveUrl(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return null; }
  let m;
  if (p.startsWith('/viewer/')) {
    const full = path.resolve(VIEWER, '.' + p.slice('/viewer'.length));
    return inside(VIEWER, full) ? full : null;
  }
  if ((m = /^\/deck\/(\d+)(\/.*)$/.exec(p))) {
    const root = decks[+m[1]];
    if (!root) return null;
    const full = path.resolve(root, '.' + m[2]);
    return inside(root, full) ? full : null;
  }
  return null;
}

function serve(req, res) {
  const url = new URL(req.url, 'http://x');
  const full = resolveUrl(url.pathname);
  if (req.method === 'PUT') return saveNotes(req, res, url, full);
  let st;
  try { st = full && fs.statSync(full); } catch { st = null; }
  if (!st || !st.isFile()) {
    if (full) console.error('missing:', full);
    res.writeHead(404, { 'Content-Length': 0 }); res.end(); return;
  }
  const size = st.size;
  let start = 0, end = size - 1, status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec((req.headers.range || '').trim());
  if (m) {
    if (m[1] === '') { start = Math.max(0, size - +m[2]); }
    else { start = +m[1]; if (m[2]) end = Math.min(+m[2], size - 1); }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': 0 }); res.end(); return;
    }
    status = 206;
  }
  const headers = {
    'Content-Type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-cache',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  const s = fs.createReadStream(full, { start, end });
  s.on('error', () => res.destroy());
  res.on('close', () => s.destroy());
  s.pipe(res);
}

/* Speaker notes from the presenter window: only <deck>.pdf.notes.json next to
 * an existing PDF, JSON, at most 2 MB; written atomically. */
function saveNotes(req, res, url, full) {
  const deny = (code) => { res.writeHead(code, { 'Content-Length': 0 }); res.end(); };
  if (!full || !url.pathname.startsWith('/deck/') || !full.endsWith('.pdf.notes.json')
      || !fs.existsSync(full.slice(0, -'.notes.json'.length))) return deny(403);
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 2e6) { req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    try { JSON.parse(body.toString('utf8')); } catch { return deny(400); }
    const tmp = full + '.tmp';
    try { fs.writeFileSync(tmp, body); fs.renameSync(tmp, full); } catch { return deny(500); }
    deny(204);
  });
}

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer(serve);
    srv.listen(0, '127.0.0.1', () => { port = srv.address().port; resolve(); });
  });
}

/* Movie files a deck links to (plain and Flate-compressed objects). */
function movieLinks(pdfPath) {
  const data = fs.readFileSync(pdfPath);
  const chunks = [data.toString('latin1')];
  const re = /stream\r?\n/g;
  const text = chunks[0];
  let m;
  while ((m = re.exec(text))) {
    const endIdx = text.indexOf('endstream', m.index + m[0].length);
    if (endIdx < 0) continue;
    try { chunks.push(zlib.inflateSync(data.subarray(m.index + m[0].length, endIdx)).toString('latin1')); }
    catch { /* not Flate, or not inflatable: skip */ }
  }
  const out = new Set();
  for (const c of chunks) {
    for (const u of c.matchAll(/\/URI\s*\(((?:[^()\\]|\\.)*)\)/g)) {
      const s = u[1].replace(/\\(.)/g, '$1');
      const k = s.indexOf('#slidemovie');
      if (k > 0) { try { out.add(decodeURIComponent(s.slice(0, k))); } catch { out.add(s.slice(0, k)); } }
    }
  }
  return [...out];
}

/* Serve the smallest folder holding the PDF and every movie it links to
 * (movies in ../figures work), but never more than the home folder. */
function deckRoot(pdfPath) {
  const pdfDir = path.dirname(pdfPath);
  let root = pdfDir;
  let movies = [];
  try { movies = movieLinks(pdfPath); } catch { /* unreadable: keep pdfDir */ }
  for (const mv of movies) {
    if (/^[a-z]+:/i.test(mv)) continue;
    const dir = path.dirname(path.resolve(pdfDir, mv));
    while (!inside(root, dir) && root !== path.dirname(root)) root = path.dirname(root);
  }
  const home = os.homedir();
  if (root !== pdfDir && (!inside(home, root) || root === home)) root = pdfDir;
  const missing = movies.filter((mv) => !/^[a-z]+:/i.test(mv) && !fs.existsSync(path.resolve(pdfDir, mv)));
  return { root, movies, missing };
}

/* ---------------------------------------------------------------- windows */
const deckOf = new Map();   // webContents id -> pdf path

function openDeck(pdfPath, opts = {}) {
  pdfPath = path.resolve(pdfPath);
  if (!fs.existsSync(pdfPath)) { dialog.showErrorBox('SlideX', `No such file:\n${pdfPath}`); return null; }
  const { root, movies, missing } = deckRoot(pdfPath);
  let idx = decks.indexOf(root);
  if (idx < 0) { decks.push(root); idx = decks.length - 1; }
  const rel = path.relative(root, pdfPath).split(path.sep).map(encodeURIComponent).join('/');
  const url = `http://127.0.0.1:${port}/viewer/index.html?pdf=/deck/${idx}/${rel}`;
  app.addRecentDocument(pdfPath);
  console.log(`slidex: ${pdfPath}: ${movies.length} movie(s)` + (missing.length ? `, MISSING: ${missing.join(', ')}` : ''));

  let win = opts.reuse;
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({
      width: 1280, height: 800, backgroundColor: '#000000', title: path.basename(pdfPath),
      show: !opts.hidden,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
    });
    setupWindow(win);
  }
  deckOf.set(win.webContents.id, pdfPath);
  if (process.platform === 'darwin') win.setRepresentedFilename(pdfPath);   // macOS title-bar proxy icon
  win.loadURL(url);
  if (missing.length && !opts.hidden) {
    dialog.showMessageBox(win, { type: 'warning', message: 'Some movies are missing',
      detail: missing.join('\n') + `\n\n(paths are relative to ${path.dirname(pdfPath)})` });
  }
  return win;
}

function setupWindow(win) {
  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://127.0.0.1:${port}/viewer/`)) {
      return { action: 'allow', overrideBrowserWindowOptions: {
        width: 1280, height: 760, backgroundColor: '#000000', title: 'Presenter',
        webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false } } };
    }
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('did-create-window', (child) => {
    setupWindow(child);
    placePresenter(win, child);
  });
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}/`)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
  wc.on('page-title-updated', (e, title) => { e.preventDefault(); win.setTitle(title.replace(/ \(SlideX\)$/, '')); });
}

/* With a second display: audience full screen on the external one,
 * presenter on the display the audience window was on. */
function placePresenter(audience, presenter) {
  const displays = screen.getAllDisplays();
  const here = screen.getDisplayMatching(audience.getBounds());
  if (displays.length < 2) { presenter.center(); return; }
  const other = displays.find((d) => d.id !== here.id);
  presenter.setBounds(here.workArea);
  if (audience.isFullScreen()) audience.setFullScreen(false);
  audience.setBounds({ ...other.bounds, width: Math.min(1280, other.bounds.width), height: Math.min(800, other.bounds.height) });
  setTimeout(() => audience.setFullScreen(true), 300);
  presenter.focus();
}

async function chooseDeck(win) {
  const r = await dialog.showOpenDialog(win || undefined, {
    title: 'Open a slide deck', properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (r.canceled || !r.filePaths.length) return;
  const reuse = win && win.webContents.getURL().includes('/viewer/welcome.html') ? win : null;
  openDeck(r.filePaths[0], { reuse });
}

function showWelcome() {
  const win = new BrowserWindow({
    width: 720, height: 460, backgroundColor: '#111111', title: 'SlideX',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  setupWindow(win);
  win.loadURL(`http://127.0.0.1:${port}/viewer/welcome.html`);
  return win;
}

/* ------------------------------------------------------------- editor */
const editors = new Map();   // editor webContents id -> state

/* URL a file under a deck root is served at. */
function urlFor(root, file) {
  let idx = decks.indexOf(root);
  if (idx < 0) { decks.push(root); idx = decks.length - 1; }
  const rel = path.relative(root, file).split(path.sep).map(encodeURIComponent).join('/');
  return `http://127.0.0.1:${port}/deck/${idx}/${rel}`;
}

/* File > Open LaTeX Source: build the deck if its PDF is missing or older
 * than the source, open it, then open the editor beside it. */
async function openSource(win) {
  const r = await dialog.showOpenDialog(win || undefined, { title: 'Open a beamer source file',
    properties: ['openFile'], filters: [{ name: 'LaTeX', extensions: ['tex'] }] });
  if (r.canceled || !r.filePaths.length) return;
  const tex = r.filePaths[0];
  const pdf = tex.replace(/\.tex$/i, '.pdf');
  const stale = !fs.existsSync(pdf) || fs.statSync(pdf).mtimeMs < fs.statSync(tex).mtimeMs;
  if (stale) {
    const busy = new BrowserWindow({ width: 420, height: 120, frame: false, resizable: false, backgroundColor: '#1b1d21' });
    busy.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:%231b1d21;color:%23ddd;font:14px -apple-system,sans-serif">Building ' + path.basename(tex) + '…</body>'));
    const c = await editor.compileDeck(tex);
    busy.destroy();
    if (!fs.existsSync(pdf)) {
      dialog.showErrorBox('SlideX', 'The deck did not build:\n' + (c.errors.slice(0, 5).map((e) => (e.line ? 'line ' + e.line + ': ' : '') + e.message).join('\n') || 'see the .log file'));
      return;
    }
  }
  const deckWin = openDeck(pdf);
  if (deckWin) deckWin.webContents.once('did-finish-load', () => setTimeout(() => openEditor(deckWin), 800));
}

async function openEditor(deckWin) {
  const pdfPath = deckWin && deckOf.get(deckWin.webContents.id);
  if (!pdfPath) { dialog.showErrorBox('SlideX', 'Open a deck first, then choose Edit Source.'); return; }
  let texPath = editor.findSource(pdfPath);
  if (!texPath) {
    const r = await dialog.showOpenDialog(deckWin, { title: 'Choose the LaTeX source of this deck',
      defaultPath: path.dirname(pdfPath), properties: ['openFile'], filters: [{ name: 'LaTeX', extensions: ['tex'] }] });
    if (r.canceled || !r.filePaths.length) return;
    texPath = r.filePaths[0];
  }
  for (const [id, st] of editors) {
    if (st.texPath === texPath && !st.win.isDestroyed()) {   // back to edit mode
      st.deckWin = deckWin;
      st.win.show(); st.win.focus();
      st.win.webContents.send('slidex-ed:shown');
      return;
    }
  }
  const { root } = deckRoot(pdfPath);
  const win = new BrowserWindow({
    width: 1500, height: 920, backgroundColor: '#1b1d21', title: 'SlideX editor: ' + path.basename(texPath),
    show: !process.argv.includes('--selftest'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  setupWindow(win);
  const st = { win, texPath, pdfPath, root: path.dirname(texPath) === root || path.dirname(texPath).startsWith(root + path.sep) ? root : path.dirname(texPath),
    deckUrl: urlFor(root, pdfPath), frames: [], sync: null, syncFrame: null, deckWin };
  editors.set(win.webContents.id, st);
  win.on('closed', () => editors.delete(st.id));
  st.id = win.webContents.id;
  win.loadURL(`http://127.0.0.1:${port}/viewer/editor.html`);
}

function edState(e) {
  const st = editors.get(e.sender.id);
  if (!st) throw new Error('not an editor window');
  return st;
}

async function pageFrames(st) { st.pageFrames = await editor.pageFrames(st.texPath, st.frames); return st.pageFrames; }

/* The end of a LaTeX log, where errors and the summary are. */
function tailLog(log, n = 400) {
  if (!log) return '';
  const lines = log.split('\n');
  return (lines.length > n ? '[… ' + (lines.length - n) + ' earlier lines]\n' : '') + lines.slice(-n).join('\n');
}

function reloadDeckWindows(pdfPath) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (deckOf.get(w.webContents.id) === pdfPath) w.webContents.reload();
  }
}

/* Errors in the single-frame .vrb copy point at the frame body's lines. */
function mapErrors(st, errors) {
  const bdir = editor.buildDir(st.texPath);
  return errors.map((e) => {
    const m = e.file && /-L(\d+)\.vrb$/.exec(e.file);
    if (m) return { ...e, line: editor.vrbToSource(+m[1], e.line), file: st.texPath };
    // the one-slide copy in .slidex/ keeps the deck's line numbers
    if (e.file && /\.tex$/.test(e.file) && path.resolve(path.dirname(st.texPath), e.file).startsWith(bdir + path.sep)) return { ...e, file: st.texPath };
    if (e.file && path.resolve(path.dirname(st.texPath), e.file) !== st.texPath) return { ...e, line: null, message: `${path.basename(e.file)}:${e.line}: ${e.message}` };
    return e;
  });
}

ipcMain.handle('slidex-ed:init', async (e) => {
  const st = edState(e);
  const text = fs.readFileSync(st.texPath, 'utf8');
  st.frames = editor.parseFrames(text);
  const pf = await pageFrames(st).catch(() => []);
  let deckPage = 0;
  try { deckPage = await st.deckWin.webContents.executeJavaScript('window.slidex ? slidex.page : 0'); } catch { /* closed */ }
  return { texName: path.basename(st.texPath), text, frames: st.frames, deckUrl: st.deckUrl, pageFrames: pf, deckPage };
});

ipcMain.handle('slidex-ed:compileFrame', async (e, text, line) => {
  const st = edState(e);
  st.frames = editor.parseFrames(text);                  // compiles the editor's text: no save needed
  const frame = editor.frameAtLine(st.frames, line);
  const key = frame ? editor.frameKey(frame) : null;
  const first = (st.pageFrames || []).indexOf(key);
  const r = await editor.compileFrame(st.texPath, frame, text, { frames: st.frames, firstPage: first >= 0 ? first : null });
  st.sync = null;
  if (r.ok) {
    st.sync = await editor.loadSync(st.texPath, r, frame).catch(() => null);
    st.syncFrame = frame;
  }
  return { ok: r.ok, url: r.pdf ? urlFor(st.root, r.pdf) : null, label: r.label, exact: !!(st.sync && st.sync.exact),
    frames: st.frames, errors: mapErrors(st, r.errors || []), ms: r.ms, fmt: r.fmt, log: tailLog(r.log) };
});

ipcMain.handle('slidex-ed:compileDeck', async (e, text) => {
  const st = edState(e);
  editor.saveSource(st.texPath, text);
  st.frames = editor.parseFrames(text);
  const r = await editor.compileDeck(st.texPath);
  if (r.ok) reloadDeckWindows(st.pdfPath);
  const pf = await pageFrames(st).catch(() => []);
  return { ok: r.ok, frames: st.frames, errors: mapErrors(st, r.errors || []), ms: r.ms, pageFrames: pf, log: tailLog(r.log) };
});

ipcMain.handle('slidex-ed:save', (e, text) => {
  const st = edState(e);
  editor.saveSource(st.texPath, text);
  st.frames = editor.parseFrames(text);
  return { frames: st.frames };
});

/* Present: hide the editor, bring the deck forward on the editor's frame. */
ipcMain.handle('slidex-ed:present', async (e, key) => {
  const st = edState(e);
  let deck = st.deckWin && !st.deckWin.isDestroyed() ? st.deckWin : null;
  if (!deck) { deck = openDeck(st.pdfPath); st.deckWin = deck; }
  const page = (st.pageFrames || []).indexOf(key);
  if (page >= 0) deck.webContents.executeJavaScript(`window.slidex && slidex.goto(${page})`).catch(() => {});
  st.win.hide();
  deck.show(); deck.focus();
});

ipcMain.handle('slidex-ed:lineAt', (e, page, x, y) => {
  const st = edState(e);
  return st.sync ? st.sync.lineAt(page, x, y) : null;
});

ipcMain.handle('slidex-ed:boxesForLine', (e, line) => {
  const st = edState(e);
  return st.sync ? st.sync.boxesForLine(line) : [];
});

ipcMain.handle('slidex:edit', (e) => openEditor(BrowserWindow.fromWebContents(e.sender)));

ipcMain.handle('slidex:open', (e, p) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (p && /\.pdf$/i.test(p)) {
    const reuse = win.webContents.getURL().includes('/viewer/welcome.html') ? win : null;
    openDeck(p, { reuse });
  } else chooseDeck(win);
});
ipcMain.handle('slidex:exit-fullscreen', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win.isFullScreen()) win.setFullScreen(false);
});
ipcMain.handle('slidex:fullscreen', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  win.setFullScreen(!win.isFullScreen());
});

/* ----------------------------------------------------------------- menu */
function editCommand(w, name) {
  if (!w) return;
  const wc = w.webContents;
  if (editors.has(wc.id)) { wc.executeJavaScript(`window.editorCommand && editorCommand(${JSON.stringify(name)})`).catch(() => {}); return; }
  if (name === 'undo') wc.undo();
  else if (name === 'redo') wc.redo();
  else if (name === 'selectAll') wc.selectAll();
}

function buildMenu() {
  const template = [
    { role: 'appMenu' },
    { label: 'File', submenu: [
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: (_, w) => chooseDeck(w) },
      { label: 'Open LaTeX Source…', accelerator: 'Shift+CmdOrCtrl+O', click: (_, w) => openSource(w) },
      { label: 'Edit Source of This Deck', accelerator: 'CmdOrCtrl+E', click: (_, w) => openEditor(w) },
      { role: 'recentDocuments', submenu: [{ role: 'clearRecentDocuments' }] },
      { type: 'separator' },
      { label: 'Show in Finder', click: (_, w) => { const p = w && deckOf.get(w.webContents.id); if (p) shell.showItemInFolder(p); } },
      { type: 'separator' },
      { role: 'close' },
    ] },
    // Edit: on macOS, Cmd-Z/C/X/V/A reach the page (editor, notes box) only
    // through this menu. Undo, Redo and Select All go to the code editor's own
    // commands in editor windows (its document is not all in the page at once).
    { label: 'Edit', submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: (_, w) => editCommand(w, 'undo') },
      { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: (_, w) => editCommand(w, 'redo') },
      { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: (_, w) => editCommand(w, 'selectAll') },
      { type: 'separator' },
      { label: 'Find', accelerator: 'CmdOrCtrl+F', click: (_, w) => editCommand(w, 'find') },
    ] },
    { label: 'View', submenu: [
      { label: 'Presenter Window', accelerator: 'CmdOrCtrl+P',
        click: (_, w) => w && w.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'s'}))") },
      { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/',
        click: (_, w) => w && w.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'?'}))") },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { role: 'reload' },
      { role: 'toggleDevTools' },
    ] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ start */
const pending = [];
app.on('open-file', (e, p) => {             // Finder, Dock drops (can come before ready)
  e.preventDefault();
  if (app.isReady() && port) openDeck(p); else pending.push(p);
});

const selftest = process.argv.includes('--selftest');

app.whenReady().then(async () => {
  await startServer();
  buildMenu();
  const args = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => /\.pdf$/i.test(a));
  const files = [...pending, ...args];
  if (selftest) return runSelftest(files[0]);
  if (files.length) files.forEach((f) => openDeck(f));
  else showWelcome();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) showWelcome(); });
});
app.on('window-all-closed', () => app.quit());

/* --selftest deck.pdf: open the deck off screen, report the viewer state,
 * save a screenshot next to the PDF's folder, and quit. */
async function runSelftest(pdf) {
  const win = openDeck(pdf, { hidden: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await wait(2500);
    const state = await js(`({page: slidex.page, pages: document.querySelectorAll('.page').length,
      videos: [...document.querySelectorAll('.movies video')].map(v => ({src: v.dataset.src.split('/').pop(), t: +v.currentTime.toFixed(2), paused: v.paused, ready: v.readyState})),
      bars: document.querySelectorAll('.mbar').length, missing: [...document.querySelectorAll('.missing')].map(d => d.textContent)})`);
    console.log('SELFTEST page 1', JSON.stringify(state));
    // SLIDEX_SELFTEST_PAGES=4,10 visits those pages; a screenshot of each goes
    // to SLIDEX_SELFTEST_PNG with the page number before .png.
    const pages = (process.env.SLIDEX_SELFTEST_PAGES || '5').split(',').map(Number);
    const base = process.env.SLIDEX_SELFTEST_PNG || path.join(os.tmpdir(), 'slidex-selftest.png');
    for (const pg of pages) {
      await js(`slidex.goto(${pg - 1})`);
      await wait(3000);
      const st = await js(`({page: slidex.page + 1, movies: [...document.querySelectorAll('.movies > video, .movies > img, .movies > .missing')].map(v => ({tag: v.tagName, src: (v.dataset.src||v.textContent||'').split('/').pop(), t: +(v.currentTime||0).toFixed(2), paused: v.paused, w: Math.round(v.getBoundingClientRect().width)}))})`);
      console.log(`SELFTEST page ${pg}`, JSON.stringify(st));
      const img = await win.webContents.capturePage();
      const out = base.replace(/\.png$/, `-p${pg}.png`);
      fs.writeFileSync(out, img.toPNG());
      console.log('SELFTEST screenshot', out);
    }
    if (process.env.SLIDEX_SELFTEST_EDITOR) {        // editor: compile a frame, cursor and hover lookups
      const before = new Set(BrowserWindow.getAllWindows().map((w) => w.id));
      await openEditor(win);
      const ew = BrowserWindow.getAllWindows().find((w) => !before.has(w.id));
      if (!ew) throw new Error('editor did not open');
      const ejs = (code) => ew.webContents.executeJavaScript(code);
      for (let i = 0; i < 60; i++) { await wait(500); if (await ejs('!!(window.S && S.preview && S.preview.page)')) break; }
      const label = process.env.SLIDEX_SELFTEST_EDITOR;
      const res = await ejs(`(async () => {
        const f = S.frames.find((x) => x.label === ${JSON.stringify(label)});
        gotoLine(f.bodyStart + 5, false);
        await new Promise((r) => setTimeout(r, 2500));
        const cur = S.frame && S.frame.label;
        const line = cursorLine();
        const boxes = await api.boxesForLine(line);
        drawBoxes('cursor', boxes);
        const b = boxes.find((x) => x.page === S.preview.page);
        let hover = null;
        if (b) {
          const r = document.getElementById('pagewrap').getBoundingClientRect();
          const ev = new MouseEvent('mousemove', { clientX: r.left + (b.x + b.w / 2) * pv.scale, clientY: r.top + (b.y + b.h / 2) * pv.scale, bubbles: true });
          document.getElementById('preview').dispatchEvent(ev);
          await new Promise((r2) => setTimeout(r2, 400));
          hover = S.hoverLine;
        }
        return { frame: cur, cursorLine: line, boxes: boxes.length, hoverLine: hover, status: document.getElementById('status').textContent, frames: S.frames.length };
      })()`);
      console.log('SELFTEST editor', JSON.stringify(res));
      const texBefore = fs.statSync(editors.get(ew.webContents.id).texPath).mtimeMs;
      const res2 = await ejs(`(async () => {
        const thumbs = document.querySelectorAll('#strip .thumb').length;
        const on = document.querySelector('#strip .thumb.on');
        const t0 = performance.now();
        const line = view.state.doc.line(cursorLine());
        view.dispatch({ changes: { from: line.to, insert: ' LIVEEDIT' } });
        for (let i = 0; i < 40 && (S.stale || S.compiling); i++) await new Promise((r) => setTimeout(r, 100));
        return { thumbs, onThumb: on && on.dataset.key, liveMs: Math.round(performance.now() - t0), stale: S.stale, status: document.getElementById('status').textContent, dirty: S.dirty };
      })()`);
      const texAfter = fs.statSync(editors.get(ew.webContents.id).texPath).mtimeMs;
      {                                    // the Edit menu's actions on the code editor
        const { clipboard } = require('electron');
        const saved = await clipboard.readText();
        const ed = (code) => ejs(code);
        ew.show(); ew.focus(); await wait(400);        // copy/cut act on the focused text
        await ed(`view.focus(); (() => { const l = view.state.doc.line(cursorLine()); view.dispatch({ selection: { anchor: l.from, head: l.to } }); })()`);
        const selected = await ed('view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)');
        ew.webContents.copy(); await wait(300);
        const copied = await clipboard.readText();
        await ed(`(() => { const l = view.state.doc.line(cursorLine()); view.dispatch({ selection: { anchor: l.to } }); })()`);
        await clipboard.writeText(' PASTED-TEXT'); ew.webContents.paste(); await wait(300);
        const afterPaste = await ed('view.state.doc.line(cursorLine()).text');
        editCommand(ew, 'undo'); await wait(300);
        const afterUndo = await ed('view.state.doc.line(cursorLine()).text');
        await ed(`(() => { const l = view.state.doc.line(cursorLine()); view.dispatch({ selection: { anchor: l.from, head: l.from + 6 } }); })()`);
        ew.webContents.cut(); await wait(300);
        const cut = await clipboard.readText();
        const afterCut = await ed('view.state.doc.line(cursorLine()).text');
        editCommand(ew, 'undo'); await wait(300);
        editCommand(ew, 'selectAll'); await wait(200);
        const all = await ed('view.state.selection.main.to - view.state.selection.main.from === view.state.doc.length');
        await ed(`gotoLine(S.frame.bodyStart + 5, false)`); await wait(2500);
        ew.hide();
        try { if (typeof saved === 'string' && saved) await clipboard.writeText(saved); } catch { /* clipboard held non-text */ }
        console.log('SELFTEST clipboard', JSON.stringify({ copyOk: copied === selected && copied.length > 0,
          pasteOk: afterPaste.endsWith(' PASTED-TEXT'), undoOk: !afterUndo.includes('PASTED-TEXT'),
          cutOk: cut.length === 6 && !afterCut.startsWith(cut), selectAllOk: all }));
        if (process.env.SLIDEX_SELFTEST_DEBUG) console.log('SELFTEST clipdebug', JSON.stringify({ selected: selected.slice(0, 40), copied: copied.slice(0, 40), cut, hasFocus: await ed('document.hasFocus()'), active: await ed('document.activeElement && document.activeElement.className') }));
      }
      console.log('SELFTEST editor live', JSON.stringify({ ...res2, texUntouched: texBefore === texAfter }));
      const rs = await ejs(`(async () => {
        const out = document.getElementById('output'), h = document.getElementById('out-resize').getBoundingClientRect();
        const before = out.offsetHeight, y = h.top + 3;
        document.getElementById('out-resize').dispatchEvent(new MouseEvent('mousedown', { clientY: y, bubbles: true }));
        window.dispatchEvent(new MouseEvent('mousemove', { clientY: y - 200, bubbles: true }));
        window.dispatchEvent(new MouseEvent('mouseup', { clientY: y - 200, bubbles: true }));
        await new Promise((r) => setTimeout(r, 200));
        return { before, after: out.offsetHeight, saved: localStorage.getItem('slidex.outputHeight') };
      })()`);
      console.log('SELFTEST output resize', JSON.stringify(rs));
      await ejs(`S.dirty = false; api.present(frameKeyOf(S.frame))`);
      await wait(800);
      const deckPage = await js('slidex.page');
      console.log('SELFTEST present', JSON.stringify({ editorVisible: ew.isVisible(), deckPage }));
      await openEditor(win);
      await wait(500);
      console.log('SELFTEST back to edit', JSON.stringify({ editorVisible: ew.isVisible() || ew.webContents.isLoading() === false && editors.has(ew.webContents.id) }));
      const img = await ew.webContents.capturePage();
      const out = (process.env.SLIDEX_SELFTEST_PNG || path.join(os.tmpdir(), 'slidex-selftest.png')).replace(/\.png$/, '-editor.png');
      fs.writeFileSync(out, img.toPNG());
      ew.setSize(1100, 700); await wait(600);
      fs.writeFileSync(out.replace(/\.png$/, '-narrow.png'), (await ew.webContents.capturePage()).toPNG());
      console.log('SELFTEST editor screenshot', out);
    }
    if (process.env.SLIDEX_SELFTEST_NOTES) {     // notes round trip through the server
      const nf = path.resolve(pdf) + '.notes.json';
      const had = fs.existsSync(nf);
      const back = await js(`(async () => {
        const u = PDF_URL + '.notes.json';
        const put = await fetch(u, {method: 'PUT', body: JSON.stringify({version: 1, notes: {selftest: 'ok'}})});
        const get = await (await fetch(u, {cache: 'no-store'})).json();
        const bad = await fetch(PDF_URL.replace(/[^/]+$/, 'evil.txt'), {method: 'PUT', body: '{}'});
        return {put: put.status, get, outside: bad.status};
      })()`);
      console.log('SELFTEST notes', JSON.stringify(back));
      if (!had) fs.rmSync(nf, { force: true });
    }
  } catch (e) {
    console.log('SELFTEST error', e && e.stack || e);
  }
  app.quit();
}
