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
function makeEditor(text) {
  const theme = CM.EditorView.theme({
    '&': { color: '#d8dbe0', backgroundColor: '#1b1d21' },
    '.cm-content': { caretColor: '#fff' },
    '.cm-gutters': { backgroundColor: '#1b1d21', color: '#5c626b', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,.04)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,.06)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'rgba(61,139,253,.35)' },
    '.cm-cursor': { borderLeftColor: '#fff' },
  }, { dark: true });
  const hl = CM.HighlightStyle.define([
    { tag: CM.tags.comment, color: '#6a737d', fontStyle: 'italic' },
    { tag: [CM.tags.keyword, CM.tags.tagName], color: '#7cb7ff' },
    { tag: CM.tags.atom, color: '#ffab70' },
    { tag: CM.tags.bracket, color: '#9aa4b1' },
    { tag: CM.tags.string, color: '#9ecbff' },
    { tag: CM.tags.number, color: '#79d4a5' },
    { tag: [CM.tags.variableName, CM.tags.typeName], color: '#e2a3ff' },
  ]);
  view = new CM.EditorView({
    parent: $('code'),
    state: CM.EditorState.create({
      doc: text,
      extensions: [
        CM.lineNumbers(), CM.highlightActiveLineGutter(), CM.history(), CM.drawSelection(),
        CM.highlightActiveLine(), CM.bracketMatching(), CM.closeBrackets(), CM.highlightSelectionMatches(),
        CM.StreamLanguage.define(CM.stex), CM.syntaxHighlighting(hl), theme, CM.EditorView.lineWrapping,
        marksField,
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
  status(`Compiling ${f.label || 'frame'}…`);
  const version = S.version;
  try {
    // the cursor may sit between frames: then recompile the frame last shown
    const line = frameAt(cursorLine()) ? cursorLine() : f.start;
    const r = await api.compileFrame(view.state.doc.toString(), line);
    applyFrames(r.frames);
    showErrors(r.errors || []);
    showLog(`Slide ${r.label || ''}`, r.log, r.errors);
    if (r.ok && r.url) {
      S.cache.clear();                           // other frames may depend on what changed
      const nf = S.frames.find((x) => x.label === r.label) || f;
      S.frame = nf;
      view.dispatch({ effects: setFrame.of({ start: nf.start, end: nf.end }) });
      const p = { label: r.label, url: r.url + '?t=' + Date.now(), exact: r.exact,
        page: S.preview && S.preview.label === r.label ? S.preview.page : 1 };
      S.cache.set(r.label, p);
      S.stale = S.version !== version;
      await showPreview(p);
      status(`${r.label} · ${(r.ms / 1000).toFixed(2)} s` + (r.exact ? '' : ' · frame-level'),
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

async function save() {
  const r = await api.save(view.state.doc.toString());
  applyFrames(r.frames);
  setDirty(false);
  status('Saved', 'good');
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
$('preview').addEventListener('click', () => { if (S.hoverLine) gotoLine(S.hoverLine); });

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

/* Edit-menu commands from the app (undo, redo, select all, find). */
window.editorCommand = (name) => {
  if (!view) return;
  if (name === 'undo') CM.undo(view);
  else if (name === 'redo') CM.redo(view);
  else if (name === 'selectAll') view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  else if (name === 'find') CM.openSearchPanel(view);
  view.focus();
};

/* -------------------------------------------------------------- start */
(async function main() {
  if (!api) { document.body.textContent = 'The editor runs inside the SlideX app.'; return; }
  const init = await api.init();
  if (!init || init.error) { document.body.textContent = (init && init.error) || 'No deck.'; return; }
  S.tex = init.texName;
  S.deckUrl = init.deckUrl;
  S.pageFrames = init.pageFrames || [];
  $('deckname').textContent = init.texName;
  makeEditor(init.text);
  setDirty(false);
  applyFrames(init.frames);
  listenDeck();
  S.version = 0;
  renderStrip();
  api.onShown(() => { if (S.chan) S.chan.postMessage({ type: 'hello' }); });   // back from presenting: follow the deck
  const deckKey = S.pageFrames[init.deckPage];
  const start = S.frames.find((f) => frameKeyOf(f) === deckKey) || S.frames.find((f) => f.label) || S.frames[0];
  if (start) { gotoLine(start.bodyStart); await switchFrame(start, true); }
  else clearPreview('No frames found in this file.');
})();
