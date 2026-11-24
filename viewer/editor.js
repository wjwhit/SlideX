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
      const p = { key: r.key, url: r.url + '?t=' + Date.now(), exact: r.exact,
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
  findFigures();
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
    const b = boxes.reduce((a, c) => (c.w * c.h > a.w * a.h ? c : a));
    if (b.w < 4 || b.h < 4) continue;
    figs.push({ kind: 'figure', line: l, box: b });
  }
  S.figs = figs.concat(await findBoxes());
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
async function contentBox(l0, l1) {
  const all = [];
  for (let l = l0; l <= l1; l++) {
    for (const b of (await api.boxesForLine(l)) || []) if (b.page === S.preview.page && b.w > 0 && b.h > 0) all.push(b);
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
    if (u) out.push({ kind: 'tcolorbox', line: l, box: toFrame(u) });
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
  S.figHover = f;
  figEl.hidden = !f;
  if (f) { placeBox(figEl, f.box); figEl.classList.toggle('boxmode', f.kind !== 'figure'); }
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
async function previewHit(e) {
  if (e.target.closest('.text-pop') || e.target.closest('.fig-handle') || !S.preview || S.stale) return null;
  const r = $('pagewrap').getBoundingClientRect();
  const x = (e.clientX - r.left) / pv.scale, y = (e.clientY - r.top) / pv.scale;
  const fig = figAt(x, y);
  if (fig && fig.kind === 'figure') return { fig };
  const hit = await api.lineAt(S.preview.page, x, y);
  if (hit) return { hit };
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
  if (h.hit && h.hit.exact) openTextEdit(h.hit.line);
  else gotoLine(h.fig ? h.fig.line : h.hit.line);
});
$('preview').addEventListener('mousemove', (e) => {
  if (figDrag || !S.figs.length) return;
  const r = $('pagewrap').getBoundingClientRect();
  const f = figAt((e.clientX - r.left) / pv.scale, (e.clientY - r.top) / pv.scale);
  if (f !== S.figHover) drawFigs(f);
});
$('preview').addEventListener('mouseleave', () => { if (!figDrag) drawFigs(null); });

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
  refreshInfo();
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
