// SlideX desktop app: the slide viewer in its own windows.
//
// A tiny HTTP server on 127.0.0.1 (byte ranges for video) serves the viewer
// and each opened deck's folder; Chromium windows show them. Opening a deck:
// File > Open, drag a PDF onto the window or the Dock icon, Finder "Open With",
// or `SlideX.app/Contents/MacOS/SlideX deck.pdf`.
'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, screen, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');

const VIEWER = path.join(__dirname, 'viewer');
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
function buildMenu() {
  const template = [
    { role: 'appMenu' },
    { label: 'File', submenu: [
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: (_, w) => chooseDeck(w) },
      { role: 'recentDocuments', submenu: [{ role: 'clearRecentDocuments' }] },
      { type: 'separator' },
      { label: 'Show in Finder', click: (_, w) => { const p = w && deckOf.get(w.webContents.id); if (p) shell.showItemInFolder(p); } },
      { type: 'separator' },
      { role: 'close' },
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
