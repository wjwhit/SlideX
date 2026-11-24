/* SlideX editor window: the deck's LaTeX source (CodeMirror 6) beside a
 * one-slide preview compiled on demand. Hovering the preview highlights the
 * source line that made it; the text cursor outlines what its line made.
 * Talks to the main process through window.slidexEditor (preload.js), and to
 * the deck windows over their BroadcastChannel, so deck and editor follow
 * each other frame by frame. */
'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
(() => {                                   // render even when the window is covered (see viewer.js)
  const ch = new MessageChannel(); const q = [];
  ch.port1.onmessage = () => { const cbs = q.splice(0); for (const cb of cbs) cb(performance.now()); };
  window.requestAnimationFrame = (cb) => { q.push(cb); if (q.length === 1) ch.port2.postMessage(0); return q.length; };
})();

const api = window.slidexEditor;
const $ = (id) => document.getElementById(id);
const S = {
  tex: null, frames: [], pageFrames: [], deckUrl: null,
  frame: null,              // frame object shown in the preview
  preview: null,            // {frameStart, pdf, page, pages, exact, url}
  dirty: false, compiling: false, errors: [],
  hoverLine: null, chan: null, lastSentPage: null, version: 0,
};

/* ------------------------------------------------------------ CodeMirror */
const setHover = CM.StateEffect.define();
const setErrors = CM.StateEffect.define();
const setFrame = CM.StateEffect.define();

function lineDeco(cls) { return CM.Decoration.line({ class: cls }); }

const marksField = CM.StateField.define({
  create(state) { const v = { hover: null, errors: [], frame: null }; v.deco = decoFor(v, state.doc); return v; },
  update(v, tr) {
    let n = { ...v };
    for (const e of tr.effects) {
      if (e.is(setHover)) n.hover = e.value;
      if (e.is(setErrors)) n.errors = e.value;
      if (e.is(setFrame)) n.frame = e.value;
    }
    if (tr.docChanged && n.frame) {          // keep the frame band roughly in place while typing
      const d = tr.state.doc.lines - tr.startState.doc.lines;
      n.frame = { start: n.frame.start, end: Math.max(n.frame.start, n.frame.end + d) };
    }
    if (n.hover === v.hover && n.errors === v.errors && n.frame === v.frame && !tr.docChanged) return v;
    n.deco = decoFor(n, tr.state.doc);
    return n;
  },
  provide: (f) => CM.EditorView.decorations.from(f, (v) => v.deco),
});

function decoFor(v, doc) {
  const b = new CM.RangeSetBuilder();
  const marks = new Map();                         // line -> classes
  const add = (line, cls) => { if (line >= 1 && line <= doc.lines) marks.set(line, (marks.get(line) || '') + ' ' + cls); };
  if (v.frame) for (let l = v.frame.start; l <= v.frame.end && l <= doc.lines; l++) add(l, 'cm-frame-line');
  for (const e of v.errors) add(e, 'cm-error-line');
  if (v.hover) add(v.hover, 'cm-hover-line');
  for (const l of [...marks.keys()].sort((a, c) => a - c)) {
    const pos = doc.line(l).from;
    b.add(pos, pos, lineDeco(marks.get(l).trim()));
  }
  return b.finish();
}

let view;
/* ------------------------------------------------------------- themes */
/* Dark or light, or following macOS (View > Editor Theme); the choice is kept
 * in localStorage. The page's colours switch with data-theme on <html>. */
const themeComp = new CM.Compartment();
function cmTheme(light) {
  const c = light
    ? { fg: '#1f2328', bg: '#ffffff', gutter: '#f6f7f9', gnum: '#8c939c', caret: '#000', act: 'rgba(0,0,0,.035)', actg: 'rgba(0,0,0,.05)', sel: 'rgba(61,139,253,.25)' }
    : { fg: '#d8dbe0', bg: '#1b1d21', gutter: '#1b1d21', gnum: '#5c626b', caret: '#fff', act: 'rgba(255,255,255,.04)', actg: 'rgba(255,255,255,.06)', sel: 'rgba(61,139,253,.35)' };
  const theme = CM.EditorView.theme({
    '&': { color: c.fg, backgroundColor: c.bg },
    '.cm-content': { caretColor: c.caret },
    '.cm-gutters': { backgroundColor: c.gutter, color: c.gnum, border: 'none' },
    '.cm-activeLine': { backgroundColor: c.act },
    '.cm-activeLineGutter': { backgroundColor: c.actg },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: c.sel },
    '.cm-cursor': { borderLeftColor: c.caret },
  }, { dark: !light });
  const h = light
    ? { comment: '#6a737d', kw: '#0550ae', atom: '#953800', br: '#57606a', str: '#0a3069', num: '#116329', v: '#8250df' }
    : { comment: '#6a737d', kw: '#7cb7ff', atom: '#ffab70', br: '#9aa4b1', str: '#9ecbff', num: '#79d4a5', v: '#e2a3ff' };
  const hl = CM.HighlightStyle.define([
    { tag: CM.tags.comment, color: h.comment, fontStyle: 'italic' },
    { tag: [CM.tags.keyword, CM.tags.tagName], color: h.kw },
    { tag: CM.tags.atom, color: h.atom },
    { tag: CM.tags.bracket, color: h.br },
    { tag: CM.tags.string, color: h.str },
    { tag: CM.tags.number, color: h.num },
    { tag: [CM.tags.variableName, CM.tags.typeName], color: h.v },
  ]);
  return [theme, CM.syntaxHighlighting(hl)];
}
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function themeSetting() { try { return localStorage.getItem('slidex.theme') || 'system'; } catch { return 'system'; } }
function isLight() { const t = themeSetting(); return t === 'light' || (t === 'system' && !darkQuery.matches); }
function applyTheme() {
  const light = isLight();
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  if (view) view.dispatch({ effects: themeComp.reconfigure(cmTheme(light)) });
}
function setTheme(t) {
  try { localStorage.setItem('slidex.theme', t); } catch { /* no storage */ }
  if (window.slidexEditor && slidexEditor.setPref) slidexEditor.setPref('slidex.theme', t);
  applyTheme();
  status(`Editor theme: ${t === 'system' ? 'follows macOS' : t}`);
}
darkQuery.addEventListener('change', () => { if (themeSetting() === 'system') applyTheme(); });
applyTheme();

function makeEditor(text) {
  view = new CM.EditorView({
    parent: $('code'),
    state: CM.EditorState.create({
      doc: text,
      extensions: [
        CM.lineNumbers(), CM.highlightActiveLineGutter(), CM.history(), CM.drawSelection(),
        CM.highlightActiveLine(), CM.bracketMatching(), CM.closeBrackets(), CM.highlightSelectionMatches(),
        CM.StreamLanguage.define(CM.stex), themeComp.of(cmTheme(isLight())), CM.EditorView.lineWrapping,
        marksField,
        CM.search({ top: true }),
        window.SlidexComplete ? SlidexComplete.extension(() => S.info) : [],
        CM.EditorView.domEventHandlers({
          drop: (e, v) => {
            if (!e.dataTransfer || !e.dataTransfer.files.length) return false;
            e.preventDefault();
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
            dropFiles(toItems(e.dataTransfer.files), pos != null ? v.state.doc.lineAt(pos).number : null);
            return true;
          },
          dragover: (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); return true; } return false; },
        }),
        CM.keymap.of([{ key: 'Enter', run: itemEnter }]),
        CM.keymap.of([
          { key: 'Mod-Enter', run: () => { compileFrame(); return true; } },
          { key: 'Mod-s', run: () => { save(); return true; } },
          { key: 'Shift-Mod-Enter', run: () => { compileDeck(); return true; } },
          ...CM.closeBracketsKeymap, ...CM.defaultKeymap, ...CM.searchKeymap, ...CM.historyKeymap, CM.indentWithTab,
        ]),
        CM.EditorView.updateListener.of((u) => {
          if (u.docChanged) onEdit();
          if (u.selectionSet || u.docChanged) onCursor();
        }),
      ],
    }),
  });
}

function cursorLine() { return view.state.doc.lineAt(view.state.selection.main.head).number; }
function gotoLine(line, focus = true) {
  line = Math.max(1, Math.min(view.state.doc.lines, line));
  const pos = view.state.doc.line(line).from;
  view.dispatch({ selection: { anchor: pos }, effects: CM.EditorView.scrollIntoView(pos, { y: 'center' }) });
  if (focus) view.focus();
}
function markHover(line) {
  if (S.hoverLine === line) return;
  S.hoverLine = line;
  view.dispatch({ effects: setHover.of(line) });
  if (line) {
    const pos = view.state.doc.line(Math.min(line, view.state.doc.lines)).from;
    view.dispatch({ effects: CM.EditorView.scrollIntoView(pos, { y: 'nearest' }) });
  }
}

/* ------------------------------------------------------------- frames */
function frameAt(line) { return S.frames.find((f) => line >= f.start && line <= f.end) || null; }

function fillFramePicker() {
  const sel = $('framepick');
  sel.innerHTML = '';
  S.frames.forEach((f, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = `${i + 1}. ${[f.label, f.title].filter(Boolean).join(': ') || '(no label or title)'}`.slice(0, 90);
    sel.appendChild(o);
  });
}

let cursorTimer = 0;
function onCursor() {
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(async () => {
    const line = cursorLine();
    const f = frameAt(line);
    if (f) {
      $('framepick').value = f.index;
      if (!S.frame || f.start !== S.frame.start) await switchFrame(f);
    }
    drawCursorBoxes();
  }, 120);
}

async function switchFrame(f, fromDeck = false) {
  S.frame = f;
  view.dispatch({ effects: setFrame.of({ start: f.start, end: f.end }) });
  markStrip(f);
  if (!fromDeck) followDeck(f);
  const cached = S.cache.get(frameKeyOf(f));
  if (cached && !S.stale) { await showPreview(cached); return; }
  await compileFrame();
}

/* ------------------------------------------------------------ compile */
S.cache = new Map();          // frame key -> preview result
S.stale = false;              // text changed since the preview was compiled
S.live = true;                // recompile the slide shortly after typing stops
let pending = false;          // a compile was asked for while one was running

function frameKeyOf(f) { return f.label || '#' + f.index; }

function setDirty(d) {
  S.dirty = d;
  document.title = (d ? '• ' : '') + 'SlideX editor: ' + (S.tex || '');
  $('btn-save').disabled = !d;
}
function status(msg, cls = '', full = '') { const el = $('status'); el.textContent = msg; el.className = cls; el.title = full || msg; }

/* Compile the slide under the cursor from the editor's text (the .tex on
 * disk is not touched). */
async function compileFrame() {
  if (S.compiling) { pending = true; return; }
  const f = frameAt(cursorLine()) || S.frame;
  if (!f) { status('Put the cursor inside a frame first.', 'bad'); return; }
  S.compiling = true;
  pending = false;
  $('preview').classList.add('busy');
  status(`Compiling ${f.label || 'frame ' + (f.index + 1)}…`);
  const version = S.version;
  try {
    // the cursor may sit between frames: then recompile the frame last shown
    const line = frameAt(cursorLine()) ? cursorLine() : f.start;
    const r = await api.compileFrame(view.state.doc.toString(), line);
    applyFrames(r.frames);
    showErrors(r.errors || []);
    showLog(`Slide ${r.name || ''}`, r.log, r.errors);
    if (r.ok && r.url) {
      S.cache.clear();                           // other frames may depend on what changed
      const nf = S.frames.find((x) => frameKeyOf(x) === r.key) || f;
      S.frame = nf;
      view.dispatch({ effects: setFrame.of({ start: nf.start, end: nf.end }) });
      const p = { key: r.key, url: r.url + '?t=' + Date.now(), exact: r.exact, probes: r.probes,
        page: S.preview && S.preview.key === r.key ? S.preview.page : 1 };
      S.cache.set(r.key, p);
      S.stale = S.version !== version;
      await showPreview(p);
      status(`${r.name} · ${(r.ms / 1000).toFixed(2)} s` + (r.exact ? '' : ' · frame-level'),
        r.errors && r.errors.length ? 'bad' : 'good',
        r.exact ? '' : 'Highlighting is per frame here: this frame is not a fragile environment (see latex/README.md).');
    } else {
      status(r.errors && r.errors.length ? `${r.errors.length} error(s)` : 'Compile failed', 'bad');
    }
  } catch (err) {
    status('Compile failed: ' + err.message, 'bad');
  } finally {
    S.compiling = false;
    $('preview').classList.remove('busy');
    if (pending || (S.live && S.version !== version)) setTimeout(compileFrame, 0);
  }
}

let liveTimer = 0;
function onEdit() {
  S.version++;
  S.stale = true;
  setDirty(true);
  drawBoxes('cursor', []); drawBoxes('hover', []);
  if (!S.live) return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(compileFrame, 450);
}

/* Files and macros for completion; refreshed on save and deck builds. */
async function refreshInfo() {
  try { S.info = await api.projectInfo(view.state.doc.toString()); } catch { /* keep the last */ }
}

async function save() {
  const r = await api.save(view.state.doc.toString());
  applyFrames(r.frames);
  setDirty(false);
  status('Saved', 'good');
  refreshInfo();
}

/* Save, then build the whole deck: the presenter reloads and the slide
 * strip is redrawn. */
/* Returns true when a deck PDF was built (it may still carry LaTeX errors). */
async function compileDeck() {
  clearTimeout(liveTimer);
  while (S.compiling) await new Promise((r) => setTimeout(r, 100));   // let a slide compile finish
  S.compiling = true;
  $('btn-deck').disabled = true;
  status('Compiling the whole deck…');
  try {
    const r = await api.compileDeck(view.state.doc.toString());
    applyFrames(r.frames);
    showLog('Deck', r.log, r.errors);
    S.pageFrames = r.pageFrames || S.pageFrames;
    setDirty(false);
    showErrors(r.errors || []);
    status(r.ok ? `Deck compiled in ${(r.ms / 1000).toFixed(1)} s` : `Deck: ${r.errors.length} error(s)`, r.ok ? 'good' : 'bad');
    if (r.built) await renderStrip(true);
    refreshInfo();
    return !!r.built;
  } catch (err) {
    status('Compile failed: ' + err.message, 'bad');
    return false;
  } finally {
    S.compiling = false;
    $('btn-deck').disabled = false;
  }
}

/* -------------------------------------------------------- LaTeX output */
function escapeHtml(t) { return t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

function showLog(what, log, errors) {
  const box = $('out-log');
  if (!log) {                                        // nothing ran: keep the last log, show why
    if (errors && errors.length) { $('out-sum').textContent = errors[0].message; $('out-sum').style.color = '#ff8b8b'; }
    return;
  }
  const lines = log.split('\n');
  let warns = 0;
  box.innerHTML = lines.map((l) => {
    let cls = '';
    if (/^!|^\S+\.(tex|vrb|sty|cls):\d+:/.test(l)) cls = 'err';
    else if (/Warning|Overfull|Underfull/.test(l)) { cls = 'warn'; warns++; }
    else if (/^Output written|^Transcript written/.test(l)) cls = 'info';
    return cls ? `<span class="${cls}">${escapeHtml(l)}</span>` : escapeHtml(l);
  }).join('\n');
  const nerr = (errors || []).length;
  $('out-sum').textContent = `${what}: ${nerr} error${nerr === 1 ? '' : 's'}, ${warns} warning line${warns === 1 ? '' : 's'}`;
  $('out-sum').style.color = nerr ? '#ff8b8b' : '';
  const firstErr = box.querySelector('.err');
  if (firstErr) { $('output').classList.remove('closed'); firstErr.scrollIntoView({ block: 'center' }); }
  else box.scrollTop = box.scrollHeight;
}
/* Drag the top edge of the output box to resize it; the height is remembered. */
{
  const out = $('output'), handle = $('out-resize');
  try { const h = +localStorage.getItem('slidex.outputHeight'); if (h > 28) out.style.height = h + 'px'; } catch { /* no storage */ }
  let drag = null;
  handle.addEventListener('mousedown', (e) => { drag = { y: e.clientY, h: out.offsetHeight }; handle.classList.add('drag'); e.preventDefault(); });
  addEventListener('mousemove', (e) => {
    if (!drag) return;
    const max = $('right').clientHeight - 140;               // keep room for the slide
    out.style.height = Math.min(max, Math.max(60, drag.h + drag.y - e.clientY)) + 'px';
  });
  addEventListener('mouseup', () => {
    if (!drag) return;
    drag = null; handle.classList.remove('drag');
    try { localStorage.setItem('slidex.outputHeight', out.offsetHeight); } catch { /* no storage */ }
    if (api && api.setPref) api.setPref('slidex.outputHeight', out.offsetHeight);
    renderPage().then(drawCursorBoxes);
  });
}
$('out-head').addEventListener('click', () => { $('output').classList.toggle('closed'); $('out-toggle').textContent = $('output').classList.contains('closed') ? '▸' : '▾'; renderPage().then(drawCursorBoxes); });

/* ---------------------------------------------------------- slide strip */
/* One thumbnail per frame (its last overlay step), drawn from the full-deck
 * PDF; redrawn only after Compile deck. */
const strip = { doc: null, items: new Map() };

async function renderStrip(reload = false) {
  const box = $('strip');
  if (!S.deckUrl || !S.pageFrames.length) { box.innerHTML = '<div class="strip-empty">Compile deck to see the slides here.</div>'; return; }
  try {
    strip.doc = await pdfjsLib.getDocument({ url: S.deckUrl + (reload ? '?t=' + Date.now() : ''), isEvalSupported: false }).promise;
  } catch { box.innerHTML = '<div class="strip-empty">No deck PDF yet.</div>'; return; }
  const last = new Map();                       // key -> last page index of that frame
  S.pageFrames.forEach((k, i) => { if (k != null) last.set(k, i); });
  box.innerHTML = '';
  strip.items.clear();
  let n = 0;
  for (const [key, pageIdx] of last) {
    n++;
    const item = document.createElement('div');
    item.className = 'thumb';
    item.dataset.key = key;
    const c = document.createElement('canvas');
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = `${n}. ${key.startsWith('#') ? '' : key}`;
    item.append(c, cap);
    item.onclick = () => {
      const f = S.frames.find((x) => frameKeyOf(x) === key);
      if (f) { gotoLine(f.bodyStart); }
    };
    box.appendChild(item);
    strip.items.set(key, { item, c, pageIdx });
  }
  markStrip(S.frame);
  for (const { c, pageIdx } of strip.items.values()) {     // draw after layout, top to bottom
    const page = await strip.doc.getPage(pageIdx + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const w = box.clientWidth - 18;
    const dpr = window.devicePixelRatio || 1;
    const vp = page.getViewport({ scale: (w / vp1.width) * dpr });
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    c.style.width = w + 'px';
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  }
}

function markStrip(f) {
  if (!f) return;
  const key = frameKeyOf(f);
  for (const [k, { item }] of strip.items) {
    item.classList.toggle('on', k === key);
    if (k === key) item.scrollIntoView({ block: 'nearest' });
  }
}

function applyFrames(frames) {
  if (!frames) return;
  S.frames = frames;
  fillFramePicker();
  const f = frameAt(cursorLine());
  if (f) $('framepick').value = f.index;
}

function showErrors(errs) {
  S.errors = errs;
  const box = $('errors');
  box.innerHTML = '';
  box.hidden = !errs.length;
  for (const e of errs) {
    const d = document.createElement('div');
    d.textContent = (e.line ? `line ${e.line}: ` : '') + e.message;
    if (e.line) d.onclick = () => gotoLine(e.line);
    box.appendChild(d);
  }
  view.dispatch({ effects: setErrors.of(errs.filter((e) => e.line).map((e) => e.line)) });
}

/* ------------------------------------------------------------ preview */
const pv = { doc: null, url: null, scale: 1, w: 0, h: 0 };

function clearPreview(msg) {
  $('pagewrap').hidden = true;
  $('placeholder').hidden = false;
  $('placeholder').textContent = msg;
  $('pages').innerHTML = '';
}

async function showPreview(p) {
  S.preview = p;
  if (pv.url !== p.url) {
    pv.doc = await pdfjsLib.getDocument({ url: p.url, isEvalSupported: false }).promise;
    pv.url = p.url;
  }
  p.pages = pv.doc.numPages;
  p.page = Math.min(p.page || 1, p.pages);
  const tabs = $('pages');
  tabs.innerHTML = '';
  if (p.pages > 1) {
    const l = document.createElement('span'); l.className = 'label'; l.textContent = 'Overlay step'; tabs.appendChild(l);
    for (let i = 1; i <= p.pages; i++) {
      const b = document.createElement('button');
      b.textContent = i;
      b.className = i === p.page ? 'on' : '';
      b.onclick = () => { p.page = i; showPreview(p); };
      tabs.appendChild(b);
    }
  }
  await renderPage();
  $('placeholder').hidden = true;
  $('pagewrap').hidden = false;
  drawCursorBoxes();
  S.figsReady = findFigures();
}

async function renderPage() {
  const p = S.preview;
  if (!p || !pv.doc) return;
  const page = await pv.doc.getPage(p.page);
  const vp1 = page.getViewport({ scale: 1 });
  const box = $('preview');
  const s = Math.min((box.clientWidth - 24) / vp1.width, (box.clientHeight - 24) / vp1.height);
  pv.scale = s; pv.w = vp1.width; pv.h = vp1.height;
  const dpr = window.devicePixelRatio || 1;
  const vp = page.getViewport({ scale: s * dpr });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  const cv = $('pagecanvas');
  cv.width = c.width; cv.height = c.height;
  cv.getContext('2d').drawImage(c, 0, 0);
  const W = vp1.width * s, H = vp1.height * s;
  Object.assign($('pagewrap').style, { width: W + 'px', height: H + 'px',
    left: (box.clientWidth - W) / 2 + 'px', top: (box.clientHeight - H) / 2 + 'px' });
}

function drawBoxes(cls, boxes) {
  const marks = $('marks');
  for (const el of [...marks.querySelectorAll('.' + cls)]) el.remove();
  if (!S.preview) return;
  for (const b of boxes) {
    if (b.page !== S.preview.page) continue;
    const d = document.createElement('div');
    d.className = 'box ' + cls;
    Object.assign(d.style, { left: b.x * pv.scale - 1 + 'px', top: b.y * pv.scale - 1 + 'px',
      width: b.w * pv.scale + 2 + 'px', height: b.h * pv.scale + 2 + 'px' });
    marks.appendChild(d);
  }
}

async function drawCursorBoxes() {
  if (!S.preview || S.stale) { drawBoxes('cursor', []); return; }
  const boxes = await api.boxesForLine(cursorLine());
  drawBoxes('cursor', boxes || []);
}

/* Hover: source line under the pointer, highlighted in the code. */
let hoverBusy = false, hoverNext = null;
$('preview').addEventListener('mousemove', (e) => {
  if (!S.preview || S.stale) return;
  const r = $('pagewrap').getBoundingClientRect();
  const x = (e.clientX - r.left) / pv.scale, y = (e.clientY - r.top) / pv.scale;
  if (x < 0 || y < 0 || x > pv.w || y > pv.h) { markHover(null); drawBoxes('hover', []); return; }
  hoverNext = { page: S.preview.page, x, y };
  if (!hoverBusy) hoverLoop();
});
$('preview').addEventListener('mouseleave', () => { hoverNext = null; markHover(null); drawBoxes('hover', []); });
async function hoverLoop() {
  hoverBusy = true;
  while (hoverNext) {
    const q = hoverNext; hoverNext = null;
    const hit = await api.lineAt(q.page, q.x, q.y);
    markHover(hit ? hit.line : null);
    drawBoxes('hover', hit && hit.exact ? (await api.boxesForLine(hit.line)) || [] : []);
  }
  hoverBusy = false;
}
/* --------------------------------------------------------- list Enter */
/* Enter at the end of an \item line starts a new \item at the same indent;
 * Enter on an empty \item ends the list (the empty item is removed). */
function itemEnter(v) {
  const sel = v.state.selection.main;
  if (!sel.empty) return false;
  const line = v.state.doc.lineAt(sel.head);
  if (sel.head !== line.to) return false;
  const m = /^(\s*)\\item\b(\[[^\]]*\])?\s*(.*)$/.exec(line.text);
  if (!m) return false;
  if (!m[3].trim() && !m[2]) {                                    // empty item: end the list
    v.dispatch({ changes: { from: line.from, to: line.to, insert: m[1].replace(/\t$|    $/, '') }, selection: { anchor: line.from + m[1].replace(/\t$|    $/, '').length } });
    return true;
  }
  const ins = '\n' + m[1] + '\\item ';
  v.dispatch({ changes: { from: sel.head, insert: ins }, selection: { anchor: sel.head + ins.length }, scrollIntoView: true });
  return true;
}

/* ------------------------------------------------------- media drop-in */
/* Files dropped on the code or the preview: copied into ./figures/
 * (GIFs and frame folders become mp4 with a poster), and a line inserted. */
/* items: [{name, path}] (from dropped File objects, see toItems). */
function toItems(fileList) { return [...fileList].map((f) => ({ name: f.name, path: window.slidexEditor.pathForFile(f) })).filter((i) => i.path); }

async function dropFiles(items, atLine) {
  for (const file of items) {
    const p = file.path;
    status(`Adding ${file.name}…`);
    const r = await api.importMedia(p);
    if (r.error) { status(r.error, 'bad'); continue; }
    const doc = view.state.doc;
    const line = doc.line(atLine || cursorLine());
    const indent = /^\s*/.exec(line.text)[0];
    const snippet = r.kind === 'movie' ? `\\slidemovie[width=0.8\\linewidth]{${r.rel}}` : `\\includegraphics[width=0.8\\linewidth]{${r.rel}}`;
    const changes = [{ from: line.to, insert: '\n' + indent + snippet }];
    const text = doc.toString();
    const bd = text.indexOf('\\begin{document}');
    if (r.kind === 'movie' && bd > 0 && !/\\usepackage(\[[^\]]*\])?\{[^}]*slidemovie/.test(text.slice(0, bd))) {
      changes.push({ from: bd, insert: '\\usepackage{slidemovie}  % movies that play in SlideX\n' });
      r.notes.push('added \\usepackage{slidemovie}');
    }
    view.dispatch({ changes, selection: { anchor: line.to + 1 + indent.length + snippet.length } });
    atLine = (atLine || cursorLine()) + 1;
    status(`Added ${r.rel}` + (r.notes.length ? ' · ' + r.notes.join(', ') : ''), 'good');
  }
  refreshInfo();
  view.focus();
}
for (const el of [$('preview')]) {
  el.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); el.classList.add('drop'); } });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('drop'); dropFiles(toItems(e.dataTransfer.files), null); });
}

/* ------------------------------------------------ figures: resize handles */
/* Figures and movies on the shown page: one per source line holding
 * \includegraphics or \slidemovie, located with SyncTeX. */
const FIG_RE = /\\(includegraphics|slidemovie)\s*(?:\[([^\]]*)\])?\s*\{/;
S.figs = [];

/* Where images and included PDFs are drawn on the preview page (page points
 * from the top-left), from pdf.js's operator list. */
async function pageImages() {
  const key = pv.url + '#' + S.preview.page;
  if (pv.imgs && pv.imgs.key === key) return pv.imgs.list;
  const list = [];
  try {
    const page = await pv.doc.getPage(S.preview.page);
    const vp = page.getViewport({ scale: 1 });
    const ops = await page.getOperatorList();
    const O = pdfjsLib.OPS;
    const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
    const rectOf = (m, bb = [0, 0, 1, 1]) => {
      const pts = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[0], bb[3]], [bb[2], bb[3]]]
        .map(([x, y]) => vp.convertToViewportPoint(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]));
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    };
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], a = ops.argsArray[i];
      if (fn === O.save) stack.push(ctm);
      else if (fn === O.restore) ctm = stack.pop() || ctm;
      else if (fn === O.transform) ctm = mul(ctm, a);
      else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageMaskXObject) list.push(rectOf(ctm));
      else if (fn === O.paintFormXObjectBegin) {
        stack.push(ctm);
        if (a[0]) ctm = mul(ctm, a[0]);
        if (a[1]) { const r = rectOf(ctm, a[1]); if (r.w > 8 && r.h > 8) list.push(r); }
      } else if (fn === O.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    }
  } catch { /* no operator list: keep SyncTeX's boxes */ }
  pv.imgs = { key, list };
  return list;
}

/* SyncTeX's box for a figure can be the whole argument it sits in (a box in
 * \visible{...}): use the drawn image it holds, when one fills it poorly. */
function snapToImage(b, imgs) {
  const area = (r) => r.w * r.h;
  const overlap = (r, q) => Math.max(0, Math.min(r.x + r.w, q.x + q.w) - Math.max(r.x, q.x)) * Math.max(0, Math.min(r.y + r.h, q.y + q.h) - Math.max(r.y, q.y));
  let best = null, bo = 0;
  for (const im of imgs) { const o = overlap(b, im); if (o > bo && o > 0.6 * area(im)) { bo = o; best = im; } }
  if (!best || area(best) > 0.8 * area(b)) return b;
  return { ...b, x: best.x, y: best.y, w: best.w, h: best.h };
}

async function findFigures() {
  S.figs = [];
  drawFigs(null);
  if (!S.preview || S.stale || !S.frame) return;
  const doc = view.state.doc;
  const figs = [];
  for (let l = S.frame.start; l <= Math.min(S.frame.end, doc.lines); l++) {
    if (!FIG_RE.test(doc.line(l).text) || /^\s*%/.test(doc.line(l).text)) continue;
    const boxes = ((await api.boxesForLine(l)) || []).filter((b) => b.page === S.preview.page);
    if (!boxes.length) continue;
    const b = snapToImage(boxes.reduce((a, c) => (c.w * c.h > a.w * a.h ? c : a)), await pageImages());
    if (b.w < 4 || b.h < 4) continue;
    figs.push({ kind: 'figure', line: l, box: b });
  }
  S.figs = figs.concat(await findBoxes());
  await findMovables();
}

/* ------------------------------------------------ boxes: resize handles */
/* tcolorbox environments, and calls of the deck's own box macros (any
 * \newcommand whose definition draws a tcolorbox, e.g. \keybox). SyncTeX
 * records only the text inside a box, so the box is found from the union of
 * its content, widened outward to the frame line drawn on the page. */
function unionOf(boxes) {
  if (!boxes.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/* The content of a box: every record of its lines, minus records that
 * enclose other records (e.g. a \makebox wrapped around the box). */
async function contentBox(l0, l1, maxW = Infinity) {
  const all = [];
  for (let l = l0; l <= l1; l++) {
    for (const b of (await api.boxesForLine(l)) || []) if (b.page === S.preview.page && b.w > 0 && b.h > 0 && b.w <= maxW) all.push(b);
  }
  const holds = (a, b) => a !== b && b.x >= a.x - 0.5 && b.y >= a.y - 0.5 && b.x + b.w <= a.x + a.w + 0.5 && b.y + b.h <= a.y + a.h + 0.5
    && (b.w < a.w - 1 || b.h < a.h - 1);
  return unionOf(all.filter((a) => !all.some((b) => holds(a, b))));
}

/* Walk outward from the content to the first dark pixel row/column (the
 * box's frame), within 22 bp; otherwise pad by the usual inner margin. */
function toFrame(u) {
  const cv = $('pagecanvas');
  const k = cv.width / pv.w;                          // device px per bp
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const dark = (x, y) => {
    if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) return false;
    const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2] < 190;
  };
  const reach = 22 * k, pad = 5;
  const scan = (x, y, dx, dy) => {               // returns distance in bp to the frame, or null
    for (let t = 2; t <= reach; t++) if (dark(x + dx * t, y + dy * t)) return t / k;
    return null;
  };
  const cx = (u.x + u.w / 2) * k, cy = (u.y + u.h / 2) * k;
  const L = scan(u.x * k, cy, -1, 0), R = scan((u.x + u.w) * k, cy, 1, 0);
  const T = scan(cx, u.y * k, 0, -1), B = scan(cx, (u.y + u.h) * k, 0, 1);
  if (L == null && R == null) {
    // No frame outside: the records are a wrapper around the box (e.g. the
    // \makebox of a resized \keybox). Look inward from its edges instead.
    const inward = (x, y, dx, dy, max) => { for (let t = 0; t <= max; t++) if (dark(x + dx * t, y + dy * t)) return t / k; return null; };
    const maxX = u.w * k * 0.45, maxY = u.h * k * 0.45;
    const l = inward(u.x * k, cy, 1, 0, maxX), r = inward((u.x + u.w) * k - 1, cy, -1, 0, maxX);
    const t = inward(cx, u.y * k, 0, 1, maxY), b = inward(cx, (u.y + u.h) * k - 1, 0, -1, maxY);
    if (l != null && r != null) {
      return { x: u.x + l, y: u.y + (t ?? 0), w: u.w - l - r, h: u.h - (t ?? 0) - (b ?? 0) };
    }
  }
  return { x: u.x - (L ?? pad), y: u.y - (T ?? pad), w: u.w + (L ?? pad) + (R ?? pad), h: u.h + (T ?? pad) + (B ?? pad) };
}

function matchClose(text, open) {                  // index of the } closing the { at text[open]
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '%') { const nl = text.indexOf('\n', i); if (nl < 0) return -1; i = nl; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

async function findBoxes() {
  const doc = view.state.doc;
  const out = [];
  const last = Math.min(S.frame.end, doc.lines);
  // tcolorbox environments
  for (let l = S.frame.start; l <= last; l++) {
    const t = doc.line(l).text;
    if (/^\s*%/.test(t) || !/\\begin\{tcolorbox\}/.test(t)) continue;
    let depth = 0, end = null;
    for (let k = l; k <= last; k++) {
      const tk = doc.line(k).text;
      depth += (tk.match(/\\begin\{tcolorbox\}/g) || []).length - (tk.match(/\\end\{tcolorbox\}/g) || []).length;
      if (depth <= 0) { end = k; break; }
    }
    if (!end) continue;
    const u = await contentBox(l + 1, end - 1);
    if (u) out.push({ kind: 'tcolorbox', line: l, end, box: toFrame(u) });
  }
  // the deck's box macros
  const names = ((S.info && S.info.commands) || []).filter((c) => c.box).map((c) => c.name);
  if (names.length) {
    const text = doc.toString();
    const from = doc.line(S.frame.start).from, to = doc.line(last).to;
    const re = new RegExp('\\\\(' + names.join('|') + ')\\s*\\{', 'g');
    re.lastIndex = from;
    let m;
    while ((m = re.exec(text)) && m.index < to) {
      const lineNo = doc.lineAt(m.index).number;
      if (/^\s*%/.test(doc.line(lineNo).text)) continue;
      const close = matchClose(text, m.index + m[0].length - 1);
      if (close < 0) continue;
      const u = await contentBox(lineNo, doc.lineAt(close).number);
      if (u) out.push({ kind: 'macrobox', name: m[1], line: lineNo, at: m.index, close, box: toFrame(u) });
    }
  }
  return out;
}

function figAt(x, y) {          // smallest figure box containing the point (bp)
  let best = null;
  for (const f of S.figs) {
    const b = f.box;
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h && (!best || b.w * b.h < best.box.w * best.box.h)) best = f;
  }
  return best;
}

const figEl = document.createElement('div'); figEl.className = 'fig-outline'; figEl.hidden = true;
const handleEl = document.createElement('div'); handleEl.className = 'fig-handle'; handleEl.title = 'Drag to resize';
const ghostEl = document.createElement('div'); ghostEl.className = 'fig-ghost'; ghostEl.hidden = true;
const ratioEl = document.createElement('div'); ratioEl.className = 'fig-ratio';
figEl.appendChild(handleEl); ghostEl.appendChild(ratioEl);
$('pagewrap').append(figEl, ghostEl);

function placeBox(el, b) {
  Object.assign(el.style, { left: b.x * pv.scale + 'px', top: b.y * pv.scale + 'px', width: b.w * pv.scale + 'px', height: b.h * pv.scale + 'px' });
}
function drawFigs(f) {
  if (f && !f.box) f = null;                 // a selection waiting for the next compile to find it again
  S.figHover = f;
  figEl.hidden = !f;
  if (f) {
    placeBox(figEl, f.box);
    figEl.classList.toggle('boxmode', f.kind !== 'figure' && !f.noResize);
    figEl.classList.toggle('movemode', !!f.noResize);
    figEl.classList.toggle('selected', f === S.sel);
    handleEl.hidden = !!f.noResize;
    if (typeof moveEl !== 'undefined') {
      moveEl.hidden = !f.move;
      moveEl.classList.toggle('vertical', !!f.move && f.move.kind === 'vspace');
    }
  }
}

let figDrag = null;
handleEl.addEventListener('mousedown', (e) => {
  if (!S.figHover) return;
  e.preventDefault(); e.stopPropagation();
  figDrag = { f: S.figHover, x0: e.clientX, y0: e.clientY, ratio: 1 };
  ghostEl.hidden = false;
  placeBox(ghostEl, figDrag.f.box);
});
addEventListener('mousemove', (e) => {
  if (!figDrag) return;
  const b = figDrag.f.box;
  const rx = (b.w * pv.scale + (e.clientX - figDrag.x0)) / (b.w * pv.scale);
  const ry = (b.h * pv.scale + (e.clientY - figDrag.y0)) / (b.h * pv.scale);
  const isBox = figDrag.f.kind !== 'figure';                 // boxes: width only (height follows the content)
  const ratio = Math.max(0.1, Math.min(5, isBox || Math.abs(rx - 1) > Math.abs(ry - 1) ? rx : ry));   // figures keep their aspect
  figDrag.ratio = ratio;
  placeBox(ghostEl, { x: b.x, y: b.y, w: b.w * ratio, h: isBox ? b.h : b.h * ratio });
  ratioEl.textContent = '×' + ratio.toFixed(2);
});
addEventListener('mouseup', () => {
  if (!figDrag) return;
  const d = figDrag; figDrag = null;
  ghostEl.hidden = true;
  if (Math.abs(d.ratio - 1) > 0.01) {
    if (d.f.kind === 'tcolorbox') resizeTcolorbox(d.f, d.ratio);
    else if (d.f.kind === 'macrobox') resizeMacroBox(d.f, d.ratio);
    else resizeFigure(d.f, d.ratio);
  }
});

/* Scale a length like 0.68\linewidth, 30.92mm, {.5\textwidth} or \linewidth. */
function scaleLength(v, ratio) {
  const m = /^(\s*\{?\s*)([0-9]*\.?[0-9]+)?(\s*)(.*?)(\s*\}?\s*)$/.exec(v);
  if (!m) return v;
  const num = m[2] ? parseFloat(m[2]) : 1;
  const unit = m[4];
  const n = num * ratio;
  const digits = /^\\/.test(unit) ? 2 : /^(pt|bp|px)$/.test(unit) ? 0 : 1;
  let str = n.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return m[1] + str + m[3] + unit + m[5];
}

function splitOpts(s) {          // split at top-level commas
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '{') depth++; else if (ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function resizeFigure(f, ratio) {
  const line = view.state.doc.line(f.line);
  const m = FIG_RE.exec(line.text);
  if (!m) return;
  const opts = m[2] != null ? splitOpts(m[2]) : [];
  let sized = false;
  const next = opts.map((o) => {
    const kv = /^(\s*)(width|height|scale)(\s*=\s*)(.*)$/.exec(o);
    if (!kv) return o;
    sized = true;
    return kv[1] + kv[2] + kv[3] + scaleLength(kv[4], ratio);
  });
  if (!sized) next.unshift(`width=${Math.round(f.box.w * ratio)}bp`);
  const optStr = '[' + next.join(',').replace(/^,/, '') + ']';
  const start = line.from + m.index;
  const head = '\\' + m[1];
  const oldEnd = start + m[0].length - 1;                      // up to the {
  view.dispatch({ changes: { from: start, to: oldEnd, insert: head + optStr } });
  status(`Resized ×${ratio.toFixed(2)} (line ${f.line})`);
}

/* \begin{tcolorbox}[..., width=...]: scale width, or add width=<r>\linewidth. */
function resizeTcolorbox(f, ratio) {
  const line = view.state.doc.line(f.line);
  const m = /\\begin\{tcolorbox\}\s*(?:\[([^\]]*)\])?/.exec(line.text);
  if (!m) return;
  const opts = m[1] != null ? splitOpts(m[1]) : [];
  let sized = false;
  const next = opts.map((o) => {
    const kv = /^(\s*)(width)(\s*=\s*)(.*)$/.exec(o);
    if (!kv) return o;
    sized = true;
    return kv[1] + kv[2] + kv[3] + scaleLength(kv[4], ratio);
  });
  if (!sized) next.push(`width=${ratio.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}\\linewidth`);
  const start = line.from + m.index;
  view.dispatch({ changes: { from: start, to: start + m[0].length, insert: '\\begin{tcolorbox}[' + next.join(',').replace(/^,/, '') + ']' } });
  status(`Box width ×${ratio.toFixed(2)} (line ${f.line})`);
}

/* A box macro sized by \linewidth (e.g. \keybox): put this use in a centred
 * minipage of the new width; resizing again rescales that minipage. */
const WRAP_RE = /\\makebox\[\\linewidth\]\{\\begin\{minipage\}\{([^}]*)\}\s*$/;
function resizeMacroBox(f, ratio) {
  const doc = view.state.doc;
  const text = doc.toString();
  const before = text.slice(Math.max(0, f.at - 120), f.at);
  const w = WRAP_RE.exec(before);
  if (w) {
    const valFrom = f.at - before.length + w.index + w[0].indexOf('{', w[0].indexOf('minipage}')) + 1;
    view.dispatch({ changes: { from: valFrom, to: valFrom + w[1].length, insert: scaleLength(w[1], ratio) } });
  } else {
    const width = `${ratio.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}\\linewidth`;
    view.dispatch({ changes: [
      { from: f.at, insert: `\\makebox[\\linewidth]{\\begin{minipage}{${width}}` },
      { from: f.close + 1, insert: '\\end{minipage}}' },
    ] });
  }
  status(`\\${f.name} width ×${ratio.toFixed(2)} (line ${f.line})`);
}


/* ------------------------------------------------------ repositioning */
/* Level 1: move what the source already positions, in its own units.
 *   - TikZ nodes placed `at (x,y)` and textpos blocks: drag anywhere; the
 *     coordinates are rewritten (units from the one-slide build's probes).
 *   - Other figures and boxes: drag up or down; a \vspace before them is
 *     added or changed (and corrected once, so the slide moves as dragged).
 *   - Column dividers: drag to rebalance the two \column widths.
 *   - Arrow keys move the selected item (click selects; Shift: 5 mm, Alt: 0.25 mm). */
const PT = { pt: 1, bp: 72.27 / 72, mm: 72.27 / 25.4, cm: 72.27 / 2.54, in: 72.27, pc: 12, dd: 1238 / 1157, cc: 12 * 1238 / 1157 };
const BP2PT = 72.27 / 72;
function fmtNum(v, dec) { const s = v.toFixed(dec).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''); return s === '-0' ? '0' : s; }
function decimalsOf(str) { const m = /\.(\d+)/.exec(str); return m ? m[1].length : 0; }
function unitDec(unit) { return unit == null ? 3 : unit === '' ? 2 : /^(cm|in)$/.test(unit) ? 2 : 1; }   // about 0.3 mm or better
function probes() { return (S.preview && S.preview.probes) || { units: {}, lw: {}, tp: {} }; }

/* the span of a balanced (...) starting at text[i] === '(' */
function parenEnd(text, i) {
  let d = 0;
  for (let k = i; k < text.length; k++) {
    const c = text[k];
    if (c === '(' || c === '[' || c === '{') d++;
    else if ((c === ')' || c === ']' || c === '}') && --d === 0) return k;
  }
  return -1;
}

/* A node's `at (...)` on its line, and where its content ends. */
function nodeAt(line) {
  const doc = view.state.doc, L = doc.line(line), text = doc.toString();
  const m = /\\node\b[^;]*?\bat\s*\(/.exec(L.text);
  if (!m) return null;
  const open = L.from + m.index + m[0].length - 1;
  const close = parenEnd(text, open);
  if (close < 0) return null;
  let k = close + 1;
  while (/\s/.test(text[k] || '')) k++;
  const cEnd = text[k] === '{' ? matchClose(text, k) : -1;
  return { from: open + 1, to: close, inner: text.slice(open + 1, close), endLine: cEnd > 0 ? doc.lineAt(cEnd).number : line };
}

async function findMovables() {
  if (!S.frame) return;
  const doc = view.state.doc;
  const last = Math.min(S.frame.end, doc.lines);
  const containers = [];
  let tikz = 0;
  for (let l = S.frame.start; l <= last; l++) {
    const t = doc.line(l).text.replace(/(^|[^\\])%.*$/, '$1');
    if (/\\begin\{tikzpicture\}/.test(t)) tikz++;
    if (tikz && /\\node\b[^;]*?\bat\s*\(/.test(t)) { const n = nodeAt(l); if (n) containers.push({ kind: 'node', line: l, end: n.endLine }); }
    if (/\\end\{tikzpicture\}/.test(t)) tikz = Math.max(0, tikz - 1);
    const tb = /\\begin\{textblock(\*?)\}/.exec(t);
    if (tb) {
      let end = l;
      for (let k = l; k <= last; k++) if (/\\end\{textblock\*?\}/.test(doc.line(k).text)) { end = k; break; }
      containers.push({ kind: 'textblock', line: l, end });
    }
  }
  for (const f of S.figs) {
    const c = containers.find((c) => f.line >= c.line && f.line <= c.end);
    f.move = c ? { kind: c.kind, line: c.line } : { kind: 'vspace', line: f.line };
  }
  for (const c of containers) {
    if (S.figs.some((f) => f.move.kind === c.kind && f.move.line === c.line)) {
      // the container's box is what it holds
      const inner = S.figs.filter((f) => f.move.line === c.line);
      const u = unionOf(inner.map((f) => f.box));
      if (inner.length > 1 && u) S.figs.push({ kind: c.kind, line: c.line, box: u, noResize: true, move: { kind: c.kind, line: c.line } });
      continue;
    }
    const u = await contentBox(c.line, c.end);
    if (u && u.w > 2 && u.h > 2) S.figs.push({ kind: c.kind, line: c.line, box: u, noResize: true, move: { kind: c.kind, line: c.line } });
  }
  await findColumns();
  if (S.sel) S.sel = S.figs.find((f) => f.kind === S.sel.kind && f.line === S.sel.line) || null;
  drawFigs(S.figHover && S.figs.includes(S.figHover) ? S.figHover : S.sel);
}

/* ---- columns */
const COL_RE = /\\(?:column|begin\{column\})\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/;
async function findColumns() {
  S.cols = [];
  const doc = view.state.doc;
  const last = Math.min(S.frame.end, doc.lines);
  const stack = [];
  for (let l = S.frame.start; l <= last; l++) {
    const t = doc.line(l).text.replace(/(^|[^\\])%.*$/, '$1');
    if (/\\begin\{columns\}/.test(t)) stack.push({ cols: [] });
    const cm = COL_RE.exec(t);
    if (cm && stack.length && /^\s*\\(?:column\b|begin\{column\})/.test(t)) stack[stack.length - 1].cols.push({ line: l, val: cm[1] });
    if (/\\end\{columns\}/.test(t) && stack.length) {
      const blk = stack.pop();
      const lw = probes().lw[blk.cols.length ? blk.cols[0].line : -1];
      // a \column line carries the box of the column it closes: column k runs
      // from the line after its \column to the next \column (or \end{columns})
      for (let k = 0; k < blk.cols.length; k++) blk.cols[k].end = k + 1 < blk.cols.length ? blk.cols[k + 1].line : l;
      const boxes = [];
      // records wider than the column (the whole columns row) are not its content
      for (const c of blk.cols) { const w = lw && widthPt(c.val, lw); boxes.push(await contentBox(c.line + 1, c.end, w ? w / BP2PT + 3 : Infinity)); }
      for (let k = 0; k + 1 < blk.cols.length; k++) {
        const a = boxes[k], b = boxes[k + 1];
        if (!a || !b || !lw || b.x < a.x + a.w - 3) continue;        // columns may touch (full-width boxes)
        S.cols.push({ x: (a.x + a.w + b.x) / 2, y0: Math.min(a.y, b.y), y1: Math.max(a.y + a.h, b.y + b.h),
          left: blk.cols[k], right: blk.cols[k + 1], lw });
      }
    }
  }
}

function widthPt(val, lw) {
  const rel = /^\s*([0-9]*\.?[0-9]+)?\s*\\(?:linewidth|textwidth|columnwidth|hsize)\s*$/.exec(val);
  if (rel) return (rel[1] ? parseFloat(rel[1]) : 1) * lw;
  const abs = /^\s*([0-9]*\.?[0-9]+)\s*(pt|bp|mm|cm|in|pc|dd|cc)\s*$/.exec(val);
  return abs ? parseFloat(abs[1]) * PT[abs[2]] : null;
}
/* a width like 0.5\linewidth or 5cm, changed by d pt (relative widths: d / lw) */
function shiftWidth(val, dPt, lw) {
  const rel = /^\s*([0-9]*\.?[0-9]+)?\s*(\\(?:linewidth|textwidth|columnwidth|hsize))\s*$/.exec(val);
  if (rel) {
    const f = rel[1] ? parseFloat(rel[1]) : 1, nf = f + dPt / lw;
    return nf < 0.03 ? null : fmtNum(nf, Math.max(2, decimalsOf(rel[1] || '')) ) + rel[2];
  }
  const abs = /^\s*([-+]?[0-9]*\.?[0-9]+)\s*(pt|bp|mm|cm|in|pc|dd|cc)\s*$/.exec(val);
  if (abs) {
    const nv = parseFloat(abs[1]) + dPt / PT[abs[2]];
    return nv * PT[abs[2]] < 10 ? null : fmtNum(nv, Math.max(1, decimalsOf(abs[1]))) + abs[2];
  }
  return null;
}

function moveColumns(col, dxBp) {
  const d = dxBp * BP2PT;
  const lv = shiftWidth(col.left.val, d, col.lw), rv = shiftWidth(col.right.val, -d, col.lw);
  if (!lv || !rv) { status('These column widths cannot be changed by dragging (edit them in the code).', 'bad'); return; }
  const doc = view.state.doc, changes = [];
  for (const [c, v] of [[col.left, lv], [col.right, rv]]) {
    const L = doc.line(c.line), m = COL_RE.exec(L.text);
    const at = L.from + m.index + m[0].lastIndexOf('{') + 1;
    changes.push({ from: at, to: at + m[1].length, insert: v });
  }
  view.dispatch({ changes });
  status(`Columns: ${lv} | ${rv}`);
}

/* ---- nodes and textpos blocks */
function moveNode(line, dxBp, dyBp) {
  const n = nodeAt(line);
  if (!n) return false;
  const Dx = dxBp * BP2PT, Dy = -dyBp * BP2PT;                 // TikZ y points up
  const num = /^(\s*)([-+]?[0-9]*\.?[0-9]+)\s*(pt|bp|mm|cm|in|pc|dd|cc)?(\s*,\s*)([-+]?[0-9]*\.?[0-9]+)\s*(pt|bp|mm|cm|in|pc|dd|cc)?(\s*)$/.exec(n.inner);
  let inner = null;
  if (num) {
    const [ax, ay, bx, by] = probes().units[line] || [PT.cm, 0, 0, PT.cm];     // TikZ default: 1 cm
    const det = ax * by - bx * ay;
    let u = det ? (Dx * by - bx * Dy) / det : 0, v = det ? (ax * Dy - ay * Dx) / det : 0;
    const x = parseFloat(num[2]), y = parseFloat(num[5]);
    const nx = num[3] ? x + Dx / PT[num[3]] : x + u;
    const ny = num[6] ? y + Dy / PT[num[6]] : y + v;
    const dec = (s, unit) => Math.max(unitDec(unit || null), decimalsOf(s));
    inner = `${num[1]}${fmtNum(nx, dec(num[2], num[3]))}${num[3] || ''}${num[4]}${fmtNum(ny, dec(num[5], num[6]))}${num[6] || ''}${num[7]}`;
  } else if (!/[$:]/.test(n.inner)) {
    // a named coordinate or anchor, maybe with [xshift=..,yshift=..]
    const m = /^\s*(?:\[([^\]]*)\])?\s*(.+?)\s*$/.exec(n.inner);
    const opts = m[1] ? splitOpts(m[1]).map((o) => o.trim()).filter(Boolean) : [];
    const bump = (key, dPt) => {
      const i = opts.findIndex((o) => new RegExp('^' + key + '\\s*=').test(o));
      let mm = dPt / PT.mm;
      if (i >= 0) {
        const v = /=\s*([-+]?[0-9]*\.?[0-9]+)\s*(pt|bp|mm|cm|in)\s*$/.exec(opts[i]);
        if (!v) return false;
        const nv = parseFloat(v[1]) + dPt / PT[v[2]];
        opts[i] = `${key}=${fmtNum(nv, Math.max(unitDec(v[2]), decimalsOf(v[1])))}${v[2]}`;
      } else if (Math.abs(mm) >= 0.05) opts.push(`${key}=${fmtNum(mm, 1)}mm`);
      return true;
    };
    if (!bump('xshift', Dx) || !bump('yshift', Dy)) return false;
    inner = (opts.length ? `[${opts.join(',')}]` : '') + m[2];
  }
  if (inner == null) return false;
  view.dispatch({ changes: { from: n.from, to: n.to, insert: inner } });
  return true;
}

function moveTextblock(line, dxBp, dyBp) {
  const L = view.state.doc.line(line);
  const m = /\\begin\{textblock(\*?)\}\s*\{[^}]*\}\s*\(([^)]*)\)/.exec(L.text);
  if (!m) return false;
  const parts = m[2].split(',');
  if (parts.length !== 2) return false;
  const Dx = dxBp * BP2PT, Dy = dyBp * BP2PT;                   // textpos y points down
  const [h, v] = probes().tp[line] || [PT.cm, PT.cm];
  const one = (str, dPt, mod) => {
    const u = /^(\s*)([-+]?[0-9]*\.?[0-9]+)\s*(pt|bp|mm|cm|in|pc|dd|cc)?(\s*)$/.exec(str);
    if (!u) return null;
    const unit = u[3] || (m[1] ? null : '');
    if (unit === null) return null;
    const nv = parseFloat(u[2]) + (unit ? dPt / PT[unit] : dPt / mod);
    return `${u[1]}${fmtNum(nv, Math.max(unitDec(unit), decimalsOf(u[2])))}${unit}${u[4]}`;
  };
  const nx = one(parts[0], Dx, h), ny = one(parts[1], Dy, v);
  if (nx == null || ny == null) return false;
  const at = L.from + m.index + m[0].lastIndexOf('(') + 1;
  view.dispatch({ changes: { from: at, to: at + m[2].length, insert: `${nx},${ny}` } });
  return true;
}

/* ---- vertical nudges through \vspace */
const OVERLAY_ONLY = /^\s*\\(?:visible|uncover|only|onslide|invisible)\s*(?:<[^>]*>)?\s*$/;
function blockStart(line) {                       // \visible<2-> on the line above takes the block as its argument
  const doc = view.state.doc;
  let l = line;
  while (l > S.frame.start + 1 && OVERLAY_ONLY.test(doc.line(l - 1).text)) l--;
  return l;
}
// \par first: at the start of a column TeX is in horizontal mode, where a bare
// \vspace would wait for the end of the line (below the block)
const VSPACE_RE = /^(\s*(?:\\par\s*)?)\\vspace(\*?)\{\s*([-+]?[0-9]*\.?[0-9]+)\s*(pt|bp|mm|cm|in)\s*\}\s*$/;
/* The last line of a block that moves with it: a figure's caption, a box's
 * \end{tcolorbox}, a macro's closing brace. */
function blockEnd(f) {
  if (f.kind === 'figure') { const c = captionOf(f); return c && c.line > f.line ? c.line : f.line; }
  if (f.kind === 'tcolorbox' && f.end) return f.end;
  if (f.kind === 'macrobox' && f.close != null) return view.state.doc.lineAt(f.close).number;
  return f.line;
}
/* Change the \vspace on line `at` by dPt, or insert one there (before:
 * above line `at`, else below it). Returns lines added (+1), removed (-1). */
function bumpVspace(at, dPt, before, indent) {
  const doc = view.state.doc;
  const L = doc.line(at);
  const m = VSPACE_RE.exec(L.text);
  if (m) {
    const nv = parseFloat(m[3]) + dPt / PT[m[4]];
    if (Math.abs(nv * PT[m[4]]) < 0.15) { view.dispatch({ changes: { from: L.from, to: Math.min(L.to + 1, doc.length), insert: '' } }); return -1; }
    view.dispatch({ changes: { from: L.from, to: L.to, insert: `${m[1]}\\vspace${m[2]}{${fmtNum(nv, Math.max(1, decimalsOf(m[3])))}${m[4]}}` } });
    return 0;
  }
  const v = `${indent}\\par\\vspace{${fmtNum(dPt / PT.mm, 1)}mm}`;
  view.dispatch({ changes: before ? { from: L.from, insert: v + '\n' } : { from: L.to, insert: '\n' + v } });
  return 1;
}
/* Move a block down by dyBp: space above it, the same space taken away below
 * it, so its column keeps its height and nothing else re-centres. Returns
 * the block's new first line. */
function nudgeVspace(f, dyBp) {
  const doc = view.state.doc;
  const dPt = dyBp * BP2PT;
  const start = blockStart(f.move.line);
  let end = blockEnd(f);
  const indent = /^\s*/.exec(doc.line(start).text)[0];
  // below first (so the lines above keep their numbers)
  const after = end + 1 <= Math.min(S.frame.end - 1, doc.lines) && VSPACE_RE.test(doc.line(end + 1).text) ? end + 1 : null;
  if (after) bumpVspace(after, -dPt, false, indent); else bumpVspace(end, -dPt, false, indent);
  let p = start - 1;
  while (p > S.frame.start && !doc.line(p).text.trim()) p--;
  const above = p > S.frame.start && VSPACE_RE.test(view.state.doc.line(p).text) ? p : null;
  const added = above ? bumpVspace(above, dPt, true, indent) : bumpVspace(start, dPt, true, indent);
  return f.line + added;
}

async function waitPreview(ms = 8000) {
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 120));
  while (Date.now() - t0 < ms && (S.compiling || S.stale)) await new Promise((r) => setTimeout(r, 80));
  if (S.figsReady) await S.figsReady;
}

/* Move a figure or box (f) by (dx, dy) bp on the slide. */
async function moveItem(f, dxBp, dyBp, correct = true) {
  const mv = f.move;
  if (!mv) return;
  if (mv.kind === 'node') {
    if (!moveNode(mv.line, dxBp, dyBp)) { status('This node is placed with an expression; move it in the code.', 'bad'); return; }
    status(`Moved the node on line ${mv.line}`);
  } else if (mv.kind === 'textblock') {
    if (!moveTextblock(mv.line, dxBp, dyBp)) { status('This textpos block could not be moved (edit its position in the code).', 'bad'); return; }
    status(`Moved the block on line ${mv.line}`);
  } else {
    if (Math.abs(dyBp) < 0.3) return;
    const y0 = f.box.y, kind = f.kind;
    const line = nudgeVspace(f, dyBp);
    if (S.sel === f) S.sel = { kind, line };
    status(`Space above line ${line}: ${dyBp > 0 ? '+' : ''}${fmtNum(dyBp / 72 * 25.4, 1)} mm`);
    if (!correct || !S.live) return;
    // a centred frame or column moves the block by a fraction of the space: correct once
    await waitPreview();
    const g = S.figs.find((x) => x.kind === kind && x.line === line);
    if (!g) return;
    const got = g.box.y - y0;
    if (got * dyBp > 0 && Math.abs(got - dyBp) > 1 && Math.abs(got) > 0.5) nudgeVspace(g, dyBp * (dyBp / got - 1));
  }
}

/* ---- the move grip, the column handle and the keys */
const moveEl = document.createElement('div'); moveEl.className = 'fig-move'; moveEl.title = 'Drag to move';
figEl.appendChild(moveEl);
const colEl = document.createElement('div'); colEl.className = 'col-handle'; colEl.hidden = true; colEl.title = 'Drag to change the column widths';
const colLbl = document.createElement('div'); colLbl.className = 'fig-ratio col-label'; colEl.appendChild(colLbl);
$('pagewrap').appendChild(colEl);
S.cols = [];

let moveDrag = null, colDrag = null;
moveEl.addEventListener('mousedown', (e) => {
  if (!S.figHover || !S.figHover.move) return;
  e.preventDefault(); e.stopPropagation();
  S.sel = S.figHover;
  moveDrag = { f: S.figHover, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0 };
  ghostEl.hidden = false;
  placeBox(ghostEl, moveDrag.f.box);
  ratioEl.textContent = '';
});
colEl.addEventListener('mousedown', (e) => {
  if (!S.colHover) return;
  e.preventDefault(); e.stopPropagation();
  colDrag = { c: S.colHover, x0: e.clientX, dx: 0 };
});
addEventListener('mousemove', (e) => {
  if (moveDrag) {
    const free = moveDrag.f.move.kind !== 'vspace';
    moveDrag.dx = free ? (e.clientX - moveDrag.x0) / pv.scale : 0;
    moveDrag.dy = (e.clientY - moveDrag.y0) / pv.scale;
    const b = moveDrag.f.box;
    placeBox(ghostEl, { x: b.x + moveDrag.dx, y: b.y + moveDrag.dy, w: b.w, h: b.h });
    const mm = (v) => fmtNum(v / 72 * 25.4, 1);
    ratioEl.textContent = free ? `→ ${mm(moveDrag.dx)} ↓ ${mm(moveDrag.dy)} mm` : `↓ ${mm(moveDrag.dy)} mm`;
  } else if (colDrag) {
    colDrag.dx = (e.clientX - colDrag.x0) / pv.scale;
    const c = colDrag.c, d = colDrag.dx * BP2PT;
    placeCol(c, colDrag.dx);
    colLbl.textContent = `${shiftWidth(c.left.val, d, c.lw) || '?'} | ${shiftWidth(c.right.val, -d, c.lw) || '?'}`;
  }
});
addEventListener('mouseup', () => {
  if (moveDrag) {
    const d = moveDrag; moveDrag = null;
    ghostEl.hidden = true;
    if (Math.hypot(d.dx, d.dy) > 0.5) moveItem(d.f, d.dx, d.dy);
  } else if (colDrag) {
    const d = colDrag; colDrag = null;
    colLbl.textContent = '';
    if (Math.abs(d.dx) > 0.5) moveColumns(d.c, d.dx); else placeCol(d.c, 0);
  }
});
function placeCol(c, dx) {
  Object.assign(colEl.style, { left: (c.x + dx) * pv.scale - 4 + 'px', top: c.y0 * pv.scale + 'px', height: (c.y1 - c.y0) * pv.scale + 'px' });
}
function colAt(x, y) { return S.cols.find((c) => Math.abs(x - c.x) < 6 && y >= c.y0 && y <= c.y1) || null; }

// Arrow keys move the selected item (not while typing in the code or a box)
addEventListener('keydown', (e) => {
  if (!S.sel || !S.sel.move || !e.key.startsWith('Arrow') || e.metaKey || e.ctrlKey) return;
  if (view.hasFocus || !popEl.hidden || (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName))) return;
  const step = (e.shiftKey ? 5 : e.altKey ? 0.25 : 1) / 25.4 * 72;            // mm in bp
  const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
  const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
  if (S.sel.move.kind === 'vspace' && !dy) return;
  e.preventDefault();
  moveItem(S.sel, dx, dy, false);
});


/* ------------------------------------------------------- deck settings */
/* Title page, theme, colours, header and footer (app/deck.js reads and
 * edits; every edit goes into the code here, so Cmd-Z undoes it and Live
 * previews it; a preamble change rebuilds the precompiled preamble once). */
const DP = { open: false, info: null, busy: false };
const ASPECTS = [['169', '16:9'], ['1610', '16:10'], ['149', '14:9'], ['43', '4:3 (beamer default)'], ['54', '5:4'], ['32', '3:2']];
const FOOTS = [['default', 'Theme default'], ['none', 'None'], ['number', 'Frame number'], ['authortitle', 'Author · title · n / N']];
const FIELD_LABEL = { title: 'Title', subtitle: 'Subtitle', author: 'Author', institute: 'Institute', date: 'Date' };
const SHORT_OK = { title: 1, author: 1, institute: 1, date: 1 };

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e[k] = v; else if (v != null) e.setAttribute(k, v); }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}
const shortFile = (f) => f && f.replace(/\.(sty|tex)$/, '');

async function deckEdit(edit, what) {
  if (DP.busy) return;
  DP.busy = true;
  try {
    const c = await api.deckEdit(view.state.doc.toString(), edit);
    if (c) { view.dispatch({ changes: c }); status(`${what}: changed in the preamble (Cmd-Z undoes it)`); }
    await refreshDeckPanel();
  } finally { DP.busy = false; }
}

function toggleDeckPanel(open = !DP.open) {
  DP.open = open;
  $('deckpanel').hidden = !open;
  $('btn-settings').classList.toggle('on', open);
  $('right').classList.toggle('panel-open', open);           // the slide shrinks beside the panel
  if (S.preview) renderPage().then(() => { drawCursorBoxes(); S.figsReady = findFigures(); });
  if (open) refreshDeckPanel();
}

async function refreshDeckPanel() {
  if (!DP.open) return;
  const i = DP.info = await api.deckInfo(view.state.doc.toString());
  const P = $('deckpanel');
  const keep = P.scrollTop;
  P.innerHTML = '';
  P.append(el('div', { class: 'dp-head' }, el('b', {}, 'Deck settings'),
    el('button', { type: 'button', class: 'dp-x', title: 'Close (Shift-Cmd-D)', onclick: () => toggleDeckPanel(false) }, '×')));

  // title page
  const tf = el('section', { class: 'dp-sec' }, el('h4', {}, 'Title page'));
  const titleFrame = S.frames.find((f) => { const t = view.state.doc.sliceString(view.state.doc.line(f.start).from, view.state.doc.line(Math.min(f.end, view.state.doc.lines)).to); return /\\(titlepage|maketitle)\b/.test(t); });
  if (titleFrame) tf.append(el('button', { type: 'button', class: 'dp-link', onclick: () => gotoLine(titleFrame.bodyStart, false) }, 'Show the title slide'));
  for (const f of Object.keys(FIELD_LABEL)) {
    const v = i.fields[f] || {};
    const long = el('input', { type: 'text', value: v.long ?? '', placeholder: f === 'date' ? '\\today, or leave empty' : '' });
    const short = SHORT_OK[f] && (v.short != null || v.viaShort || !v.via) ? el('input', { type: 'text', class: 'dp-short', value: v.short ?? '', placeholder: 'short form (footline)' }) : null;
    const send = () => deckEdit({ kind: 'field', field: f, long: long.value, short: short ? short.value || null : v.short, via: v.via, viaShort: v.viaShort }, FIELD_LABEL[f]);
    for (const inp of [long, short]) if (inp) { inp.onchange = send; inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); }; }
    const note = v.via ? `option ${v.via.key}= of ${v.via.pkg}` : v.file && !v.main ? `from ${v.file}; editing adds it to this file` : null;
    tf.append(el('label', { class: 'dp-row' }, el('span', { class: 'dp-lab' }, FIELD_LABEL[f]), el('span', { class: 'dp-in' }, long, short, note ? el('small', {}, note) : null)));
  }
  P.append(tf);

  // themes
  const th = el('section', { class: 'dp-sec' }, el('h4', {}, 'Theme'));
  for (const [k, lab, list] of [['theme', 'Theme', i.installed.theme], ['colortheme', 'Colour theme', i.installed.color], ['fonttheme', 'Font theme', i.installed.font]]) {
    const cur = i.themes[k];
    const sel = el('select', {}, el('option', { value: '' }, '(beamer default)'));
    const names = [...new Set([...(cur && cur.name ? [cur.name] : []), ...list])];
    for (const n of names) sel.append(el('option', { value: n }, n));
    sel.value = cur ? cur.name : '';
    sel.onchange = () => deckEdit({ kind: 'theme', which: k, name: sel.value || null, via: cur && cur.via, after: cur && !cur.main && !cur.via ? cur.file : null }, lab);
    const note = cur && cur.via ? `option ${cur.via.key}= of ${cur.via.pkg}` : cur && !cur.main ? `set in ${cur.file}` : null;
    th.append(el('label', { class: 'dp-row' }, el('span', { class: 'dp-lab' }, lab), el('span', { class: 'dp-in' }, sel, note ? el('small', {}, note) : null)));
  }
  const ar = el('select', {});
  for (const [v, l] of ASPECTS) ar.append(el('option', { value: v }, l));
  ar.value = i.aspect || '43';
  ar.onchange = () => deckEdit({ kind: 'aspect', ratio: ar.value }, 'Aspect ratio');
  th.append(el('label', { class: 'dp-row' }, el('span', { class: 'dp-lab' }, 'Aspect ratio'), el('span', { class: 'dp-in' }, ar)));
  P.append(th);

  // colours
  const co = el('section', { class: 'dp-sec' }, el('h4', {}, 'Colours'));
  if (i.colors.length) {
    co.append(el('p', { class: 'dp-hint' }, 'The deck\'s own colours: changing one changes everything that uses it.'));
    const grid = el('div', { class: 'dp-colors' });
    for (const c of i.colors) {
      const pick = el('input', { type: 'color', value: '#' + c.hex });
      pick.onchange = () => deckEdit({ kind: 'color', name: c.name, hex: pick.value.slice(1) }, `Colour ${c.name}`);
      grid.append(el('label', { class: 'dp-color', title: c.main ? `${c.name}, defined here` : `${c.name}, from ${c.file} (changing it adds an override here)` }, pick, el('span', {}, c.name)));
    }
    co.append(grid);
  }
  co.append(el('p', { class: 'dp-hint' }, 'Beamer\'s colours (empty: from the theme).'));
  for (const sl of i.slots) {
    const row = el('div', { class: 'dp-row dp-slot' }, el('span', { class: 'dp-lab' }, sl.label));
    const box = el('span', { class: 'dp-in dp-pair' });
    for (const key of sl.keys) {
      const v = sl.values[key];
      const pick = el('input', { type: 'color', value: '#' + ((v && v.hex) || (key === 'bg' ? 'FFFFFF' : '000000')) });
      if (!v) pick.classList.add('unset');
      pick.title = v ? `${key}=${v.expr}${v.main ? '' : ` (${v.file})`}` : `${key}: from the theme`;
      pick.onchange = () => deckEdit({ kind: 'slot', slot: sl.slot, key, hex: pick.value.slice(1) }, `${sl.label} ${key === 'fg' ? 'text' : 'background'}`);
      box.append(el('span', { class: 'dp-k' }, key === 'fg' ? 'text' : 'bg'), pick);
      if (v && v.main && new RegExp('^slidex').test(v.expr)) box.append(el('button', { type: 'button', class: 'dp-reset', title: 'Back to the theme\'s colour',
        onclick: () => deckEdit({ kind: 'slot', slot: sl.slot, key, hex: null }, `${sl.label} ${key}`) }, '↺'));
    }
    row.append(box);
    co.append(row);
  }
  P.append(co);

  // header and footer
  const hf = el('section', { class: 'dp-sec' }, el('h4', {}, 'Header and footer'));
  const t = i.templates;
  const foot = el('select', {});
  for (const [v, l] of FOOTS) foot.append(el('option', { value: v }, l));
  const fcur = !t.footline || !t.footline.main ? 'default' : t.footline.empty ? 'none' : t.footline.preset === 'frame number' ? 'number' : 'custom';
  if (fcur === 'custom') foot.append(el('option', { value: 'custom' }, 'Custom (in the code)'));
  foot.value = fcur;
  foot.onchange = () => { if (foot.value !== 'custom') deckEdit({ kind: 'footline', preset: foot.value }, 'Footline'); };
  hf.append(el('label', { class: 'dp-row' }, el('span', { class: 'dp-lab' }, 'Footline'), el('span', { class: 'dp-in' }, foot,
    t.footline && !t.footline.main ? el('small', {}, `the theme default here is set in ${t.footline.file}`) : null)));
  const head = el('input', { type: 'checkbox' });
  head.checked = !(t.headline && t.headline.main && t.headline.empty);
  head.onchange = () => deckEdit({ kind: 'headline', on: head.checked }, 'Headline');
  hf.append(el('label', { class: 'dp-row dp-check' }, head, 'Headline (section navigation, if the theme has one)'));
  const nav = el('input', { type: 'checkbox' });
  nav.checked = !(t.nav && t.nav.empty);
  nav.disabled = !!(t.nav && !t.nav.main && t.nav.empty);
  nav.onchange = () => deckEdit({ kind: 'nav', on: nav.checked }, 'Navigation symbols');
  hf.append(el('label', { class: 'dp-row dp-check', title: nav.disabled ? `turned off in ${t.nav.file}` : '' }, nav, 'Navigation symbols'));
  P.append(hf);
  P.scrollTop = keep;
}
$('btn-settings').onclick = () => toggleDeckPanel();

/* --------------------------------------------------- click to edit text */
const popEl = document.createElement('div'); popEl.className = 'text-pop'; popEl.hidden = true;
const popTa = document.createElement('textarea'); popTa.spellcheck = true;
const popHint = document.createElement('div'); popHint.className = 'text-pop-hint';
popHint.textContent = 'Enter applies, Esc cancels, Shift-Enter for a new line';
popEl.append(popTa, popHint);
$('preview').appendChild(popEl);
let popLine = null;
let popSession = 0;                  // each box closes only itself on blur

async function openTextEdit(line, anchor = null, select = null) {
  const boxes = anchor ? [anchor] : ((await api.boxesForLine(line)) || []).filter((b) => b.page === S.preview.page);
  const b = boxes[0];
  if (!b) { gotoLine(line); return; }
  const text = view.state.doc.line(line).text;
  popSession++;
  popLine = { line, indent: /^\s*/.exec(text)[0], original: text, box: b };
  popTa.value = text.trim();
  const wr = $('pagewrap').getBoundingClientRect(), pr = $('preview').getBoundingClientRect();
  const left = Math.max(6, Math.min(wr.left - pr.left + b.x * pv.scale, pr.width - 380));
  const top = wr.top - pr.top + (b.y + b.h) * pv.scale + 6;
  Object.assign(popEl.style, { left: left + 'px', top: Math.min(top, pr.height - 130) + 'px',
    width: Math.max(360, Math.min(b.w * pv.scale, pr.width - 20)) + 'px' });
  popEl.hidden = false;
  popTa.style.height = 'auto';
  popTa.style.height = Math.min(220, popTa.scrollHeight + 4) + 'px';
  popTa.focus();
  if (select) { const i = popTa.value.indexOf(select); if (i >= 0) popTa.setSelectionRange(i, i + select.length); else popTa.select(); }
  else popTa.select();
  gotoLine(line, false);
}
function closeTextEdit(apply) {
  if (!popLine) return;
  const p = popLine; popLine = null;
  popEl.hidden = true;
  if (apply) {
    const lineObj = view.state.doc.line(p.line);
    if (lineObj.text === p.original) {                         // the line did not move meanwhile
      const text = popTa.value.split('\n').map((t, i) => (i ? p.indent : '') + t).join('\n');
      if (p.indent + text !== p.original) view.dispatch({ changes: { from: lineObj.from, to: lineObj.to, insert: p.indent + text } });
    }
  }
  view.focus();
}
popTa.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') { e.preventDefault(); closeTextEdit(false); }
  else if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const p = popLine;
    const atEnd = popTa.selectionStart === popTa.value.length && popTa.selectionEnd === popTa.value.length;
    const item = /^\\item\b/.test(popTa.value.trim());
    if (p && item && atEnd && popTa.value.trim() !== '\\item') {      // next item, edited in place too
      closeTextEdit(true);
      const at = view.state.doc.line(p.line);
      view.dispatch({ changes: { from: at.to, insert: '\n' + p.indent + '\\item ' } });
      const b = p.box;
      openTextEdit(p.line + 1, { x: b.x, y: b.y + b.h + 2, w: b.w, h: b.h, page: b.page });
      popTa.setSelectionRange(popTa.value.length, popTa.value.length);
    } else closeTextEdit(true);
  }
});
popTa.addEventListener('input', () => { popTa.style.height = 'auto'; popTa.style.height = Math.min(220, popTa.scrollHeight + 4) + 'px'; });
popTa.addEventListener('blur', () => { const sid = popSession; setTimeout(() => { if (sid === popSession) closeTextEdit(true); }, 0); });

/* ------------------------------------------------ right-click: captions */
/* A caption is a \caption in the figure's figure environment, or the line
 * right after the figure when it is a small-text line ({\small ...}). */
function captionOf(f) {
  const doc = view.state.doc;
  let envStart = null;
  for (let l = f.line; l >= S.frame.start; l--) {
    const t = doc.line(l).text;
    if (/\\end\{figure\*?\}/.test(t) && l !== f.line) break;
    if (/\\begin\{figure\*?\}/.test(t)) { envStart = l; break; }
  }
  if (envStart) {
    for (let l = envStart; l <= S.frame.end && l <= doc.lines; l++) {
      const t = doc.line(l).text;
      if (/\\caption\b/.test(t)) return { line: l, inFigure: true };
      if (/\\end\{figure\*?\}/.test(t)) break;
    }
    return { line: null, inFigure: true };
  }
  const next = f.line < doc.lines ? doc.line(f.line + 1).text.trim() : '';
  if (/^\{\\(small|footnotesize|scriptsize|tiny)\b|^\\caption\b/.test(next)) return { line: f.line + 1, inFigure: false };
  return { line: null, inFigure: false };
}

function addCaption(f) {
  const doc = view.state.doc;
  const c = captionOf(f);
  const line = doc.line(f.line);
  const indent = /^\s*/.exec(line.text)[0];
  const changes = [];
  let newText;
  if (c.inFigure) newText = indent + '\\caption{Caption}';
  else {
    if (!/\\\\\s*(\[[^\]]*\])?\s*$/.test(line.text)) changes.push({ from: line.to, insert: '\\\\' });   // break after the figure
    newText = indent + '{\\small Caption}';
  }
  changes.push({ from: line.to, insert: '\n' + newText });
  view.dispatch({ changes });
  const b = f.box;
  openTextEdit(f.line + 1, { x: b.x, y: b.y + b.h + 2, w: Math.max(b.w, 160), h: 12, page: b.page }, 'Caption');
}

const menuEl = document.createElement('div'); menuEl.className = 'ctx-menu'; menuEl.hidden = true;
document.body.appendChild(menuEl);
function showMenu(x, y, items) {
  menuEl.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = it.label;
    b.onclick = () => { menuEl.hidden = true; it.run(); };
    menuEl.appendChild(b);
  }
  Object.assign(menuEl.style, { left: Math.min(x, innerWidth - 200) + 'px', top: Math.min(y, innerHeight - 40 * items.length) + 'px' });
  menuEl.hidden = false;
}
addEventListener('mousedown', (e) => { if (!menuEl.hidden && !e.target.closest('.ctx-menu')) menuEl.hidden = true; }, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menuEl.hidden) menuEl.hidden = true; }, true);

$('preview').addEventListener('contextmenu', (e) => {
  if (!S.preview || S.stale) return;
  const r = $('pagewrap').getBoundingClientRect();
  const f = figAt((e.clientX - r.left) / pv.scale, (e.clientY - r.top) / pv.scale);
  if (!f) return;
  e.preventDefault();
  if (f.kind !== 'figure') { showMenu(e.clientX, e.clientY, [{ label: 'Go to source', run: () => gotoLine(f.line) }]); return; }
  const c = captionOf(f);
  const items = [];
  if (c.line) items.push({ label: 'Edit caption', run: () => openTextEdit(c.line) });
  else items.push({ label: 'Add caption', run: () => addCaption(f) });
  items.push({ label: 'Go to source', run: () => gotoLine(f.line) });
  showMenu(e.clientX, e.clientY, items);
});

/* Click: show the source line in the code (focus stays here). Double-click
 * on text: edit it in place. Figures win a click; inside boxes, text does. */
/* The text of the slide under a point (page points from the top-left), from
 * pdf.js: the nearest text item within a few points, or null. */
async function textAt(x, y) {
  try {
    const key = pv.url + '#' + S.preview.page;
    if (!pv.text || pv.text.key !== key) {
      const page = await pv.doc.getPage(S.preview.page);
      pv.text = { key, vp: page.getViewport({ scale: 1 }), tc: await page.getTextContent() };
    }
    const { vp, tc } = pv.text;
    let best = null, bd = 4, box = null;
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const h = Math.hypot(it.transform[2], it.transform[3]) || it.height || 8;
      const [bx, by] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
      const dx = Math.max(bx - x, 0, x - (bx + it.width)), dy = Math.max(by - h - y, 0, y - (by + 0.25 * h));
      const d = Math.hypot(dx, dy);
      if (d < bd) { bd = d; best = it.str; box = { x: bx, y: by - h, w: it.width, h: 1.25 * h, page: S.preview.page }; }
    }
    return best ? { str: best, box, d: bd } : null;
  } catch { return null; }
}

/* SyncTeX puts everything read as one macro argument (for example a box in
 * \visible<2->{...}) on the argument's last line. When the line it gives does
 * not hold the words under the mouse, use the frame's line that does. */
const wordsOf = (t) => (t.normalize('NFKC').match(/[A-Za-z][A-Za-z'-]{2,}/g) || []);
async function refineHit(hit, x, y) {
  const f = S.frame;
  if (!hit || !f || hit.line < f.start || hit.line > f.end) return hit;
  const t = await textAt(x, y);
  const words = t ? wordsOf(t.str) : [];
  if (!words.length) return hit;
  const score = (l) => { const t = view.state.doc.line(l).text.replace(/^\s*%.*$/, ''); return words.filter((w) => t.includes(w)).length; };
  if (score(hit.line) === words.length) return hit;
  let best = null, bs = 0;
  for (let l = f.start; l <= f.end; l++) {
    const sc = score(l);
    if (sc > bs || (sc === bs && sc && Math.abs(l - hit.line) < Math.abs(best - hit.line))) { bs = sc; best = l; }
  }
  return best && bs > score(hit.line) && bs >= Math.min(2, words.length) ? { line: best, exact: true, byText: true, box: t.box } : hit;
}

async function previewHit(e) {
  if (e.target.closest('.text-pop') || e.target.closest('.fig-handle') || !S.preview || S.stale) return null;
  const r = $('pagewrap').getBoundingClientRect();
  const x = (e.clientX - r.left) / pv.scale, y = (e.clientY - r.top) / pv.scale;
  const fig = figAt(x, y);
  if (fig && fig.kind === 'figure') {                         // text on top of a figure's area wins
    const t = await textAt(x, y);
    if (!t || t.d > 1) return { fig };
  }
  const hit = await refineHit(await api.lineAt(S.preview.page, x, y), x, y);
  if (hit) return { hit, x, y };
  return fig ? { fig } : null;
}
$('preview').addEventListener('click', async (e) => {
  if (e.detail > 1) return;                                     // part of a double-click
  const h = await previewHit(e);
  if (!h) return;
  gotoLine(h.fig ? h.fig.line : h.hit.line, false);
});
$('preview').addEventListener('dblclick', async (e) => {
  const h = await previewHit(e);
  if (!h) return;
  if (h.hit && h.hit.exact) openTextEdit(h.hit.line, h.hit.box || null);
  else gotoLine(h.fig ? h.fig.line : h.hit.line);
});
$('preview').addEventListener('mousemove', (e) => {
  if (figDrag || moveDrag || colDrag) return;
  const r = $('pagewrap').getBoundingClientRect();
  const x = (e.clientX - r.left) / pv.scale, y = (e.clientY - r.top) / pv.scale;
  S.colHover = colAt(x, y);
  colEl.hidden = !S.colHover;
  if (S.colHover) placeCol(S.colHover, 0);
  if (!S.figs.length) return;
  const f = figAt(x, y) || S.sel;
  if (f !== S.figHover) drawFigs(f);
});
$('preview').addEventListener('mouseleave', () => {
  if (figDrag || moveDrag || colDrag) return;
  drawFigs(S.sel || null);
  if (!colDrag) colEl.hidden = true;
});
// a click on the slide selects the figure or box under it (arrow keys move it)
$('preview').addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.closest('.fig-handle, .fig-move, .col-handle, .text-pop')) return;
  const r = $('pagewrap').getBoundingClientRect();
  const f = S.figs.length ? figAt((e.clientX - r.left) / pv.scale, (e.clientY - r.top) / pv.scale) : null;
  S.sel = f && f.move ? f : null;
  if (S.sel && view.hasFocus) view.contentDOM.blur();
  drawFigs(f);
});
addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.sel && !view.hasFocus && popEl.hidden) { S.sel = null; drawFigs(null); } });

/* ------------------------------------------------------- deck follows */
function followDeck(f) {
  if (!S.chan || !S.pageFrames.length) return;
  const page = S.pageFrames.indexOf(frameKeyOf(f));
  if (page < 0 || page === S.lastSentPage) return;
  S.lastSentPage = page;
  S.chan.postMessage({ type: 'goto', page });
}
function listenDeck() {
  S.chan = new BroadcastChannel('slidex:' + S.deckUrl);
  S.chan.onmessage = (e) => {
    const d = e.data || {};
    if (d.type !== 'goto' || d.page === S.lastSentPage) return;
    S.lastSentPage = d.page;
    const key = S.pageFrames[d.page];
    const f = S.frames.find((x) => frameKeyOf(x) === key);
    if (f && (!S.frame || f.start !== S.frame.start)) { gotoLine(f.bodyStart, false); switchFrame(f, true); }
  };
}

/* ------------------------------------------------------------- layout */
let dragX = null;
$('divider').addEventListener('mousedown', (e) => { dragX = e.clientX; e.preventDefault(); });
addEventListener('mousemove', (e) => {
  if (dragX === null) return;
  const w = Math.min(Math.max(240, e.clientX - $('strip').offsetWidth), innerWidth - 260 - $('strip').offsetWidth);
  $('code').style.width = w + 'px';
});
addEventListener('mouseup', () => { if (dragX !== null) { dragX = null; renderPage().then(drawCursorBoxes); } });
let rt = 0;
addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => renderPage().then(drawCursorBoxes), 120); });
$('btn-frame').onclick = compileFrame;
$('btn-deck').onclick = compileDeck;
$('btn-save').onclick = save;
$('live').onchange = () => { S.live = $('live').checked; if (S.live && S.stale) compileFrame(); };
$('btn-present').onclick = () => api.present(S.frame ? frameKeyOf(S.frame) : null);
$('btn-compile-present').onclick = async () => {
  $('btn-compile-present').disabled = true;
  const ok = await compileDeck();
  $('btn-compile-present').disabled = false;
  if (ok) api.present(S.frame ? frameKeyOf(S.frame) : null);
};
$('framepick').onchange = () => { const f = S.frames[+$('framepick').value]; if (f) gotoLine(f.bodyStart); };
addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

/* Code text size (View menu, Cmd-+ / Cmd-- / Cmd-0), remembered. */
function codeSize() { return parseFloat(getComputedStyle($('code')).getPropertyValue('--code-size')) || 13; }
function setCodeSize(px) {
  px = Math.max(10, Math.min(24, Math.round(px)));
  $('code').style.setProperty('--code-size', px + 'px');
  try { localStorage.setItem('slidex.codeSize', px); } catch { /* no storage */ }
  if (api && api.setPref) api.setPref('slidex.codeSize', px);
  if (view) view.requestMeasure();
  status(`Code text ${px} pt`);
}
try { const px = +localStorage.getItem('slidex.codeSize'); if (px) $('code').style.setProperty('--code-size', px + 'px'); } catch { /* no storage */ }

/* Edit-menu commands from the app (undo, redo, select all, find). */
window.editorCommand = (name) => {
  if (!view) return;
  if (name === 'undo') CM.undo(view);
  else if (name === 'redo') CM.redo(view);
  else if (name === 'selectAll') view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  else if (name === 'find') { CM.openSearchPanel(view); return; }   // the search field keeps the focus
  else if (name === 'fontBigger') setCodeSize(codeSize() + 1);
  else if (name === 'fontSmaller') setCodeSize(codeSize() - 1);
  else if (name === 'fontReset') setCodeSize(13);
  else if (name.startsWith('theme:')) { setTheme(name.slice(6)); return; }
  else if (name === 'deckSettings') { toggleDeckPanel(); return; }
  view.focus();
};

/* -------------------------------------------------------------- start */
(async function main() {
  if (!api) { document.body.textContent = 'The editor runs inside the SlideX app.'; return; }
  const init = await api.init();
  if (!init || init.error) { document.body.textContent = (init && init.error) || 'No deck.'; return; }
  // settings kept by the app (this page's storage changes with the server's port)
  for (const [k, v] of Object.entries(init.prefs || {})) { try { localStorage.setItem(k, v); } catch { /* no storage */ } }
  applyTheme();
  { const px = +(init.prefs || {})['slidex.codeSize']; if (px) $('code').style.setProperty('--code-size', px + 'px'); }
  { const h = +(init.prefs || {})['slidex.outputHeight']; if (h > 28) $('output').style.height = h + 'px'; }
  S.tex = init.texName;
  S.deckUrl = init.deckUrl;
  S.pageFrames = init.pageFrames || [];
  $('deckname').textContent = init.texName;
  makeEditor(init.text);
  refreshInfo();
  setDirty(false);
  applyFrames(init.frames);
  listenDeck();
  S.version = 0;
  renderStrip();
  // a speaker note typed in the presenter was written to the .tex: make the
  // same change here, so a later save keeps it (and a clean buffer stays clean)
  if (api.onNote) api.onNote(async ({ key, note }) => {
    const c = await api.noteChange(view.state.doc.toString(), key, note);
    if (!c) return;
    const wasDirty = S.dirty;
    view.dispatch({ changes: c });
    if (!wasDirty) setDirty(false);
  });
  api.onShown(() => { if (S.chan) S.chan.postMessage({ type: 'hello' }); });   // back from presenting: follow the deck
  const deckKey = S.pageFrames[init.deckPage];
  const start = S.frames.find((f) => frameKeyOf(f) === deckKey) || S.frames.find((f) => f.label) || S.frames[0];
  if (start) { gotoLine(start.bodyStart); await switchFrame(start, true); }
  else clearPreview('No frames found in this file.');
})();
