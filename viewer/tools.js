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
/* The laser's tail: recent positions (page fractions, with times) drawn as a
 * tapering, fading streak on a full-window canvas behind the dot. */
const tailCanvas = document.createElement('canvas');
tailCanvas.className = 'laser-tail';
const TAIL_MS = 140;
const tail = [];                                   // [{fx, fy, t}]
document.body.append(tailCanvas, laserEl, lensEl);

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
  if (laserEl.hidden && tail.length) { tail.length = 0; tailCanvas.getContext('2d').clearRect(0, 0, tailCanvas.width, tailCanvas.height); }
  lensEl.hidden = !(tools.tool === 'lens' && p && map);
  if (!map || !p) return;
  const { x, y } = map.toScreen(p.fx, p.fy);
  if (tools.tool === 'laser') {
    const d = Math.round(Math.max(10, 0.013 * map.g.vw));
    if (laserEl._d !== d) { laserEl.style.width = laserEl.style.height = d + 'px'; laserEl._d = d; }
    laserEl.style.transform = `translate3d(${x - d / 2}px, ${y - d / 2}px, 0)`;
    const last = tail[tail.length - 1];
    if (!last || last.fx !== p.fx || last.fy !== p.fy) tail.push({ fx: p.fx, fy: p.fy, t: performance.now() });
    drawTail(map, d);
  } else if (tools.tool === 'lens') {
    drawLens(v, map, x, y);
  }
}

function drawTail(map, d) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(innerWidth * dpr), H = Math.round(innerHeight * dpr);
  if (tailCanvas.width !== W || tailCanvas.height !== H) { tailCanvas.width = W; tailCanvas.height = H; }
  const ctx = tailCanvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const now = performance.now();
  while (tail.length && now - tail[0].t > TAIL_MS) tail.shift();
  if (tools.tool !== 'laser' || !map || tail.length < 2) { if (tail.length && tools.tool === 'laser') setTimeout(scheduleDraw, 16); return; }
  // One tapered ribbon, filled once (separate strokes would overlap and show
  // darker dots at their joints): narrow at the old end, as wide as half the
  // dot at the head, fading in along its length.
  const pts = tail.map((q) => map.toScreen(q.fx, q.fy));
  const n = pts.length;
  const half = (i) => (d * 0.28) * ((i + 1) / n) * (1 - (now - tail[i].t) / TAIL_MS * 0.5);
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let nx = -(b.y - a.y), ny = b.x - a.x;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    const w = half(i);
    left.push({ x: pts[i].x + nx * w, y: pts[i].y + ny * w });
    right.push({ x: pts[i].x - nx * w, y: pts[i].y - ny * w });
  }
  const edge = left.concat(right.reverse());
  ctx.beginPath();
  ctx.moveTo(edge[0].x * dpr, edge[0].y * dpr);
  for (let i = 1; i < edge.length; i++) {       // smooth through midpoints
    const p0 = edge[i - 1], p1 = edge[i];
    ctx.quadraticCurveTo(p0.x * dpr, p0.y * dpr, (p0.x + p1.x) / 2 * dpr, (p0.y + p1.y) / 2 * dpr);
  }
  ctx.closePath();
  const head = pts[n - 1], end = pts[0];
  const grad = ctx.createLinearGradient(end.x * dpr, end.y * dpr, head.x * dpr, head.y * dpr);
  grad.addColorStop(0, 'rgba(255, 40, 40, 0)');
  grad.addColorStop(1, 'rgba(255, 40, 40, 0.55)');
  ctx.fillStyle = grad;
  ctx.fill();
  setTimeout(scheduleDraw, 16);                     // keep fading after the pointer stops
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
      else if (!$('slides-panel').hidden) toggleSlides(false);
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
  else if (a === 'slides') toggleSlides();
  else if (a === 'edit' && window.slidexApp && window.slidexApp.edit) window.slidexApp.edit();
  else if (a === 'help') $('help').hidden = !$('help').hidden;
  b.blur();
});

/* ------------------------------------------------------- slide panel */
/* One thumbnail per frame, drawn as it scrolls into view. Frames come from the
 * deck's source when the app can map pages to frames (SyncTeX); otherwise
 * consecutive pages with the same beamer frame number form a frame (long runs,
 * e.g. appendix pages all labelled 0, are shown page by page). */
const slides = { groups: null, items: [], observer: null };

async function frameGroups() {
  let keys = null;
  try { if (window.slidexApp && window.slidexApp.frameGroups) keys = await window.slidexApp.frameGroups(); } catch { /* not available */ }
  if (!keys || keys.length !== nPages) {
    keys = [];
    let run = 0;
    for (let i = 0; i < nPages; i++) {
      const lab = pageLabels ? pageLabels[i] : String(i + 1);
      run = i > 0 && keys[i - 1] && keys[i - 1].startsWith(lab + '|') ? run + 1 : 0;
      keys.push(lab + '|' + (run >= 8 ? i : (i - run)));          // long runs: one per page
    }
  }
  const groups = [];
  keys.forEach((k, i) => {
    const g = groups[groups.length - 1];
    if (g && k != null && g.key === k) g.pages.push(i); else groups.push({ key: k == null ? '#p' + i : k, pages: [i] });
  });
  return groups;
}

async function toggleSlides(open) {
  const panel = $('slides-panel');
  open = open === undefined ? panel.hidden : open;
  panel.hidden = !open;
  document.body.classList.toggle('slides-open', open);
  for (const b of document.querySelectorAll('[data-act="slides"]')) b.classList.toggle('active', open);
  if (!open) return;
  if (!slides.groups) await buildSlides();
  markSlides(true);
}

async function buildSlides() {
  const panel = $('slides-panel');
  slides.groups = await frameGroups();
  panel.innerHTML = '';
  slides.items = slides.groups.map((g, n) => {
    const item = document.createElement('div');
    item.className = 'sp-item';
    const c = document.createElement('canvas');
    const cap = document.createElement('div');
    cap.className = 'sp-cap';
    const lab = pageLabels && pageLabels[g.pages[0]];
    cap.textContent = `${n + 1}` + (g.pages.length > 1 ? `  ·  ${g.pages.length} steps` : '') + (lab && lab !== String(n + 1) ? `  ·  frame ${lab}` : '');
    item.append(c, cap);
    item.onclick = () => goto(g.pages[0]);
    item.dataset.n = n;
    panel.appendChild(item);
    return { item, c, g, drawn: false };
  });
  slides.observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) drawSlide(slides.items[+e.target.dataset.n]);
  }, { root: panel, rootMargin: '400px 0px' });
  for (const it of slides.items) slides.observer.observe(it.item);
}

async function drawSlide(it) {
  if (it.drawn) return;
  it.drawn = true;
  const page = it.g.pages[it.g.pages.length - 1];       // the frame's last step: everything shown
  const inf = await info(page);
  const half = slideHalf();
  const w = $('slides-panel').clientWidth - 26;
  const dpr = window.devicePixelRatio || 1;
  const c = await renderPage(page, (half ? 2 : 1) * w);
  const cw = half ? c.width / 2 : c.width;
  it.c.width = Math.round(w * dpr); it.c.height = Math.round(w * dpr * inf.h / (inf.w * (half ? 0.5 : 1)));
  it.c.getContext('2d').drawImage(c, half === 'right' ? c.width / 2 : 0, 0, cw, c.height, 0, 0, it.c.width, it.c.height);
}

function markSlides(scroll) {
  if (!slides.items.length) return;
  for (const it of slides.items) {
    const on = it.g.pages.includes(cur);
    it.item.classList.toggle('on', on);
    if (on && scroll) it.item.scrollIntoView({ block: 'center' });
  }
}

/* ------------------------------------------------------ speaker notes */
/* In the app, a deck with its .tex keeps notes there, as \note{...} in each
 * frame (app/notes.js); notes.tex = {tex, pages: page -> frame index, notes}.
 * Otherwise (no source, or the browser viewer) notes go to
 * <deck>.pdf.notes.json, keyed by beamer's page label. Notes found in that
 * file for a frame with a source are moved into the .tex. */
const notes = { data: {}, url: PDF_URL + '.notes.json', key: null, page: 0, timer: 0, tex: null, json: {} };
const appNotes = window.slidexApp && window.slidexApp.notesLoad ? window.slidexApp : null;

function pageLabel(i) { return pageLabels && pageLabels[i] ? 'slide ' + pageLabels[i] : 'page ' + (i + 1); }
function noteKey(i) {
  const k = notes.tex && notes.tex.pages[i];
  return k != null && k !== undefined ? 'frame ' + k : pageLabel(i);
}

async function loadNotes() {
  try {
    const r = await fetch(notes.url, { cache: 'no-store' });
    if (r.ok) { const j = await r.json(); notes.json = (j && j.notes) || {}; }
  } catch { /* no notes file */ }
  notes.data = { ...notes.json };
  if (!appNotes) return;
  try { notes.tex = await appNotes.notesLoad(); } catch { notes.tex = null; }
  if (!notes.tex) return;
  for (const [k, v] of Object.entries(notes.tex.notes)) notes.data['frame ' + k] = v;
  // move notes from the .json into the .tex
  let moved = 0;
  for (let i = 0; i < notes.tex.pages.length; i++) {
    const k = notes.tex.pages[i];
    const old = notes.json[pageLabel(i)];
    if (k == null || !old) continue;
    if (!notes.data['frame ' + k]) {
      const r = await appNotes.notesSave(i, old);
      if (!r || !r.ok) continue;
      notes.data['frame ' + k] = old;
    }
    delete notes.json[pageLabel(i)];
    moved++;
  }
  if (moved) await putJson();
}

function showNote(i) {
  if (MODE !== 'presenter') return;
  const key = noteKey(i);
  $('memo-label').textContent = pageLabel(i);
  if (key === notes.key) return;                   // same frame (an overlay step): keep the text
  flushNotes();
  notes.key = key;
  notes.page = i;
  $('memo').value = notes.data[key] || '';
}

function flushNotes() {
  if (!notes.timer) return;
  clearTimeout(notes.timer);
  notes.timer = 0;
  saveNotes();
}

async function putJson() {
  const body = JSON.stringify({ version: 1, pdf: decodeURIComponent(PDF_URL.split('/').pop()), notes: notes.json }, null, 2);
  const r = await fetch(notes.url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
  if (!r.ok) throw new Error('HTTP ' + r.status);
}

async function saveNotes() {
  const status = $('memo-status');
  const key = notes.key, v = notes.data[key] || '';
  try {
    if (key && key.startsWith('frame ')) {
      const r = await appNotes.notesSave(notes.page, v);
      if (!r || !r.ok) throw new Error((r && r.error) || 'not saved');
      status.textContent = 'saved in ' + notes.tex.tex;
    } else {
      if (v) notes.json[key] = v; else delete notes.json[key];
      await putJson();
      status.textContent = 'saved';
    }
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
    setTimeout(() => markSlides(!$('slides-panel').hidden), 0);
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
