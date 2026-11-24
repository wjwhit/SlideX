// SlideX desktop app: the slide viewer in its own windows.
//
// A tiny HTTP server on 127.0.0.1 (byte ranges for video) serves the viewer
// and each opened deck's folder; Chromium windows show them. Opening a deck:
// File > Open, drag a PDF onto the window or the Dock icon, Finder "Open With",
// or `SlideX.app/Contents/MacOS/SlideX deck.pdf`.
'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, screen, shell, crashReporter } = require('electron');
const editor = require('./editor');
const notesLib = require('./notes');
const deckLib = require('./deck');
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

/* The log (app/log.js): ~/Library/Logs/<app name>/slidex.log. A window whose
 * page crashed is offered a reload instead of staying blank. */
const { log } = require('./log');
require('./log').init(app, { crashReporter, onWindowGone: (wc, d) => {
  const win = BrowserWindow.fromWebContents(wc);
  if (!win || win.isDestroyed()) return;
  const isEditor = editors.has(wc.id);
  dialog.showMessageBox(win, { type: 'warning', buttons: ['Reload', 'Close Window'], defaultId: 0,
    message: `This ${isEditor ? 'editor' : 'window'} stopped (${d.reason}).`,
    detail: (isEditor ? 'Unsaved edits in it may be lost; your .tex on disk is as last saved. ' : '')
      + 'Details are in the log: Help > Show Log File.' })
    .then(({ response }) => { if (win.isDestroyed()) return; if (response === 0) wc.reload(); else win.close(); });
} });

/* Every IPC handler logs what it throws (the window still gets the error). */
{
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => handle(channel, async (...args) => {
    try { return await fn(...args); } catch (err) { log.error(`${channel}:`, err); throw err; }
  });
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

/* ------------------------------------------------------------ deck check */
/* Before a talk: every movie the PDF links to is there, readable, inside the
 * folder SlideX serves, and in a format Chromium plays (checked with ffprobe
 * when it is installed, else by extension). Returns {problems, notes}. */
const PLAYABLE_VIDEO = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1']);
const PLAYABLE_FORMAT = /(mp4|mov|m4v|webm|matroska|gif)/;
function ffprobe(file) {
  const env = { ...process.env, PATH: ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || ''].join(':') };
  try {
    const out = require('child_process').execFileSync('ffprobe', ['-v', 'error', '-show_entries',
      'stream=codec_type,codec_name,width,height:format=format_name,duration', '-of', 'json', file], { env, timeout: 15000, encoding: 'utf8' });
    return JSON.parse(out);
  } catch (err) { return err.code === 'ENOENT' ? null : { error: String(err.stderr || err.message).trim().split('\n')[0] }; }
}
function checkDeck(pdfPath) {
  const problems = [], notes = [];
  if (!fs.existsSync(pdfPath)) return { problems: [`The PDF is missing: ${pdfPath}`], notes };
  const { root, movies } = deckRoot(pdfPath);
  const dir = path.dirname(pdfPath);
  let probed = 0, noProbe = false;
  for (const mv of [...new Set(movies)]) {
    if (/^[a-z]+:/i.test(mv)) { notes.push(`${mv}: a web address, needs a network connection`); continue; }
    const f = path.resolve(dir, mv);
    if (!fs.existsSync(f)) { problems.push(`${mv}: missing`); continue; }
    try { fs.accessSync(f, fs.constants.R_OK); } catch { problems.push(`${mv}: not readable`); continue; }
    if (!fs.statSync(f).size) { problems.push(`${mv}: empty file`); continue; }
    if (!inside(root, f)) problems.push(`${mv}: outside the folder SlideX serves (${root}); move it next to the PDF`);
    if (/\.gif$/i.test(mv)) { probed++; continue; }
    const p = noProbe ? null : ffprobe(f);
    if (p === null) { noProbe = true; if (!/\.(mp4|m4v|mov|webm)$/i.test(mv)) problems.push(`${mv}: not a movie format SlideX plays (mp4, mov, webm, gif)`); continue; }
    if (p.error) { problems.push(`${mv}: cannot be read as a movie (${p.error})`); continue; }
    probed++;
    const v = (p.streams || []).find((x) => x.codec_type === 'video');
    const fmt = (p.format && p.format.format_name) || '';
    if (!v) problems.push(`${mv}: no video in it`);
    else if (!PLAYABLE_VIDEO.has(v.codec_name) || !PLAYABLE_FORMAT.test(fmt)) problems.push(`${mv}: ${v.codec_name} in ${fmt.split(',')[0]} will not play; re-encode with slidemovie.py encode (H.264 mp4)`);
  }
  notes.unshift(movies.length ? `${new Set(movies).size} movie(s) linked${noProbe ? ' (ffprobe not found: formats checked by file name only)' : `, ${probed} checked`}` : 'No movies in this deck');
  const tex = editor.findSource(pdfPath);
  if (tex) {
    try {
      const text = fs.readFileSync(tex, 'utf8');
      const n = editor.parseFrames(text).filter((f) => { const x = notesLib.findNote(text, f); return x && x.text.trim(); }).length;
      notes.push(`Speaker notes: in ${path.basename(tex)} (${n} frame${n === 1 ? '' : 's'} with a note)`);
    } catch { /* unreadable source */ }
  } else if (fs.existsSync(pdfPath + '.notes.json')) notes.push(`Speaker notes: in ${path.basename(pdfPath)}.notes.json`);
  return { problems, notes };
}
async function checkDeckDialog(w) {
  const pdfPath = w && (deckOf.get(w.webContents.id) || (editors.get(w.webContents.id) || {}).pdfPath);
  if (!pdfPath) { dialog.showMessageBox(w, { message: 'Open a deck first, then choose Check Deck.' }); return; }
  const r = checkDeck(pdfPath);
  log.info(`check deck ${pdfPath}: ${r.problems.length} problem(s)`);
  await dialog.showMessageBox(w, { type: r.problems.length ? 'warning' : 'info',
    message: r.problems.length ? `${path.basename(pdfPath)}: ${r.problems.length} problem${r.problems.length === 1 ? '' : 's'}` : `${path.basename(pdfPath)} is ready to present`,
    detail: [...r.problems.map((p) => '• ' + p), ...(r.problems.length ? [''] : []), ...r.notes].join('\n') });
}

/* ---------------------------------------------------------------- windows */
const deckOf = new Map();   // webContents id -> pdf path

function openDeck(pdfPath, opts = {}) {
  pdfPath = path.resolve(pdfPath);
  log.info('open deck', pdfPath);
  if (!fs.existsSync(pdfPath)) { log.warn('no such file', pdfPath); dialog.showErrorBox('SlideX', `No such file:\n${pdfPath}`); return null; }
  const { root, movies, missing } = deckRoot(pdfPath);
  let idx = decks.indexOf(root);
  if (idx < 0) { decks.push(root); idx = decks.length - 1; }
  const rel = path.relative(root, pdfPath).split(path.sep).map(encodeURIComponent).join('/');
  const url = `http://127.0.0.1:${port}/viewer/index.html?pdf=/deck/${idx}/${rel}`;
  app.addRecentDocument(pdfPath);
  addRecent(pdfPath);
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

const deckChildren = new Map();   // deck window id -> its presenter windows

/* A deck window and its presenter windows: hidden together while editing. */
function deckWindows(deck) {
  if (!deck || deck.isDestroyed()) return [];
  return [deck, ...[...(deckChildren.get(deck.id) || [])].filter((w) => !w.isDestroyed())];
}
/* Hiding a full-screen window on macOS leaves its (black) full-screen Space
 * behind. So leave full screen first, hide once the animation is over, and
 * remember it: showing the window again puts it back in full screen. */
function hideWindow(w) {
  return new Promise((resolve) => {
    if (!w || w.isDestroyed()) return resolve();
    if (!w.isFullScreen()) { w.hide(); return resolve(); }
    w.slidexWasFullScreen = true;
    let done = false;
    const finish = () => { if (done) return; done = true; setTimeout(() => { if (!w.isDestroyed()) w.hide(); resolve(); }, 80); };
    w.once('leave-full-screen', finish);
    setTimeout(finish, 1500);                      // in case the event never comes
    w.setFullScreen(false);
  });
}
function showWindow(w, { focus = true } = {}) {
  if (!w || w.isDestroyed()) return;
  if (focus) { w.show(); w.focus(); } else w.showInactive();
  if (w.slidexWasFullScreen) {
    w.slidexWasFullScreen = false;
    setTimeout(() => { if (!w.isDestroyed()) w.setFullScreen(true); }, 120);
  }
}
async function hideDeck(deck) { await Promise.all(deckWindows(deck).map(hideWindow)); }
function showDeck(deck) {
  const ws = deckWindows(deck);
  for (const w of ws.slice(1)) showWindow(w, { focus: false });   // presenter windows first, behind
  if (ws[0]) showWindow(ws[0]);
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
    if (deckOf.has(wc.id)) {                     // a deck's presenter window
      if (!deckChildren.has(win.id)) deckChildren.set(win.id, new Set());
      deckChildren.get(win.id).add(child);
      child.on('closed', () => { const set = deckChildren.get(win.id); if (set) set.delete(child); });
    }
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

function showWelcome(opts = {}) {
  const win = new BrowserWindow({
    width: 940, height: 600, minWidth: 700, minHeight: 480, backgroundColor: '#121315', title: 'SlideX', show: !opts.hidden,
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
  return openSourcePath(r.filePaths[0], win);
}
async function openSourcePath(tex, win) {
  const pdf = tex.replace(/\.tex$/i, '.pdf');
  const stale = !fs.existsSync(pdf) || fs.statSync(pdf).mtimeMs < fs.statSync(tex).mtimeMs;
  if (stale) {
    const busy = new BrowserWindow({ width: 420, height: 120, frame: false, resizable: false, backgroundColor: '#1b1d21' });
    busy.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:%231b1d21;color:%23ddd;font:14px -apple-system,sans-serif">Building ' + path.basename(tex) + '…</body>'));
    const c = await editor.compileDeck(tex);
    busy.destroy();
    log.info(`built ${path.basename(tex)} to open it: ${c.ok ? 'ok' : `${(c.errors || []).length} error(s)`} in ${((c.ms || 0) / 1000).toFixed(1)} s`);
    if (!fs.existsSync(pdf)) {
      const noTex = /ENOENT|not found|command not found/i.test(String(c.log || '')) || (c.errors || []).some((e) => /ENOENT/.test(e.message));
      dialog.showErrorBox('SlideX', 'The deck did not build:\n' + (noTex ? 'pdflatex was not found. Install a TeX distribution (MacTeX: tug.org/mactex) and try again.'
        : (c.errors.slice(0, 5).map((e) => (e.line ? 'line ' + e.line + ': ' : '') + e.message).join('\n') || 'see the .log file')));
      return;
    }
  }
  const welcome = win && !win.isDestroyed() && win.webContents.getURL().includes('/viewer/welcome.html') ? win : null;
  const deckWin = openDeck(pdf, { reuse: welcome });
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
  log.info('open editor', texPath);
  addRecent(pdfPath, texPath);
  for (const [id, st] of editors) {
    if (st.texPath === texPath && !st.win.isDestroyed()) {   // back to edit mode
      st.deckWin = deckWin;
      await hideDeck(deckWin);                     // out of full screen first, then hidden
      showWindow(st.win);
      st.win.webContents.send('slidex-ed:shown');
      return;
    }
  }
  const { root } = deckRoot(pdfPath);
  const win = new BrowserWindow({
    width: 1500, height: 920, backgroundColor: '#1b1d21', title: 'SlideX editor: ' + path.basename(texPath),
    show: !process.argv.includes('--selftest') && !process.argv.includes('--shots'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  setupWindow(win);
  const st = { win, texPath, pdfPath, root: path.dirname(texPath) === root || path.dirname(texPath).startsWith(root + path.sep) ? root : path.dirname(texPath),
    deckUrl: urlFor(root, pdfPath), frames: [], sync: null, syncFrame: null, deckWin };
  editors.set(win.webContents.id, st);
  st.id = win.webContents.id;
  // A page with unsaved edits refuses to unload, and Electron then cancels the
  // close without a word: ask instead.
  win.webContents.on('will-prevent-unload', (ev) => {
    const test = process.env.SLIDEX_SELFTEST_CLOSEANSWER;   // self-test: 0 save, 1 don't save, 2 cancel
    if (!test && (process.argv.includes('--selftest') || process.argv.includes('--shots'))) { ev.preventDefault(); return; }
    const r = test ? +test : dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Save', 'Don\u2019t Save', 'Cancel'], defaultId: 0, cancelId: 2,
      message: `Save your changes to ${path.basename(texPath)}?`, detail: 'Your edits in the editor have not been saved to the file.' });
    if (r === 1) { writeRecovery(texPath, null); ev.preventDefault(); }            // close without saving
    else if (r === 0) {                                                            // save, then close
      win.webContents.executeJavaScript('save().then((ok) => ok !== false)').then((ok) => { if (ok && !win.isDestroyed()) win.close(); }).catch((err) => log.error(err));
    }
  });
  win.on('closed', () => {                       // editing over: bring the deck back
    unwatchSource(st);
    editors.delete(st.id);
    // one-slide builds are only for the open editor (unless another editor has this deck)
    if (![...editors.values()].some((o) => o.texPath === st.texPath)) editor.cleanBuildDir(st.texPath, { keepJob: null });
    if (st.deckWin && !st.deckWin.isDestroyed() && !st.deckWin.isVisible()) showDeck(st.deckWin);
  });
  win.once('ready-to-show', () => { hideDeck(deckWin).then(() => { if (!win.isDestroyed() && win.isVisible()) win.focus(); }); });   // edit mode: only the editor
  win.loadURL(`http://127.0.0.1:${port}/viewer/editor.html`);
}

/* ---- the .tex on disk while an editor has it open */
/* Polled once a second (fs.watch loses a file replaced by an atomic save, as
 * editors and iCloud do). A change this editor did not make is sent to it. */
function watchSource(st) {
  if (st.watching) return;
  st.watching = (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size) return;
    let text = null;
    try { text = fs.readFileSync(st.texPath, 'utf8'); } catch { /* removed or being replaced */ }
    if (text == null) { if (!cur.nlink) st.win.webContents.send('slidex-ed:disk', { gone: true }); return; }
    if (text === st.diskText) return;
    log.info('changed on disk', st.texPath);
    if (!st.win.isDestroyed()) st.win.webContents.send('slidex-ed:disk', { text });
  };
  fs.watchFile(st.texPath, { interval: 1000 }, st.watching);
}
function unwatchSource(st) { if (st.watching) { fs.unwatchFile(st.texPath, st.watching); st.watching = null; } }

/* Unsaved edits, copied every few seconds to .slidex/recovery/<deck>.tex and
 * offered back when the editor opens again (after a crash or a forced quit). */
function recoveryFile(texPath) { return path.join(editor.buildDir(texPath), 'recovery', path.basename(texPath)); }
function writeRecovery(texPath, text) {
  const f = recoveryFile(texPath);
  try {
    if (text == null) { fs.rmSync(f, { force: true }); return; }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', text); fs.renameSync(f + '.tmp', f);
  } catch (err) { log.warn('recovery copy not written:', err); }
}
function readRecovery(texPath) {
  const f = recoveryFile(texPath);
  try { return { text: fs.readFileSync(f, 'utf8'), time: fs.statSync(f).mtimeMs }; } catch { return null; }
}
function discardRecovery(texPath) {             // kept in backups/, not deleted
  const f = recoveryFile(texPath);
  if (!fs.existsSync(f)) return;
  const dir = path.join(editor.buildDir(texPath), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  try { fs.renameSync(f, path.join(dir, `${path.basename(texPath, '.tex')}-unsaved-${stamp}.tex`)); } catch (err) { log.warn(err); }
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
    if (deckOf.get(w.webContents.id) === pdfPath) for (const d of deckWindows(w)) d.webContents.reload();
  }
}

/* Errors in the single-frame .vrb copy point at the frame body's lines. */
function mapErrors(st, errors, r = {}) {
  const bdir = editor.buildDir(st.texPath);
  const toSrc = editor.vrbMapper({ texPath: st.texPath, srcPath: r.srcPath, oneSlideStart: r.frameStart, oneSlideEnd: r.frameEnd, job: r.job });
  return errors.map((e) => {
    const vl = e.file && /\.vrb$/.test(e.file) ? toSrc(e.file, e.line) : null;
    if (vl != null) return { ...e, line: vl, file: st.texPath };
    // the one-slide copy in .slidex/ keeps the deck's line numbers
    if (e.file && /\.tex$/.test(e.file) && path.resolve(path.dirname(st.texPath), e.file).startsWith(bdir + path.sep)) return { ...e, file: st.texPath };
    if (e.file && path.resolve(path.dirname(st.texPath), e.file) !== st.texPath) return { ...e, line: null, message: `${path.basename(e.file)}:${e.line}: ${e.message}` };
    return e;
  });
}

ipcMain.handle('slidex-ed:init', async (e) => {
  const st = edState(e);
  const text = fs.readFileSync(st.texPath, 'utf8');
  st.diskText = text;                                      // what this editor last read or wrote
  watchSource(st);
  st.frames = editor.parseFrames(text);
  const pf = await pageFrames(st).catch(() => []);
  let deckPage = 0;
  try { deckPage = await st.deckWin.webContents.executeJavaScript('window.slidex ? slidex.page : 0'); } catch { /* closed */ }
  const rec = readRecovery(st.texPath);
  return { texName: path.basename(st.texPath), text, frames: st.frames, deckUrl: st.deckUrl, pageFrames: pf, deckPage, prefs: getPrefs(),
    recovery: rec && rec.text !== text ? rec : null };
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
  return { ok: r.ok, probes: r.probes, url: r.pdf ? urlFor(st.root, r.pdf) : null, key: r.key, name: r.name, exact: !!(st.sync && st.sync.exact),
    frames: st.frames, errors: mapErrors(st, r.errors || [], r), ms: r.ms, fmt: r.fmt, log: tailLog(r.log) };
});

ipcMain.handle('slidex-ed:compileDeck', async (e, text, force) => {
  const st = edState(e);
  if (writeSource(st, text, force).conflict) return { conflict: true, frames: st.frames || [], errors: [] };
  st.frames = editor.parseFrames(text);
  const r = await editor.compileDeck(st.texPath);
  if (r.built) reloadDeckWindows(st.pdfPath);
  log.info(`deck build ${r.ok ? 'ok' : 'with errors'} in ${(r.ms / 1000).toFixed(1)} s: ${path.basename(st.texPath)}`
    + (r.errors && r.errors.length ? ` (${r.errors.length} error(s), first: ${String(r.errors[0].message).slice(0, 120)})` : ''));
  const pf = await pageFrames(st).catch(() => []);
  return { ok: r.ok, built: r.built, frames: st.frames, errors: mapErrors(st, r.errors || []), ms: r.ms, pageFrames: pf, log: tailLog(r.log) };
});

/* Saves refuse to overwrite a .tex that changed on disk since this editor
 * last read or wrote it (another editor, a script, a sync), unless forced. */
function writeSource(st, text, force) {
  let disk = null;
  try { disk = fs.readFileSync(st.texPath, 'utf8'); } catch { /* gone: write it */ }
  if (!force && disk != null && st.diskText != null && disk !== st.diskText && disk !== text) return { conflict: true };
  st.diskText = text;
  editor.saveSource(st.texPath, text);
  writeRecovery(st.texPath, null);
  return { ok: true };
}
ipcMain.handle('slidex-ed:save', (e, text, force) => {
  const st = edState(e);
  const w = writeSource(st, text, force);
  if (w.conflict) { log.warn('save refused: changed on disk', st.texPath); return { conflict: true }; }
  st.frames = editor.parseFrames(text);
  return { frames: st.frames };
});
ipcMain.handle('slidex-ed:acceptDisk', (e, text) => { edState(e).diskText = text; });
ipcMain.handle('slidex-ed:readDisk', (e) => { try { return fs.readFileSync(edState(e).texPath, 'utf8'); } catch { return null; } });
ipcMain.handle('slidex-ed:recovery', (e, text) => writeRecovery(edState(e).texPath, text));
ipcMain.handle('slidex-ed:discardRecovery', (e) => discardRecovery(edState(e).texPath));

/* Present: hide the editor, bring the deck forward on the editor's frame. */
ipcMain.handle('slidex-ed:present', async (e, key) => {
  const st = edState(e);
  let deck = st.deckWin && !st.deckWin.isDestroyed() ? st.deckWin : null;
  if (!deck) { deck = openDeck(st.pdfPath); st.deckWin = deck; }
  const page = (st.pageFrames || []).indexOf(key);
  if (page >= 0) deck.webContents.executeJavaScript(`window.slidex && slidex.goto(${page})`).catch(() => {});
  await hideWindow(st.win);
  showDeck(deck);
});

/* What completion needs: files near the deck, the URL they are served at
 * (for thumbnails), and the commands and environments the deck defines. */
/* A file or folder dropped on the editor: into figures/, converted if needed. */
ipcMain.handle('slidex-ed:importMedia', async (e, src) => {
  const st = edState(e);
  try {
    const r = await editor.importMedia(st.texPath, src);
    if (r.kind === 'movie') {
      const bundled = [path.join(__dirname, 'latex', 'slidemovie.sty'), path.join(__dirname, '..', 'latex', 'slidemovie.sty')].find((f) => fs.existsSync(f));
      if (await editor.ensureSlidemovieSty(st.texPath, bundled)) r.notes.push('copied slidemovie.sty next to the deck');
    }
    return r;
  } catch (err) { return { error: err.message }; }
});

ipcMain.handle('slidex-ed:projectInfo', async (e, text) => {
  const st = edState(e);
  const dir = path.dirname(st.texPath);
  const base = urlFor(st.root, path.join(dir, 'x')).replace(/x$/, '');
  return { files: await editor.listFiles(st.texPath), baseUrl: base, ...editor.scanMacros(st.texPath, text) };
});

ipcMain.handle('slidex-ed:lineAt', (e, page, x, y) => {
  const st = edState(e);
  return st.sync ? st.sync.lineAt(page, x, y) : null;
});

ipcMain.handle('slidex-ed:boxesForLine', (e, line, opts) => {
  const st = edState(e);
  return st.sync ? st.sync.boxesForLine(line, opts || {}) : [];
});

/* ------------------------------------------------------ speaker notes */
/* Notes live in the deck's .tex as \note{...} (app/notes.js). The page ->
 * frame map is taken when the presenter loads and kept: adding notes moves
 * lines but not frames. Decks without a .tex keep <deck>.pdf.notes.json. */
const noteMaps = new Map();       // pdf path -> {tex, pages}
function deckPdfFor(sender) {
  const w = BrowserWindow.fromWebContents(sender);
  if (!w) return null;
  if (deckOf.has(w.webContents.id)) return deckOf.get(w.webContents.id);
  for (const [id, set] of deckChildren) if (set.has(w)) { const d = BrowserWindow.fromId(id); return d ? deckOf.get(d.webContents.id) : null; }
  return null;
}

ipcMain.handle('slidex:notesLoad', async (e) => {
  const pdfPath = deckPdfFor(e.sender);
  const tex = pdfPath && editor.findSource(pdfPath);
  if (!tex) return null;
  try {
    const text = fs.readFileSync(tex, 'utf8');
    const frames = editor.parseFrames(text);
    const pages = await editor.pageFrameIndices(tex, frames);
    if (!pages.length) return null;
    noteMaps.set(pdfPath, { tex, pages });
    const notes = {};
    for (const f of frames) { const n = notesLib.findNote(text, f); if (n && n.text.trim()) notes[f.index] = n.text; }
    return { tex: path.basename(tex), pages, notes };
  } catch { return null; }
});

ipcMain.handle('slidex:notesSave', async (e, page, note) => {
  const pdfPath = deckPdfFor(e.sender);
  const map = pdfPath && noteMaps.get(pdfPath);
  if (!map) return { ok: false, error: 'no source' };
  try {
    const text = fs.readFileSync(map.tex, 'utf8');
    const frames = editor.parseFrames(text);
    const frame = frames[map.pages[page]];
    if (!frame) return { ok: false, error: 'no frame for this page' };
    const next = notesLib.setNote(text, frame, note);
    if (next !== text) {
      editor.saveSource(map.tex, next);
      for (const st of editors.values()) if (st.texPath === map.tex && st.diskText === text) st.diskText = next;
    }
    for (const st of editors.values()) {            // an open editor gets the same change in its buffer
      if (st.texPath === map.tex && !st.win.isDestroyed()) st.win.webContents.send('slidex-ed:note', { key: editor.frameKey(frame), note });
    }
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

/* Deck settings panel (app/deck.js): read from the editor's text, and one
 * edit at a time returned as a change for the editor to apply. */
ipcMain.handle('slidex-ed:deckInfo', (e, text) => deckLib.info(edState(e).texPath, text));
ipcMain.handle('slidex-ed:deckEdit', (e, text, edit) => notesLib.change(text, deckLib.apply(edState(e).texPath, text, edit)));

ipcMain.handle('slidex-ed:noteChange', (e, text, key, note) => {
  const frame = editor.parseFrames(text).find((f) => editor.frameKey(f) === key);
  if (!frame) return null;
  try { return notesLib.change(text, notesLib.setNote(text, frame, note)); } catch { return null; }
});

ipcMain.handle('slidex:edit', (e) => openEditor(BrowserWindow.fromWebContents(e.sender)));

/* Page -> frame key for a deck window's slide panel, from the deck's source
 * and SyncTeX (null when there is no source or no build to map from). */
ipcMain.handle('slidex:frameGroups', async (e) => {
  const pdfPath = deckOf.get(e.sender.id);
  const tex = pdfPath && editor.findSource(pdfPath);
  if (!tex) return null;
  try {
    const frames = editor.parseFrames(fs.readFileSync(tex, 'utf8'));
    const keys = await editor.pageFrames(tex, frames);       // from beamer's .nav, else SyncTeX
    return keys.length ? keys : null;
  } catch { return null; }
});

/* ------------------------------------------------------- start screen */
/* Recent decks (prefs), new decks from templates, the example deck, docs. */
const DOCS_URL = 'https://github.com/wjwhit/SlideX/blob/main/docs/README.md';
const TEMPLATES = [
  { id: 'talk', name: 'Talk', about: 'Title slide, outline, sections, conclusions and a backup slide', file: 'talk.tex' },
  { id: 'update', name: 'Short update', about: 'A title slide and three plain slides', file: 'update.tex' },
  { id: 'example', name: 'Example deck', about: 'Movies, overlays, figures, boxes and a TikZ node: the deck the docs use', example: true },
];
const bundled = (rel) => [path.join(__dirname, rel), path.join(__dirname, '..', rel)].find((p) => fs.existsSync(p));
function addRecent(pdf, tex) {
  if (process.argv.includes('--selftest') || process.argv.includes('--shots')) return;     // tests do not touch your list
  const list = (getPrefs()['slidex.recent'] || []).filter((r) => r && r.pdf !== pdf);
  const prev = (getPrefs()['slidex.recent'] || []).find((r) => r && r.pdf === pdf);
  list.unshift({ pdf, tex: tex || (prev && prev.tex) || editor.findSource(pdf) || null, time: Date.now() });
  setPref('slidex.recent', list.slice(0, 12), true);
}
ipcMain.handle('slidex:welcomeInfo', () => {
  const home = os.homedir();
  return {
    version: app.getVersion(),
    templates: TEMPLATES.map(({ id, name, about }) => ({ id, name, about })),
    recent: (getPrefs()['slidex.recent'] || []).filter(Boolean).map((r) => ({ pdf: r.pdf, name: path.basename(r.pdf, '.pdf'),
      folder: path.dirname(r.pdf).replace(home, '~'), time: r.time, exists: fs.existsSync(r.pdf), tex: !!r.tex })),
  };
});
ipcMain.handle('slidex:forgetRecent', (e, pdf) => setPref('slidex.recent', (getPrefs()['slidex.recent'] || []).filter((r) => r && r.pdf !== pdf), true));
ipcMain.handle('slidex:openSource', (e) => openSource(BrowserWindow.fromWebContents(e.sender)));
ipcMain.handle('slidex:openDocs', () => shell.openExternal(DOCS_URL));
ipcMain.handle('slidex:newDeck', (e, id) => newDeck(BrowserWindow.fromWebContents(e.sender), id));
ipcMain.handle('slidex:openExample', (e) => openExample(BrowserWindow.fromWebContents(e.sender)));

/* Copy the bundled example deck (tex, pdf, media, figures) into dir. */
function copyExample(dir, texName = 'demo.tex') {
  const src = bundled('example');
  if (!src) throw new Error('The example deck is not in this build of SlideX.');
  fs.mkdirSync(dir, { recursive: true });
  for (const sub of ['media', 'figures']) if (fs.existsSync(path.join(src, sub))) fs.cpSync(path.join(src, sub), path.join(dir, sub), { recursive: true, force: false, errorOnExist: false });
  const tex = path.join(dir, texName);
  fs.copyFileSync(path.join(src, 'demo.tex'), tex);
  // the PDF last, so it is newer than the .tex and opens without a build
  if (fs.existsSync(path.join(src, 'demo.pdf'))) fs.copyFileSync(path.join(src, 'demo.pdf'), tex.replace(/\.tex$/, '.pdf'));
  return tex;
}
async function newDeck(win, id) {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) return;
  const r = process.env.SLIDEX_SELFTEST_SAVEAS ? { filePath: process.env.SLIDEX_SELFTEST_SAVEAS }      // self-test
    : await dialog.showSaveDialog(win || undefined, { title: `New deck: ${t.name}`, buttonLabel: 'Create',
    defaultPath: path.join(app.getPath('documents'), t.example ? 'example.tex' : 'talk.tex'), filters: [{ name: 'LaTeX', extensions: ['tex'] }] });
  if (r.canceled || !r.filePath) return;
  const tex = r.filePath.endsWith('.tex') ? r.filePath : r.filePath + '.tex';
  try {
    if (t.example) {
      const dir = path.dirname(tex);
      const clash = ['media', 'figures'].filter((d) => fs.existsSync(path.join(dir, d)));
      if (clash.length) {
        const ok = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Add the files', 'Cancel'], defaultId: 1,
          message: `${dir} already has ${clash.join(' and ')}/`, detail: 'The example\'s files are added there; files with the same name are kept, not replaced.' });
        if (ok !== 0) return;
      }
      copyExample(dir, path.basename(tex));
    } else {
      fs.copyFileSync(bundled(path.join('templates', t.file)), tex);
    }
  } catch (err) { log.error('new deck:', err); dialog.showErrorBox('SlideX', `The deck could not be created:\n${err.message}`); return; }
  log.info(`new deck (${t.id})`, tex);
  return openSourcePath(tex, win);
}
async function openExample(win) {
  const dir = path.join(app.getPath('documents'), 'SlideX Example');
  const tex = path.join(dir, 'demo.tex');
  try { if (!fs.existsSync(tex)) copyExample(dir); } catch (err) { dialog.showErrorBox('SlideX', err.message); return; }
  return openSourcePath(tex, win);
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
/* Editor settings (theme, code text size, output height) in <profile>/prefs.json:
 * the editor page's own storage is tied to the server's port, which changes. */
const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');
let prefs = null;
function getPrefs() { if (!prefs) { try { prefs = JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) || {}; } catch { prefs = {}; } } return prefs; }
function setPref(k, v, internal = false) {
  if (!/^slidex\.[A-Za-z]+$/.test(k) || (!internal && JSON.stringify(v).length > 200)) return;
  getPrefs()[k] = v;
  try { fs.writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2)); } catch (err) { log.warn('prefs not saved:', err); }
}
ipcMain.handle('slidex-ed:setPref', (e, k, v) => setPref(k, v));
function themeAll(t) {                                  // every editor window, and the next ones
  setPref('slidex.theme', t);
  for (const st of editors.values()) if (!st.win.isDestroyed()) editCommand(st.win, 'theme:' + t);
}
function editCommand(w, name) {
  if (!w) return;
  const wc = w.webContents;
  if (editors.has(wc.id)) { wc.executeJavaScript(`window.editorCommand && editorCommand(${JSON.stringify(name)})`).catch(() => {}); return; }
  if (/^(font|theme|deck)/.test(name)) return;             // code text size and theme: editor windows only
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
      { label: 'Check Deck…', click: (_, w) => checkDeckDialog(w) },
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
      { type: 'separator' },
      { label: 'Bigger Code Text', accelerator: 'CmdOrCtrl+=', click: (_, w) => editCommand(w, 'fontBigger') },
      { label: 'Smaller Code Text', accelerator: 'CmdOrCtrl+-', click: (_, w) => editCommand(w, 'fontSmaller') },
      { label: 'Default Code Text Size', accelerator: 'CmdOrCtrl+0', click: (_, w) => editCommand(w, 'fontReset') },
      { label: 'Deck Settings', accelerator: 'Shift+CmdOrCtrl+D', click: (_, w) => editCommand(w, 'deckSettings') },
      { label: 'Editor Theme', submenu: [
        { label: 'Follow macOS', click: () => themeAll('system') },
        { label: 'Light', click: () => themeAll('light') },
        { label: 'Dark', click: () => themeAll('dark') },
      ] },
      { type: 'separator' },
      { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/',
        click: (_, w) => w && w.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'?'}))") },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { role: 'reload' },
      { role: 'toggleDevTools' },
    ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'Show Log File', click: () => { if (log.file && fs.existsSync(log.file)) shell.showItemInFolder(log.file); } },
      { label: 'Open Log File', click: () => { if (log.file && fs.existsSync(log.file)) shell.openPath(log.file); } },
    ] },
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
  const si = process.argv.indexOf('--shots');
  if (si >= 0) {                                          // documentation screenshots (app/shots.js)
    return require('./shots')({ outDir: path.resolve(process.argv[si + 1]), pdf: path.resolve(files[0]), openDeck, openEditor, showWelcome,
      editorWindowFor: (deck) => { for (const st of editors.values()) if (st.deckWin === deck) return st.win; return null; }, deckChildren, app,
      prefs: { get: (k) => getPrefs()[k], set: (k, v) => setPref(k, v, true) } });
  }
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
    if (process.env.SLIDEX_SELFTEST_EVAL) {          // any check in the deck window
      console.log('SELFTEST eval', JSON.stringify(await js(process.env.SLIDEX_SELFTEST_EVAL)));
    }
    if (process.env.SLIDEX_SELFTEST_ROBUST) {        // the file on disk: outside edits, conflicts, recovery, closing
      const tex = editor.findSource(path.resolve(pdf));
      const orig = fs.readFileSync(tex, 'utf8');
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const openEd = async () => { await openEditor(win); await sleep(4000); return [...editors.values()].find((st) => st.texPath === tex); };
      let st = await openEd();
      const ejs = (c) => st.win.webContents.executeJavaScript(c);
      const out = {};
      // 1. an outside edit, editor clean: the editor follows the file
      console.log('ROBUST step', 1, Date.now() % 100000);
      fs.writeFileSync(tex, orig.replace('\\begin{document}', '% outside edit 1\n\\begin{document}'));
      await sleep(2500);
      out.cleanFollows = await ejs(`({ has: view.state.doc.toString().includes('% outside edit 1'), dirty: S.dirty })`);
      // 2. unsaved edits here, then an outside edit: a banner, nothing lost
      console.log('ROBUST step', 2, Date.now() % 100000);
      await ejs(`edit({ from: 0, insert: '% my edit\\n' }, 'test')`);
      fs.writeFileSync(tex, fs.readFileSync(tex, 'utf8').replace('% outside edit 1', '% outside edit 2'));
      await sleep(2500);
      out.dirtyBanner = await ejs(`({ banner: !$('banner').hidden && $('banner').textContent.slice(0, 60), mine: view.state.doc.toString().startsWith('% my edit') })`);
      // 3. save without answering: refused, then the conflict banner
      console.log('ROBUST step', 3, Date.now() % 100000);
      await ejs(`hideBanner()`);
      out.saveRefused = await ejs(`save().then((ok) => ({ ok, banner: !$('banner').hidden && $('banner').textContent.slice(0, 50) }))`);
      out.diskUntouched = fs.readFileSync(tex, 'utf8').includes('% outside edit 2') && !fs.readFileSync(tex, 'utf8').includes('% my edit');
      // 4. a recovery copy appears; the window dies; reopening offers it
      console.log('ROBUST step', 4, Date.now() % 100000);
      await ejs(`edit({ from: 0, insert: '% unsaved\\n' }, 'test')`);
      await sleep(3500);
      const rf = path.join(editor.buildDir(tex), 'recovery', path.basename(tex));
      out.recoveryWritten = fs.existsSync(rf) && fs.readFileSync(rf, 'utf8').startsWith('% unsaved');
      st.win.destroy(); await sleep(1500);
      st = await openEd();
      out.recoveryOffered = await st.win.webContents.executeJavaScript(`!$('banner').hidden && $('banner').textContent.slice(0, 50)`);
      // 5. closing with unsaved edits, answer "Save": the file gets them, the window closes
      console.log('ROBUST step', 5, Date.now() % 100000);
      await st.win.webContents.executeJavaScript(`hideBanner(); edit({ from: 0, insert: '% saved on close\\n' }, 'test')`);
      process.env.SLIDEX_SELFTEST_CLOSEANSWER = '0';
      st.win.close(); await sleep(2500);
      out.savedOnClose = { closed: st.win.isDestroyed(), inFile: fs.readFileSync(tex, 'utf8').startsWith('% saved on close') };
      delete process.env.SLIDEX_SELFTEST_CLOSEANSWER;
      fs.writeFileSync(tex, orig); fs.rmSync(rf, { force: true });
      console.log('SELFTEST robust', JSON.stringify(out));
    }
    if (process.env.SLIDEX_SELFTEST_NEWDECK) {        // a new deck from a template, saved where SLIDEX_SELFTEST_SAVEAS says
      let from = win;
      if (process.env.SLIDEX_SELFTEST_FROMWELCOME) {      // as from the start window, which becomes the deck window
        from = showWelcome({ hidden: true });
        await new Promise((r) => from.webContents.once('did-finish-load', r));
      }
      const before = new Set(BrowserWindow.getAllWindows().map((w) => w.id));
      await newDeck(from, process.env.SLIDEX_SELFTEST_NEWDECK);
      await new Promise((r) => setTimeout(r, 5000));
      const tex = process.env.SLIDEX_SELFTEST_SAVEAS;
      const st = [...editors.values()].find((x) => x.texPath === tex);
      console.log('SELFTEST newdeck', JSON.stringify({ tex: fs.existsSync(tex), pdf: fs.existsSync(tex.replace(/\.tex$/, '.pdf')),
        newWindows: BrowserWindow.getAllWindows().filter((w) => !before.has(w.id)).length, editor: !!st,
        status: st ? await st.win.webContents.executeJavaScript(`document.getElementById('status').textContent`) : null,
        editorState: st ? await st.win.webContents.executeJavaScript(`({ compiling: S.compiling, preview: !!S.preview, frames: S.frames.length, thumbs: document.querySelectorAll('#strip .thumb').length, err: (window.__err || null) })`) : null }));
    }
    if (process.env.SLIDEX_SELFTEST_CHECK) console.log('SELFTEST check', JSON.stringify(checkDeck(path.resolve(pdf))));
    if (process.env.SLIDEX_SELFTEST_CRASHLOG) {      // the log: a console error, an uncaught error, a renderer crash
      await js(`console.error('selftest console error'); setTimeout(() => { throw new Error('selftest uncaught error'); }, 0); 1`);
      await wait(500);
      win.webContents.forcefullyCrashRenderer();
      await wait(2500);
      const boxes = BrowserWindow.getAllWindows().length;
      const text = fs.readFileSync(log.file, 'utf8').split('\n').slice(-12).join('\n');
      console.log('SELFTEST crashlog', JSON.stringify({ file: log.file, consoleError: text.includes('selftest console error'),
        uncaught: text.includes('selftest uncaught error'), crash: /CRASH +window process gone/.test(text), windows: boxes }));
    }
    if (process.env.SLIDEX_SELFTEST_OPENEDITOR) {    // smoke test: open the editor, report, close (no edits, no saves)
      const errs = [];
      app.on('web-contents-created', (ev, wc) => wc.on('console-message', (e2, level, msg) => { if (level >= 3) errs.push(msg); }));
      process.on('uncaughtException', (err) => errs.push('main: ' + (err && err.stack || err)));
      const before = new Set(BrowserWindow.getAllWindows().map((w) => w.id));
      let opened = null;
      try { opened = await openEditor(win); } catch (err) { errs.push('openEditor: ' + (err && err.stack || err)); }
      await wait(12000);
      const ew = BrowserWindow.getAllWindows().find((w) => !before.has(w.id));
      let st = null;
      if (ew && !ew.isDestroyed()) {
        ew.webContents.on('console-message', (e2, level, msg) => { if (level >= 3) errs.push(msg); });
        st = await ew.webContents.executeJavaScript(`({ status: document.getElementById('status').textContent, frames: S.frames.length,
          preview: !!S.preview, dirty: S.dirty })`).catch((err) => 'eval failed: ' + err.message);
        if (process.env.SLIDEX_SELFTEST_EDITJS) {      // a check of your own, run in the editor
          const out = await ew.webContents.executeJavaScript(process.env.SLIDEX_SELFTEST_EDITJS).catch((err) => 'eval failed: ' + err.message);
          console.log('SELFTEST editjs', JSON.stringify(out));
        }
        if (process.env.SLIDEX_SELFTEST_EDITPNG) {     // a screenshot of the editor
          const img = await ew.webContents.capturePage();
          fs.writeFileSync(process.env.SLIDEX_SELFTEST_EDITPNG, img.toPNG());
          console.log('SELFTEST editpng', process.env.SLIDEX_SELFTEST_EDITPNG);
        }
        ew.destroy();
      }
      console.log('SELFTEST openeditor', JSON.stringify({ window: !!ew, destroyed: !ew, state: st, errors: errs }));
    }
    if (process.env.SLIDEX_SELFTEST_EDITOR) {        // editor: compile a frame, cursor and hover lookups
      const before = new Set(BrowserWindow.getAllWindows().map((w) => w.id));
      await openEditor(win);
      const ew = BrowserWindow.getAllWindows().find((w) => !before.has(w.id));
      if (!ew) throw new Error('editor did not open');
      const testTex = editors.get(ew.webContents.id).texPath;
      const testTexText = fs.readFileSync(testTex, 'utf8');     // put back exactly at the end
      const ejs = (code) => ew.webContents.executeJavaScript(code);
      for (let i = 0; i < 60; i++) { await wait(500); if (await ejs('!!(window.S && S.preview && S.preview.page)')) break; }
      const label = process.env.SLIDEX_SELFTEST_EDITOR;
      const res = await ejs(`(async () => {
        const f = S.frames.find((x) => frameKeyOf(x) === ${JSON.stringify(label)});
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
      if (process.env.SLIDEX_SELFTEST_BOXES) {           // box resizing, double-click editing, find
        const res = await ejs(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const settle = async () => { await sleep(700); for (let i = 0; i < 80 && (S.compiling || S.stale); i++) await sleep(100); await sleep(400); };
          const out = {};
          const goFrame = async (label, page) => {
            const f = S.frames.find((x) => x.label === label); gotoLine(f.bodyStart, false); await sleep(400); await settle();
            if (page && S.preview.page !== page) { S.preview.page = page; await showPreview(S.preview); }
            await findFigures();
          };
          const kinds = () => S.figs.map((f) => f.kind + '@' + f.line + ':' + Math.round(f.box.w) + 'x' + Math.round(f.box.h));
          // tcolorbox on setup
          await goFrame('setup');
          out.setupItems = kinds();
          const tb = S.figs.find((f) => f.kind === 'tcolorbox');
          if (tb) {
            const w0 = tb.box.w;
            resizeTcolorbox(tb, 0.8);
            out.tcolorboxLine = view.state.doc.line(tb.line).text.trim().match(/width=[^,\\]]*/)[0];
            await settle(); await findFigures();
            const tb2 = S.figs.find((f) => f.kind === 'tcolorbox' && f.line === tb.line);
            out.tcolorboxRatio = tb2 ? +(tb2.box.w / w0).toFixed(3) : null;
            CM.undo(view); await settle();
          }
          // \\keybox on planar, overlay step 2
          await goFrame('planar', 2);
          out.planarItems = kinds();
          let kb = S.figs.find((f) => f.kind === 'macrobox');
          if (kb) {
            const w0 = kb.box.w;
            resizeMacroBox(kb, 0.8);
            out.keyboxAfter1 = view.state.doc.toString().slice(kb.at - 4, kb.at + 70).replace(/\\s+/g, ' ');
            await settle(); S.preview.page = 2; await showPreview(S.preview); await findFigures();
            kb = S.figs.find((f) => f.kind === 'macrobox');
            out.keyboxRatio = kb ? +(kb.box.w / w0).toFixed(3) : null;
            if (kb) {
              resizeMacroBox(kb, 0.9);
              const t = view.state.doc.toString();
              out.keyboxAfter2 = (t.match(/\\\\makebox\\[\\\\linewidth\\]\\{\\\\begin\\{minipage\\}\\{[^}]*\\}/g) || []).join(' | ');
              CM.undo(view);
            }
            CM.undo(view); await settle();
          }
          // single click vs double-click on text
          await goFrame('setup');
          let item = null;
          for (let l = S.frame.start; l <= S.frame.end; l++) if (/^\\s*\\\\item\\b/.test(view.state.doc.line(l).text)) { item = l; break; }
          const b = (await api.boxesForLine(item)).find((x) => x.page === S.preview.page);
          const r = document.getElementById('pagewrap').getBoundingClientRect();
          const cx = r.left + (b.x + 8) * pv.scale, cy = r.top + (b.y + b.h / 2) * pv.scale;
          gotoLine(S.frame.start, false);
          document.getElementById('preview').dispatchEvent(new MouseEvent('click', { clientX: cx, clientY: cy, bubbles: true, detail: 1 }));
          await sleep(400);
          out.singleClick = { cursorLine: cursorLine(), item, popup: !popEl.hidden };
          document.getElementById('preview').dispatchEvent(new MouseEvent('dblclick', { clientX: cx, clientY: cy, bubbles: true, detail: 2 }));
          await sleep(500);
          out.doubleClick = { popup: !popEl.hidden, popupLine: popLine && popLine.line };
          if (!popEl.hidden) popTa.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          // find
          editorCommand('find'); await sleep(300);
          const inp = document.querySelector('.cm-search input[name=search]');
          out.find = { panel: !!document.querySelector('.cm-search'), focused: document.activeElement === inp, top: !!document.querySelector('.cm-panels-top .cm-search') };
          return out;
        })()`);
        console.log('SELFTEST boxes', JSON.stringify(res, null, 1));
      }
      if (process.env.SLIDEX_SELFTEST_FEATURES) {
        const media = process.env.SLIDEX_SELFTEST_FEATURES;      // a GIF to drop in
        const feat = await ejs(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const out = {};
          const settle = async () => { await sleep(700); for (let i = 0; i < 60 && (S.compiling || S.stale); i++) await sleep(100); await sleep(400); };
          // completion
          const L = view.state.doc.line(cursorLine());
          view.dispatch({ changes: { from: L.to, insert: ' \\\\keyb' }, selection: { anchor: L.to + 6 }, userEvent: 'input.type' });
          await sleep(500);
          out.completeCmd = [...document.querySelectorAll('.cm-tooltip-autocomplete li')].map((li) => li.textContent).slice(0, 3);
          CM.undo(view); await sleep(150);
          const L2 = view.state.doc.line(cursorLine());
          view.dispatch({ changes: { from: L2.to, insert: ' \\\\includegraphics{figures/cyl' }, selection: { anchor: L2.to + 29 }, userEvent: 'input.type' });
          await sleep(600);
          out.completeFiles = document.querySelectorAll('.cm-tooltip-autocomplete li').length;
          CM.undo(view); await settle();
          // resize: the frame's first figure, x0.8
          await findFigures();
          const f = S.figs[0];
          out.figure = f ? { line: f.line, w: Math.round(f.box.w) } : null;
          if (f) {
            const before = view.state.doc.line(f.line).text.trim();
            resizeFigure(f, 0.8);
            out.resizedLine = before + '  ->  ' + view.state.doc.line(f.line).text.trim();
            await settle(); await findFigures();
            const g = S.figs.find((x) => x.line === f.line);
            out.newWidthRatio = g ? +(g.box.w / f.box.w).toFixed(3) : null;
            CM.undo(view); await settle(); await findFigures();
          }
          // click-to-edit an \\item, then Enter at its end makes a new item
          let itemLine = null;
          for (let l = S.frame.start; l <= S.frame.end; l++) if (/^\\s*\\\\item\\b/.test(view.state.doc.line(l).text)) { itemLine = l; break; }
          if (itemLine) {
            await openTextEdit(itemLine);
            popTa.value = popTa.value + ' EDITED';
            popTa.setSelectionRange(popTa.value.length, popTa.value.length);
            popTa.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await sleep(200);
            out.editedLine = view.state.doc.line(itemLine).text.trim().slice(-20);
            out.newItemLine = view.state.doc.line(itemLine + 1).text;
            out.popupOnNewItem = !popEl.hidden && popLine && popLine.line === itemLine + 1;
            popTa.value = '\\\\item Second point'; popTa.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await sleep(100);
            CM.undo(view); CM.undo(view); await settle();
          }
          // captions
          await findFigures();
          out.captions = S.figs.map((x) => ({ line: x.line, caption: captionOf(x).line }));
          const nocap = S.figs.find((x) => !captionOf(x).line);
          if (nocap) {
            addCaption(nocap); await sleep(300);
            out.addedCaption = view.state.doc.line(nocap.line + 1).text.trim();
            out.captionPopup = !popEl.hidden;
            popTa.value = '{\\\\small A new caption}'; popTa.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await sleep(200);
            out.captionAfter = view.state.doc.line(nocap.line + 1).text.trim();
            CM.undo(view); CM.undo(view); await settle();
          }
          // drop-in media
          const before = view.state.doc.lines;
          await dropFiles([{ name: 'test.gif', path: ${JSON.stringify(media)} }], cursorLine());
          out.dropStatus = document.getElementById('status').textContent;
          out.dropLine = view.state.doc.line(cursorLine()).text.trim();
          out.linesAdded = view.state.doc.lines - before;
          return out;
        })()`);
        console.log('SELFTEST features', JSON.stringify(feat, null, 1));
      }
      const img = await ew.webContents.capturePage();
      const out = (process.env.SLIDEX_SELFTEST_PNG || path.join(os.tmpdir(), 'slidex-selftest.png')).replace(/\.png$/, '-editor.png');
      fs.writeFileSync(out, img.toPNG());
      console.log('SELFTEST editor screenshot', out);
      {                                    // mode switches: Present / Edit / Compile & Present / close
        const vis = () => ({ editor: ew.isVisible(), deck: win.isVisible(),
          presenter: [...(deckChildren.get(win.id) || [])].filter((c) => !c.isDestroyed()).map((c) => c.isVisible()) });
        await ejs(`S.dirty = false; api.present(frameKeyOf(S.frame))`); await wait(800);
        console.log('SELFTEST present', JSON.stringify({ ...vis(), deckPage: await js('slidex.page') }));
        await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }))`); await wait(1500);
        console.log('SELFTEST presenter opened', JSON.stringify(vis()));
        if (process.env.SLIDEX_SELFTEST_FULLSCREEN) {   // full screen: no black Space left behind
          win.setFullScreen(true); await wait(2000);
          const full0 = win.isFullScreen();
          await openEditor(win); await wait(1500);
          console.log('SELFTEST edit from full screen', JSON.stringify({ deckWasFull: full0, deckFull: win.isFullScreen(), ...vis() }));
          await ejs(`api.present(frameKeyOf(S.frame))`); await wait(2500);
          console.log('SELFTEST present back to full screen', JSON.stringify({ deckFull: win.isFullScreen(), ...vis() }));
          win.setFullScreen(false); await wait(2000);
          await openEditor(win); await wait(1000);
          ew.setFullScreen(true); await wait(2000);
          await ejs(`api.present(frameKeyOf(S.frame))`); await wait(2000);
          console.log('SELFTEST present from full-screen editor', JSON.stringify({ editorFull: ew.isFullScreen(), ...vis() }));
          await openEditor(win); await wait(2500);
          console.log('SELFTEST edit back to full-screen editor', JSON.stringify({ editorFull: ew.isFullScreen(), ...vis() }));
          ew.setFullScreen(false); await wait(2000);
        }
        await openEditor(win); await wait(800);
        console.log('SELFTEST edit', JSON.stringify(vis()));
        const t0 = Date.now();
        await ejs(`(() => { const l = view.state.doc.line(cursorLine()); view.dispatch({ changes: { from: l.to, insert: ' X' } });
          setTimeout(() => document.getElementById('btn-compile-present').click(), 500); })()`);   // click while Live compiles
        for (let i = 0; i < 80 && ew.isVisible(); i++) await wait(250);
        console.log('SELFTEST compile and present', JSON.stringify({ ...vis(), seconds: ((Date.now() - t0) / 1000).toFixed(1) }));
        await openEditor(win); await wait(800);
        await wait(500);
        ew.close(); await wait(800);
        if (fs.readFileSync(testTex, 'utf8') !== testTexText) {          // Compile & Present saved the test edits
          fs.writeFileSync(testTex, testTexText);
          console.log('SELFTEST restored', testTex);
        }
        console.log('SELFTEST editor closed', JSON.stringify({ deck: win.isVisible() }));
        win.hide();
        for (const c of deckChildren.get(win.id) || []) if (!c.isDestroyed()) c.close();
      }
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
    if (process.env.SLIDEX_SELFTEST_TEXNOTES) {   // notes in the .tex, from the presenter, with the editor open
      const tex = editor.findSource(path.resolve(pdf));
      const orig = fs.readFileSync(tex, 'utf8');
      const nf = path.resolve(pdf) + '.notes.json';
      fs.writeFileSync(nf, JSON.stringify({ version: 1, notes: { 'slide 3': 'from the json' } }));   // to be moved into the .tex
      await openEditor(win); await wait(4000);
      const ew = [...editors.values()].find((st) => st.texPath === tex).win;
      await js(`slidex.goto(1)`); await wait(800);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }))`); await wait(3000);
      const pres = [...(deckChildren.get(win.id) || [])][0];
      const pjs = (c) => pres.webContents.executeJavaScript(c);
      const r1 = await pjs(`(async () => { await new Promise((r) => setTimeout(r, 500));
        const m = document.getElementById('memo'); m.value = 'Typed 50% in the presenter'; m.dispatchEvent(new Event('input'));
        await new Promise((r) => setTimeout(r, 1200));
        return { status: document.getElementById('memo-status').textContent, label: document.getElementById('memo-label').textContent }; })()`);
      const disk = fs.readFileSync(tex, 'utf8');
      const buf = await ew.webContents.executeJavaScript(`({ text: view.state.doc.toString(), dirty: S.dirty })`);
      const json = JSON.parse(fs.readFileSync(nf, 'utf8'));
      console.log('SELFTEST texnotes', JSON.stringify({ ...r1, inTex: disk.includes('\\note{Typed 50\\% in the presenter}'),
        movedFromJson: disk.includes('\\note{from the json}'), jsonLeft: json.notes, editorHasIt: buf.text === disk, editorDirty: buf.dirty }));
      pres.close(); ew.destroy();
      fs.writeFileSync(tex, orig); fs.rmSync(nf, { force: true });
    }
  } catch (e) {
    console.log('SELFTEST error', e && e.stack || e);
  }
  app.quit();
}
