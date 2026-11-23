/* SlideX presenting tools: laser pointer, magnifier, the toolbars, and
 * speaker notes typed in the presenter window.
 *
 * Works on the "primary" view of each window: the slide in the audience
 * window, the current slide in the presenter window. Pointer positions are
 * sent between the windows as fractions of the full PDF page, so they land on
 * the same spot whatever the window sizes. Loaded after viewer.js, whose
 * globals (views, viewFor, cur, chan, renderPage, MODE, pageLabels, ...) it uses. */
'use strict';

const tools = {
  tool: null,            // null | 'laser' | 'lens'
  ptr: null,             // {fx, fy} on the full page, or null when off the slide
  zoom: 2.5,             // magnifier power
  hiRes: null,           // {page, width, canvas, pending} sharp page for the magnifier
};

function primaryView() { return MODE === 'audience' ? viewFor.main : viewFor.current; }

/* Page-fraction <-> screen mapping for a view. */
function viewMap(v) {
  if (!v || !v.div || !v.geom) return null;
  const r = v.div.getBoundingClientRect();
  const g = v.geom;
  return {
    r, g,
    toFrac: (x, y) => ({ fx: ((x - r.left) - g.shift) / g.cw, fy: (y - r.top) / g.ch }),
    toScreen: (fx, fy) => ({ x: r.left + fx * g.cw + g.shift, y: r.top + fy * g.ch }),
    inside: (x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom,
  };
}

/* ------------------------------------------------------------- elements */
const laserEl = document.createElement('div');
laserEl.className = 'laser';
laserEl.hidden = true;
const lensEl = document.createElement('div');
lensEl.className = 'lens';
lensEl.hidden = true;
const lensCanvas = document.createElement('canvas');
lensEl.appendChild(lensCanvas);
document.body.append(laserEl, lensEl);

/* ----------------------------------------------------------- tool state */
function setTool(t, broadcast = true) {
  tools.tool = tools.tool === t ? null : t;
  syncToolUi();
  if (broadcast) chan.postMessage({ type: 'tool', tool: tools.tool });
}

function syncToolUi() {
  document.body.classList.toggle('tool-on', !!tools.tool);
  for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === tools.tool);
  if (!tools.tool) tools.ptr = null;
  if (tools.tool === 'lens') prepareHiRes();          // render the sharp page now, not on first move
  scheduleDraw();
}

function setPointer(p, broadcast = true) {
  tools.ptr = p;
  scheduleDraw();
  if (broadcast) sendPointer();
}
let ptrTimer = 0, ptrPending = false;
function sendPointer() {                          // at most ~60 messages a second
  if (ptrTimer) { ptrPending = true; return; }
  chan.postMessage({ type: 'ptr', ptr: tools.ptr, zoom: tools.zoom });
  ptrTimer = setTimeout(() => { ptrTimer = 0; if (ptrPending) { ptrPending = false; sendPointer(); } }, 16);
}

/* ------------------------------------------------------------- drawing */
/* One draw per screen refresh, however many mouse events arrive. The timeout
 * covers windows the system stops refreshing (e.g. covered ones). */
let drawQueued = false;
function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  let done = false;
  const run = () => { if (done) return; done = true; drawQueued = false; drawPointer(); };
  (window.nativeRAF || setTimeout)(run);
  setTimeout(run, 50);
}

function drawPointer() {
  const v = primaryView();
  const map = viewMap(v);
  const p = tools.ptr;
  laserEl.hidden = !(tools.tool === 'laser' && p && map);
  lensEl.hidden = !(tools.tool === 'lens' && p && map);
  if (!map || !p) return;
  const { x, y } = map.toScreen(p.fx, p.fy);
  if (tools.tool === 'laser') {
    const d = Math.round(Math.max(10, 0.013 * map.g.vw));
    if (laserEl._d !== d) { laserEl.style.width = laserEl.style.height = d + 'px'; laserEl._d = d; }
    laserEl.style.transform = `translate3d(${x - d / 2}px, ${y - d / 2}px, 0)`;
  } else if (tools.tool === 'lens') {
    drawLens(v, map, x, y);
  }
}

function lensSize(map) { return Math.round(Math.min(Math.max(0.26 * map.g.vw, 140), 460)); }
function hiResWidth(map) { return Math.min(map.g.cw * tools.zoom, 4096 / (window.devicePixelRatio || 1)); }

/* Sharp copy of the current page for the magnifier, rendered once per page. */
function prepareHiRes() {
  const v = primaryView();
  const map = viewMap(v);
  if (!map) return;
  const want = hiResWidth(map);
  const h = tools.hiRes;
  if (h && h.page === v.index && (h.pending || h.width >= want * 0.95)) return;
  const page = v.index;
  tools.hiRes = { page, width: want, canvas: h && h.page === page ? h.canvas : null, pending: true };
  renderPage(page, want).then((c) => {
    if (tools.hiRes && tools.hiRes.page === page) {
      tools.hiRes = { page, width: want, canvas: c, pending: false };
      scheduleDraw();
    }
  });
}

function drawLens(v, map, x, y) {
  const D = lensSize(map);
  const dpr = window.devicePixelRatio || 1;
  if (lensEl._D !== D) {
    lensCanvas.width = lensCanvas.height = Math.round(D * dpr);
    lensEl.style.width = lensEl.style.height = D + 'px';
    lensEl._D = D;
  }
  lensEl.style.transform = `translate3d(${x - D / 2}px, ${y - D / 2}px, 0)`;
  const ctx = lensCanvas.getContext('2d');
  const W = lensCanvas.width;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, W);
  const p = tools.ptr;
  const pw = map.g.cw * tools.zoom, ph = map.g.ch * tools.zoom;   // magnified page, css px
  const ox = D / 2 - p.fx * pw, oy = D / 2 - p.fy * ph;           // page origin in the lens
  // copy only the patch under the lens from the sharp page (or the on-screen one)
  if (!tools.hiRes || tools.hiRes.page !== v.index) prepareHiRes();
  const src = (tools.hiRes && tools.hiRes.page === v.index && tools.hiRes.canvas) || v.div.querySelector('canvas');
  if (src) {
    const sx = src.width / pw, sy = src.height / ph;               // source px per lens css px
    ctx.drawImage(src, -ox * sx, -oy * sy, D * sx, D * sy, 0, 0, W, W);
  }
  let moving = false;
  for (const el of v.active.values()) {                            // movies, current frame
    if (!el._sm || (el.tagName !== 'VIDEO' && el.tagName !== 'IMG')) continue;
    if (el.tagName === 'VIDEO' && el.readyState < 2) continue;
    const b = el._sm.m.box;
    const rx = ox + b.l * pw, ry = oy + b.t * ph, rw = b.w * pw, rh = b.h * ph;
    if (rx > D || ry > D || rx + rw < 0 || ry + rh < 0) continue;  // not under the lens
    try { ctx.drawImage(el, rx * dpr, ry * dpr, rw * dpr, rh * dpr); } catch { /* not ready */ }
    if (el.tagName === 'IMG' || !el.paused) moving = true;
  }
  if (moving) setTimeout(scheduleDraw, 33);                       // follow the movie, ~30 fps
}

/* ------------------------------------------------------------- pointer */
const within = (e, sel) => !!(e.target && e.target.closest && e.target.closest(sel));
document.addEventListener('mousemove', (e) => {
  if (!tools.tool) return;
  const map = viewMap(primaryView());
  if (map && map.inside(e.clientX, e.clientY)) setPointer(map.toFrac(e.clientX, e.clientY));
  else if (tools.ptr) setPointer(null);
});

document.addEventListener('wheel', (e) => {       // magnifier power
  if (tools.tool !== 'lens' || !tools.ptr) return;
  e.preventDefault();
  tools.zoom = Math.min(6, Math.max(1.5, tools.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
  prepareHiRes();
  scheduleDraw();
  sendPointer();
}, { passive: false });

/* Toolbar on the projector: shows while the mouse moves, gone 0.8 s after. */
let barTimer = 0, overBar = false;
function showBar() {
  document.body.classList.add('bar-on');
  clearTimeout(barTimer);
  if (!overBar) barTimer = setTimeout(() => document.body.classList.remove('bar-on'), 800);
}
document.addEventListener('mousemove', showBar);
for (const bar of document.querySelectorAll('.toolbar')) {
  bar.addEventListener('mouseenter', () => { overBar = true; showBar(); });
  bar.addEventListener('mouseleave', () => { overBar = false; showBar(); });
}

/* ---------------------------------------------------------------- keys */
function leaveFullscreen() {
  if (window.slidexApp && window.slidexApp.exitFullscreen) { window.slidexApp.exitFullscreen(); return true; }
  if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return true; }
  return false;
}

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) {   // typing notes
    if (e.key === 'Escape') t.blur();
    e.stopPropagation();                             // keep slide keys out of the text
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  let used = true;
  switch (e.key) {
    case 'l': case 'L': setTool('laser'); break;
    case 'm': case 'M': setTool('lens'); break;
    case 'Escape':
      // in order: a page number being typed, the help, a tool, then full screen
      if (typeof typed !== 'undefined' && typed) used = false;     // viewer.js clears it
      else if (!$('help').hidden) $('help').hidden = true;
      else if (tools.tool) setTool(null);
      else leaveFullscreen();
      break;
    case 'e': case 'E':
      if (MODE === 'presenter') { $('memo').focus(); } else used = false;
      break;
    default: used = false;
  }
  if (used) { e.preventDefault(); e.stopPropagation(); }
}, true);

/* ------------------------------------------------------------- toolbar */
document.addEventListener('click', (e) => {
  const b = within(e, '.toolbar button') ? e.target.closest('.toolbar button') : null;
  if (!b) return;
  e.stopPropagation();
  const a = b.dataset.tool || b.dataset.act;
  if (b.dataset.tool) setTool(a);
  else if (a === 'restart') moviesAction('restart');
  else if (a === 'presenter') openPresenter();
  else if (a === 'edit' && window.slidexApp && window.slidexApp.edit) window.slidexApp.edit();
  else if (a === 'help') $('help').hidden = !$('help').hidden;
  b.blur();
});

/* ------------------------------------------------------ speaker notes */
const notes = { data: {}, url: PDF_URL + '.notes.json', key: null, timer: 0 };

function noteKey(i) { return pageLabels && pageLabels[i] ? 'slide ' + pageLabels[i] : 'page ' + (i + 1); }

async function loadNotes() {
  try {
    const r = await fetch(notes.url, { cache: 'no-store' });
    if (r.ok) { const j = await r.json(); notes.data = (j && j.notes) || {}; }
  } catch { /* no notes yet */ }
}

function showNote(i) {
  if (MODE !== 'presenter') return;
  const key = noteKey(i);
  $('memo-label').textContent = key;
  if (key === notes.key) return;                   // same frame (an overlay step): keep the text
  flushNotes();
  notes.key = key;
  $('memo').value = notes.data[key] || '';
}

function flushNotes() {
  if (!notes.timer) return;
  clearTimeout(notes.timer);
  notes.timer = 0;
  saveNotes();
}

async function saveNotes() {
  const status = $('memo-status');
  const body = JSON.stringify({ version: 1, pdf: decodeURIComponent(PDF_URL.split('/').pop()), notes: notes.data }, null, 2);
  try {
    const r = await fetch(notes.url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    status.textContent = 'saved';
    status.className = 'ok';
  } catch (err) {
    status.textContent = 'not saved (' + err.message + ')';
    status.className = 'bad';
  }
}

if (MODE === 'presenter') {
  $('memo').addEventListener('input', () => {
    const v = $('memo').value;
    if (v) notes.data[notes.key] = v; else delete notes.data[notes.key];
    $('memo-status').textContent = 'editing';
    $('memo-status').className = '';
    clearTimeout(notes.timer);
    notes.timer = setTimeout(() => { notes.timer = 0; saveNotes(); }, 600);
  });
  $('memo').addEventListener('blur', flushNotes);
  addEventListener('beforeunload', flushNotes);
}

/* ------------------------------------------------------------ messages */
chan.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'tool') { tools.tool = d.tool; syncToolUi(); }
  else if (d.type === 'ptr') { if (d.zoom) tools.zoom = d.zoom; tools.ptr = d.ptr; scheduleDraw(); }
  else if (d.type === 'hello' && MODE === 'audience') chan.postMessage({ type: 'tool', tool: tools.tool });
});

/* ---------------------------------------------------------------- hooks */
window.smHooks = {
  async start() { if (MODE === 'presenter') await loadNotes(); },
  pageChanging(i) {
    tools.hiRes = null;
    showNote(i);
  },
  viewShown(v) {
    if (v === primaryView()) {
      if (tools.tool === 'lens') prepareHiRes();
      scheduleDraw();
    }
    if (MODE === 'presenter' && v === viewFor.current) showNote(v.index);
  },
};

/* The Edit button exists only in the desktop app. */
if (!(window.slidexApp && window.slidexApp.edit)) for (const b of document.querySelectorAll('.app-only')) b.remove();
