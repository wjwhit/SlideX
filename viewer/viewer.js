/* SlideX viewer: pdf.js pages, plus real <video> elements on top of the
 * posters that the slidemovie LaTeX package (slidemovie.sty) leaves in the PDF. */
'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

/* pdf.js paces page rendering with requestAnimationFrame, which browsers stop
 * in background or covered windows (a presenter window behind another, a
 * projector window the OS thinks is occluded). Nothing else here animates, so
 * run those callbacks on a message channel instead: never throttled. */
window.nativeRAF = window.requestAnimationFrame.bind(window);   // kept for smooth pointer tools
(() => {
  const ch = new MessageChannel();
  const queue = [];
  ch.port1.onmessage = () => { const cbs = queue.splice(0); for (const cb of cbs) cb(performance.now()); };
  window.requestAnimationFrame = (cb) => { queue.push(cb); if (queue.length === 1) ch.port2.postMessage(0); return queue.length; };
})();

const params = new URLSearchParams(location.search);
const PDF_URL = new URL(params.get('pdf') || '', location.href).href;
const MODE = params.get('mode') === 'presenter' ? 'presenter' : 'audience';
const chan = new BroadcastChannel('slidex:' + PDF_URL);
const $ = (id) => document.getElementById(id);

let pdf = null;
let nPages = 0;
let cur = 0;                 // 0-based page index
let notesSide = null;        // beamer "show notes on second screen": 'right'|'left'|null
let pageLabels = null;       // beamer: the frame number of each page (overlays share one)

/* ------------------------------------------------------------ page data */
const infoCache = new Map();
function info(i) {
  if (!infoCache.has(i)) infoCache.set(i, loadInfo(i));
  return infoCache.get(i);
}
async function loadInfo(i) {
  const page = await pdf.getPage(i + 1);
  const vp = page.getViewport({ scale: 1 });
  const annots = await page.getAnnotations({ intent: 'display' });
  const links = [], movies = [];
  for (const a of annots) {
    if (a.subtype !== 'Link') continue;
    const box = fracBox(vp, a.rect);
    const href = a.unsafeUrl || a.url || '';
    const k = href.indexOf('#slidemovie');
    if (k >= 0) movies.push(parseMovie(href, k, box, vp));
    else links.push({ box, dest: a.dest, url: a.url || a.unsafeUrl });
  }
  return { page, w: vp.width, h: vp.height, links, movies };
}
function fracBox(vp, rect) {
  const [x1, y1, x2, y2] = vp.convertToViewportRectangle(rect);
  const l = Math.min(x1, x2), t = Math.min(y1, y2);
  return { l: l / vp.width, t: t / vp.height,
           w: Math.abs(x2 - x1) / vp.width, h: Math.abs(y2 - y1) / vp.height };
}
function parseMovie(href, k, box, vp) {
  const file = href.slice(0, k);
  const o = { autoplay: true, loop: true, audio: false, controls: false,
              cont: true, rate: 1, start: 0, end: null, slider: false, frame: 'first' };
  for (const tok of href.slice(k + 1).split(';').slice(1)) {
    const [key, val] = tok.split('=');
    if (key === 'noautoplay') o.autoplay = false;
    else if (key === 'noloop') o.loop = false;
    else if (key === 'audio') o.audio = true;
    else if (key === 'controls') o.controls = true;
    else if (key === 'slider') o.slider = true;
    else if (key === 'frame') o.frame = val;
    else if (key === 'w') o.w = parseFloat(val);
    else if (key === 'h') o.h = parseFloat(val);
    else if (key === 'restart') o.cont = false;
    else if (key === 'rate') o.rate = parseFloat(val) || 1;
    else if (key === 'start') o.start = parseFloat(val) || 0;
    else if (key === 'end') o.end = parseFloat(val);
  }
  // Exact poster size (bp) from the package: center it in the padded link box.
  if (vp && o.w > 0 && o.h > 0) {
    const fw = o.w / vp.width, fh = o.h / vp.height;
    if (fw <= box.w + 1e-6 && fh <= box.h + 1e-6) {
      box = { l: box.l + (box.w - fw) / 2, t: box.t + (box.h - fh) / 2, w: fw, h: fh };
    }
  }
  let src;
  try { src = new URL(file, PDF_URL).href; } catch (e) { src = file; }
  return { file, src, box, opts: o, gif: /\.gif$/i.test(file) };
}

/* --------------------------------------------------------- page rendering */
const canvasCache = new Map();   // key -> Promise<canvas>, small LRU
function renderPage(i, cssW) {
  const dpr = window.devicePixelRatio || 1;
  const key = `${i}|${Math.round(cssW)}|${dpr}`;
  if (canvasCache.has(key)) {
    const p = canvasCache.get(key);
    canvasCache.delete(key); canvasCache.set(key, p);   // mark recent
    return p;
  }
  const p = (async () => {
    const inf = await info(i);
    const vp = inf.page.getViewport({ scale: (cssW / inf.w) * dpr });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await inf.page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return c;
  })();
  canvasCache.set(key, p);
  while (canvasCache.size > 14) canvasCache.delete(canvasCache.keys().next().value);
  return p;
}

/* Geometry of page i shown in a container; half = null | 'left' | 'right'. */
function geometry(container, inf, half) {
  const W = container.clientWidth, H = container.clientHeight;
  const frac = half ? 0.5 : 1;
  const s = Math.min(W / (inf.w * frac), H / inf.h);
  const cw = inf.w * s, ch = inf.h * s;          // full page, css px
  const vw = cw * frac;                           // visible width
  return { s, cw, ch, vw, left: (W - vw) / 2, top: (H - ch) / 2,
           shift: half === 'right' ? -cw / 2 : 0 };
}

/* ------------------------------------------------------------- movie pool */
const pool = new Map();    // src -> [preloaded <video>]
function poolTake(src) {
  const list = pool.get(src);
  if (!list || !list.length) return null;
  const v = list.pop();
  if (!list.length) pool.delete(src);
  return v;
}
function poolPut(v) {
  const n = [...pool.values()].reduce((a, l) => a + l.length, 0);
  if (n >= 6) return disposeEl(v);
  v.pause();
  v.remove();
  if (!pool.has(v.dataset.src)) pool.set(v.dataset.src, []);
  pool.get(v.dataset.src).push(v);
}
function disposeEl(el) {
  if (el.tagName === 'VIDEO') {
    el.pause(); el.removeAttribute('src'); el.load();
  }
  el.remove();
}
function newVideo(src) {
  const v = document.createElement('video');
  v.dataset.src = src;
  v.preload = 'auto';
  v.muted = true;
  v.playsInline = true;
  v.src = src;
  return v;
}
async function preloadMovies(i) {
  if (i < 0 || i >= nPages) return;
  const inf = await info(i);
  for (const m of inf.movies) {
    if (m.gif || pool.has(m.src)) continue;
    if (document.querySelector(`.movies video[data-src="${CSS.escape(m.src)}"]`)) continue;
    poolPut(newVideo(m.src));
  }
}

function missingBox(m, why, el) {
  const d = document.createElement('div');
  if (el) d.style.cssText = el.style.cssText;   // keep the movie's place
  d.className = 'missing';
  d.textContent = `${why}: ${m.file}`;
  return d;
}

function makeMovie(m, forceMute) {
  const o = m.opts;
  if (m.gif) {
    const img = document.createElement('img');
    img.dataset.src = m.src;
    img.onerror = () => img.replaceWith(missingBox(m, 'cannot load', img));
    img.src = m.src;
    img._sm = { m, gifRun: 0 };
    return img;
  }
  const v = poolTake(m.src) || newVideo(m.src);
  v.muted = forceMute || !o.audio;
  v.controls = o.controls;
  v.defaultPlaybackRate = o.rate;
  v.playbackRate = o.rate;
  v.loop = o.loop && !o.start && o.end == null;
  v._sm = { m };
  v.onerror = () => v.replaceWith(missingBox(m, 'cannot play', v));
  v.ontimeupdate = () => {
    if (o.end != null && v.currentTime >= o.end) {
      if (o.loop) v.currentTime = o.start; else v.pause();
    }
  };
  v.onended = () => { if (o.loop && !v.loop) { v.currentTime = o.start; v.play(); } };
  return v;
}

/* Time of the frame= option (first, middle, last or seconds) in the window. */
function frameTime(el) {
  const o = el._sm.m.opts;
  const end = o.end != null ? o.end : (isFinite(el.duration) ? el.duration : o.start);
  if (o.frame === 'last') return Math.max(o.start, end - 0.001);
  if (o.frame === 'middle') return (o.start + end) / 2;
  const t = parseFloat(o.frame);
  return isFinite(t) ? t : o.start;
}

function startMovie(el) {
  const m = el._sm && el._sm.m;
  if (!m) return;
  if (m.gif) {                         // restart the GIF from frame one
    el.src = m.src + (m.src.includes('?') ? '&' : '?') + 'r=' + (++el._sm.gifRun);
    return;
  }
  const go = () => {
    el.currentTime = m.opts.start;
    el.playbackRate = m.opts.rate;
    const p = el.play();
    if (p) p.catch(() => {
      if (!el.muted) { el.muted = true; el.play().catch(() => {}); toast('sound blocked by the browser: press a key first'); }
    });
  };
  if (el.readyState >= 1) go(); else el.addEventListener('loadedmetadata', go, { once: true });
}

/* ------------------------------------------------------- movie control */
/* Every play/pause/seek goes through movieOp so the other window (presenter
 * or audience) does the same thing to the same movie. */
function movieOp(el, op, t, broadcast = true) {
  if (el.tagName !== 'VIDEO') {
    if (op === 'restart' || op === 'play') startMovie(el);
  } else if (op === 'restart') startMovie(el);
  else if (op === 'seek') el.currentTime = t;
  else if (op === 'play') {
    if (t != null) el.currentTime = t;
    el.play().catch(() => {});
  } else if (op === 'pause') {
    el.pause();
    if (t != null) el.currentTime = t;
  }
  if (broadcast) chan.postMessage({ type: 'mop', page: cur, idx: el._sm.idx, op,
                                    t: el.tagName === 'VIDEO' ? el.currentTime : null });
}
function isDone(el) {
  const o = el._sm.m.opts;
  return el.ended || (o.end != null && el.currentTime >= o.end - 0.05);
}
function togglePlay(el) {
  if (el.tagName !== 'VIDEO') return movieOp(el, 'restart');
  if (isDone(el)) movieOp(el, 'restart');          // finished: replay the window
  else movieOp(el, el.paused ? 'play' : 'pause');
}
function fmtTime(x) {
  x = Math.max(0, x || 0);
  return `${Math.floor(x / 60)}:${(x % 60).toFixed(1).padStart(4, '0')}`;
}

/* The slider bar along the bottom edge of a movie. */
function makeBar(el) {
  const m = el._sm.m;
  const bar = document.createElement('div');
  bar.className = 'mbar';
  bar.innerHTML = '<button type="button" class="mb-play"></button>'
    + '<input type="range" min="0" max="1000" step="1" value="0">'
    + '<span class="mb-time"></span>';
  const [btn, rng, txt] = bar.children;
  const span = () => {
    const s = m.opts.start;
    const e = m.opts.end != null ? m.opts.end : (isFinite(el.duration) ? el.duration : s + 1);
    return [s, Math.max(e, s + 1e-3)];
  };
  let dragging = false, wasPlaying = false;
  rng.tabIndex = -1;                       // keys stay with slide navigation
  const seek = () => {
    const [s, e] = span();
    movieOp(el, 'seek', s + (e - s) * rng.value / 1000);
    txt.textContent = fmtTime(el.currentTime - s) + ' / ' + fmtTime(e - s);
  };
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    window.removeEventListener('pointerup', endDrag, true);
    window.removeEventListener('pointercancel', endDrag, true);
    rng.blur();
    if (wasPlaying) movieOp(el, 'play');
  };
  rng.addEventListener('pointerdown', () => {
    dragging = true; wasPlaying = !el.paused;
    if (wasPlaying) movieOp(el, 'pause');
    window.addEventListener('pointerup', endDrag, true);
    window.addEventListener('pointercancel', endDrag, true);
  });
  rng.addEventListener('input', seek);
  rng.addEventListener('change', () => { seek(); endDrag(); });
  btn.addEventListener('click', () => togglePlay(el));
  bar.addEventListener('click', (e) => e.stopPropagation());
  bar._update = () => {
    if (dragging) return;
    const [s, e] = span();
    rng.value = Math.round(1000 * (el.currentTime - s) / (e - s));
    txt.textContent = fmtTime(el.currentTime - s) + ' / ' + fmtTime(e - s);
    btn.textContent = el.paused ? '▶' : '❚❚';
  };
  bar._movie = el;
  return bar;
}

/* ------------------------------------------------------------------ views */
class View {
  constructor(container, { live = false, mute = false, half = () => null } = {}) {
    this.container = container;
    this.live = live;
    this.mute = mute;
    this.half = half;
    this.token = 0;
    this.active = new Map();   // key -> movie element
    this.bars = [];
    this.div = null;
    this.index = -1;
    container.addEventListener('click', (e) => this.onClick(e));
    container.addEventListener('mousemove', (e) => this.hoverBars(e));
    container.addEventListener('mouseleave', () => this.hoverBars(null));
  }

  async show(i) {
    const token = ++this.token;
    if (i < 0 || i >= nPages) { this.clear(); return; }
    const inf = await info(i);
    const half = this.half();
    const g = geometry(this.container, inf, half);
    if (g.cw <= 0 || g.ch <= 0) return;
    const src = await renderPage(i, g.cw);
    if (token !== this.token) return;

    const div = document.createElement('div');
    div.className = 'page';
    Object.assign(div.style, { left: g.left + 'px', top: g.top + 'px',
                               width: g.vw + 'px', height: g.ch + 'px' });
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    Object.assign(c.style, { left: g.shift + 'px', width: g.cw + 'px', height: g.ch + 'px' });
    const layer = document.createElement('div');
    layer.className = 'movies';
    Object.assign(layer.style, { left: g.shift + 'px', width: g.cw + 'px', height: g.ch + 'px' });
    div.append(c, layer);
    this.container.appendChild(div);        // new page goes in first ...
    if (this.live) this.syncMovies(i, inf, layer, g);
    if (this.div) this.div.remove();        // ... so moved videos never leave the document
    this.div = div;
    this.geom = g; this.inf = inf; this.index = i;
    if (window.smHooks) smHooks.viewShown(this);
  }

  syncMovies(i, inf, layer, g) {
    const old = this.active;
    const next = new Map();
    const fresh = [];
    for (const m of inf.movies) {
      const b = m.box;
      let key = `${m.src}|${b.l.toFixed(3)},${b.t.toFixed(3)},${b.w.toFixed(3)},${b.h.toFixed(3)}`;
      while (next.has(key)) key += '+';
      let el = (i !== this.index && m.opts.cont) || i === this.index ? old.get(key) : null;
      if (el) old.delete(key);
      else { el = makeMovie(m, this.mute); fresh.push(el); }
      Object.assign(el.style, { left: b.l * g.cw + 'px', top: b.t * g.ch + 'px',
                                width: b.w * g.cw + 'px', height: b.h * g.ch + 'px' });
      layer.appendChild(el);
      el._sm.idx = next.size;
      next.set(key, el);
    }
    this.bars = [];
    for (const el of next.values()) {
      if (el.tagName !== 'VIDEO' || el._sm.m.opts.controls) continue;
      const b = el._sm.m.box, bar = makeBar(el);
      const h = 26;
      Object.assign(bar.style, { left: b.l * g.cw + 'px', width: b.w * g.cw + 'px',
                                 top: (b.t + b.h) * g.ch - h + 'px', height: h + 'px' });
      if (MODE === 'presenter' || el._sm.m.opts.slider) bar.classList.add('on', 'pinned');
      layer.appendChild(bar);
      this.bars.push(bar);
    }
    for (const el of old.values()) {
      if (el.tagName === 'VIDEO' && !el.error) poolPut(el); else disposeEl(el);
    }
    this.active = next;
    for (const el of fresh) {
      if (el._sm.m.opts.autoplay) startMovie(el);
      else if (el.tagName === 'VIDEO') {   // hold on the chosen frame until started
        const show = () => { el.pause(); el.currentTime = frameTime(el); };
        if (el.readyState >= 1) show();
        else el.addEventListener('loadedmetadata', show, { once: true });
      }
    }
  }

  hoverBars(e) {
    for (const bar of this.bars) {
      if (bar.classList.contains('pinned')) continue;
      let inside = false;
      if (e) {
        const r = bar._movie.getBoundingClientRect();
        inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      }
      clearTimeout(bar._hide);
      if (inside) {
        bar.classList.add('on');
        bar._hide = setTimeout(() => bar.classList.remove('on'), 2000);
      } else bar.classList.remove('on');
    }
  }

  clear() {
    for (const el of this.active.values()) disposeEl(el);
    this.active = new Map();
    if (this.div) this.div.remove();
    this.div = null; this.index = -1;
  }

  movies(action) {
    const vids = [...this.active.values()].filter((el) => el.tagName === 'VIDEO');
    const anyPlaying = vids.some((el) => !el.paused);
    for (const el of this.active.values()) {
      if (action === 'restart') startMovie(el);
      else if (el.tagName !== 'VIDEO') continue;
      else if (action === 'toggle') { if (anyPlaying) el.pause(); else el.play().catch(() => {}); }
      else if (action === 'step+' || action === 'step-') {
        el.pause();
        const o = el._sm.m.opts, d = (action === 'step+' ? 1 : -1) / 30;
        const end = o.end != null ? o.end : el.duration;
        el.currentTime = Math.min(Math.max(el.currentTime + d, o.start), isFinite(end) ? end : 1e9);
      }
    }
  }

  byIndex(idx) {
    for (const el of this.active.values()) if (el._sm.idx === idx) return el;
    return null;
  }

  onClick(e) {
    if (!this.div || !this.inf) return;
    const t = e.target;
    if (t.closest && t.closest('.movies') && t !== t.closest('.movies')) {
      if ((t.tagName === 'VIDEO' && !t.controls) || t.tagName === 'IMG') togglePlay(t);
      return;
    }
    const r = this.div.getBoundingClientRect();
    const g = this.geom;
    const x = (e.clientX - r.left - g.shift) / g.cw, y = (e.clientY - r.top) / g.ch;
    for (const L of this.inf.links) {
      const b = L.box;
      if (x < b.l || x > b.l + b.w || y < b.t || y > b.t + b.h) continue;
      if (L.dest) { followDest(L.dest); return; }
      if (L.url && /^https?:/i.test(L.url)) { window.open(L.url, '_blank', 'noopener'); return; }
    }
  }
}

async function followDest(dest) {
  try {
    const d = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!d) return;
    const idx = typeof d[0] === 'number' ? d[0] : await pdf.getPageIndex(d[0]);
    goto(idx);
  } catch (e) { console.warn('link', e); }
}

/* -------------------------------------------------------------- control */
let views = [];
let viewFor = {};   // role -> View

function slideHalf() { return notesSide ? (notesSide === 'right' ? 'left' : 'right') : null; }
function notesHalf() { return notesSide; }

function showAll() {
  if (MODE === 'audience') {
    viewFor.main.show(cur);
    preloadMovies(cur + 1);
    // warm the render cache for the neighbours
    for (const j of [cur + 1, cur + 2, cur - 1]) {
      if (j >= 0 && j < nPages) info(j).then((inf) => {
        const g = geometry(viewFor.main.container, inf, slideHalf());
        if (g.cw > 0) renderPage(j, g.cw);
      });
    }
  } else {
    viewFor.current.show(cur);
    viewFor.next.show(cur + 1);
    if (viewFor.notes) viewFor.notes.show(cur);
    $('p-count').textContent = `${cur + 1} / ${nPages}`;
    $('p-next-label').textContent = cur + 1 < nPages ? 'Next' : 'End of deck';
  }
}

function goto(i, broadcast = true) {
  i = Math.max(0, Math.min(nPages - 1, i));
  if (i === cur && views.every((v) => v.index === i)) return;
  cur = i;
  history.replaceState(null, '', location.pathname + '?' + withParam('page', i + 1));
  if (window.smHooks) smHooks.pageChanging(i);
  showAll();
  if (broadcast) chan.postMessage({ type: 'goto', page: i });
}
function withParam(k, v) { const p = new URLSearchParams(location.search); p.set(k, v); return p.toString(); }

function setCover(kind, broadcast = true) {
  const c = $('cover');
  const on = kind && !(c.classList.contains('on') && c.dataset.kind === kind);
  c.classList.toggle('on', !!on);
  c.dataset.kind = on ? kind : '';
  c.style.background = kind === 'white' ? '#fff' : '#000';
  if (broadcast) chan.postMessage({ type: 'cover', kind: on ? kind : null, force: true });
}

function moviesAction(action, broadcast = true) {
  for (const v of views) if (v.live) v.movies(action);
  if (broadcast) chan.postMessage({ type: 'movies', action });
}

chan.onmessage = (e) => {
  const d = e.data || {};
  if (d.type === 'goto') goto(d.page, false);
  else if (d.type === 'hello' && MODE === 'audience') chan.postMessage({ type: 'goto', page: cur });
  else if (d.type === 'cover') {
    const c = $('cover');
    c.classList.toggle('on', !!d.kind); c.dataset.kind = d.kind || '';
    c.style.background = d.kind === 'white' ? '#fff' : '#000';
  } else if (d.type === 'movies') moviesAction(d.action, false);
  else if (d.type === 'mop') {
    for (const v of views) {
      if (!v.live || v.index !== d.page) continue;
      const el = v.byIndex(d.idx);
      if (el) movieOp(el, d.op, d.t, false);
    }
  }
};

let typed = '';
let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
}

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (/^[0-9]$/.test(k)) { typed += k; $('goto').textContent = 'page ' + typed; $('goto').hidden = false; return; }
  if (typed && k === 'Enter') { goto(parseInt(typed, 10) - 1); typed = ''; $('goto').hidden = true; e.preventDefault(); return; }
  if (typed && (k === 'Escape' || k === 'Backspace')) { typed = ''; $('goto').hidden = true; return; }
  $('help').hidden = k === '?' ? !$('help').hidden : true;
  switch (k) {
    case 'ArrowRight': case 'ArrowDown': case ' ': case 'PageDown': case 'Enter': case 'n':
      goto(cur + 1); break;
    case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace': case 'p':
      goto(cur - 1); break;
    case 'Home': goto(0); break;
    case 'End': goto(nPages - 1); break;
    case 'f': case 'F5':
      if (window.slidexApp) window.slidexApp.fullscreen();   // desktop app: native full screen
      else if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
      break;
    case 'b': case 'B': case '.': setCover('black'); break;
    case 'w': case 'W': case ',': setCover('white'); break;
    case 'k': moviesAction('toggle'); break;
    case 'r': moviesAction('restart'); break;
    case ']': moviesAction('step+'); break;
    case '[': moviesAction('step-'); break;
    case 's': openPresenter(); break;
    case 't': timerStart = Date.now(); break;
    case 'Escape': break;
    default: return;
  }
  e.preventDefault();
});

function openPresenter() {
  if (MODE === 'presenter') return;
  const p = new URLSearchParams(location.search);
  p.set('mode', 'presenter'); p.set('page', cur + 1);
  window.open(location.pathname + '?' + p.toString(), 'slidex-presenter', 'width=1280,height=760');
}

/* desktop app: drop a PDF on the window to present it, a .tex to edit it */
if (window.slidexApp) {
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) window.slidexApp.open(window.slidexApp.pathForFile(f));
  });
}

/* cursor hides after 2 s still */
let cursorTimer = 0;
document.addEventListener('mousemove', () => {
  document.body.classList.remove('hide-cursor');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.add('hide-cursor'), 2000);
});

setInterval(() => {
  for (const v of views) for (const bar of v.bars) if (bar.classList.contains('on')) bar._update();
}, 100);

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(showAll, 120);
});

/* presenter clock */
let timerStart = Date.now();
function tick() {
  const s = Math.floor((Date.now() - timerStart) / 1000);
  $('p-timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  $('p-clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ------------------------------------------------------------------ start */
(async function main() {
  if (!params.get('pdf')) { document.body.innerHTML = '<p style="padding:2em">Start with: slidemovie.py present deck.pdf</p>'; return; }
  try {
    pdf = await pdfjsLib.getDocument({ url: PDF_URL, isEvalSupported: false }).promise;
  } catch (e) {
    document.body.innerHTML = `<p style="padding:2em;color:#f88">Cannot open ${PDF_URL}: ${e.message}</p>`;
    return;
  }
  nPages = pdf.numPages;
  const meta = await pdf.getMetadata().catch(() => null);
  if (meta && meta.info && meta.info.Title) document.title = meta.info.Title + ' (SlideX)';

  const np = params.get('notes');
  if (np === 'left' || np === 'right') notesSide = np;
  else if (np !== 'none') {
    const inf = await info(0);
    if (inf.w / inf.h > 2.4) notesSide = 'right';   // beamer's default notes layout
  }

  if (MODE === 'audience') {
    viewFor.main = new View($('stage'), { live: true, half: slideHalf });
    views = [viewFor.main];
  } else {
    $('audience').hidden = true;
    $('presenter').hidden = false;
    viewFor.current = new View($('p-current'), { live: true, mute: true, half: slideHalf });
    viewFor.next = new View($('p-next'), { half: slideHalf });
    views = [viewFor.current, viewFor.next];
    if (notesSide) {
      $('p-notes').hidden = false;
      viewFor.notes = new View($('p-notes'), { half: notesHalf });
      views.push(viewFor.notes);
    }
    $('p-timer').addEventListener('click', () => { timerStart = Date.now(); });
    tick(); setInterval(tick, 500);
  }
  cur = Math.max(0, Math.min(nPages - 1, (parseInt(params.get('page'), 10) || 1) - 1));
  pageLabels = await pdf.getPageLabels().catch(() => null);
  if (window.smHooks) await smHooks.start();
  showAll();
  if (MODE === 'presenter') chan.postMessage({ type: 'hello' });
  window.slidex = { get page() { return cur; }, goto, views, info, viewFor };   // for debugging
})();
