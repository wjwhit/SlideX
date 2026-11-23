// SyncTeX reader for the SlideX editor: two-way lookups between a compiled
// PDF and LaTeX source lines, parsed entirely in JS from the `.synctex.gz`
// (or plain `.synctex`) file that `pdflatex -synctex=1` writes. Node
// built-ins only.
//
// API
//   const st = await require('./synctex').load(file, opts)
//       file: path to `x.synctex.gz`, `x.synctex`, or `x.pdf` (the synctex
//             file next to it is used).
//       opts.remap: optional function ({path, line, tag, occurrence}) ->
//             {path, line} | null. Applied to every record key; null drops
//             the record. `occurrence` is the 0-based index of this Input
//             among Inputs with the same path (beamer rewrites `<job>.vrb`
//             for every fragile frame, so one path gets several tags; the
//             n-th fragile frame of the compile is occurrence n). Use it to
//             map `.vrb` lines back to the real source. Can be changed
//             later with st.setRemap(fn) (cheap, no reparse).
//   require('./synctex').parse(text, opts)   same, from the decompressed text
//                                            (opts.dir resolves relative paths)
//
//   st.inputs   [{tag, path, occurrence}]   paths normalized (no "/./")
//   st.pages    number of pages
//   st.pageNodes(page)  raw indexed records of a page (for debugging)
//   st.recordsOnPage(page)  [{path, line, ...}] of every record, after remap
//
//   st.boxesAt(page, x, y)
//       page 1-based; x, y in PDF big points (bp) from the TOP-LEFT of the
//       page (pdf.js viewport at scale 1, y flipped). Returns every record
//       rectangle containing the point, smallest area first:
//       [{path, line, tag, kind, leaf, x, y, w, h}] (same units; x, y =
//       top-left; leaf false = a container whose own line is unreliable).
//       kind: 'run' (tight text run of one line, see below), 'hbox',
//       'void' (void h/v box), 'rule'. Vboxes are not returned (they are
//       page-sized containers).
//   st.lineAt(page, x, y, {preferPath, maxDist})
//       Best single {path, line, tag, kind, x, y, w, h} under the point, or
//       null. Order: text run under the point; nearest text run within
//       maxDist bp (default 4; horizontal gaps count 1/5, so up to 20 bp
//       beside a line); smallest box under the point (graphics, a tikz
//       picture, else frame-level boxes).
//       preferPath: RegExp, function(path) -> bool, or a string (exact path
//       or path suffix). Default: anything not inside a TeX distribution
//       (path without "/texmf"). Preferred records win over the rest.
//   st.boxesForLine(path, line, page?, {tag, occurrence, lookahead}?)
//       Rectangles on the page(s) produced by that source line, merged per
//       page where they touch on the same text line: [{page, x, y, w, h}],
//       bp from the top-left. path is matched after remap, exactly, then by
//       realpath, then by basename when the query has no directory.
//       tag / occurrence restrict to one Input (one .vrb instance).
//       lookahead n (default 0): a line with no records at all uses the
//       next line's records, up to n lines down (what `synctex view` does;
//       e.g. \begin{tikzpicture} then shows the picture).
//
// Coordinates. Records hold TeX scaled points (sp) measured from the page's
// top-left corner (the 1in TeX origin is already included). With the
// preamble values Unit u, Magnification m, X/Y Offset ox, oy:
//     bp = sp * u * (m / 1000) / 65781.76 + offset * u / 65781.76
// (65781.76 sp per bp). A box record `(tag,line:h,v:W,H,D` has its reference
// point (h, v) on the baseline at the left; it covers h..h+W horizontally
// (W can be negative: then h+W..h) and v-H..v+D vertically. So our rect is
// {x: h, y: v - H, w: W, h: H + D}. The `synctex view` CLI reports the
// same box as h, v = v + D (bottom), W, H = H + D.
//
// Why "runs". Box records carry the line that was being read when the box
// was finished, which for a paragraph line is usually the NEXT source line
// (the line box of "\item Alpha" is tagged with the line of "\item Beta").
// The precise attribution sits in the point records inside the hbox:
// `x` (characters), `$` (math on/off), `g` (glue), `k` (kern, with width),
// plus child boxes. pdftex writes each point at the current position AFTER
// the node (checked against word widths and kern widths), so a point
// covers [previous sibling's end, its own h]. For every hbox we walk its
// children in order, give each an interval this way, group consecutive
// children with the same (tag, line) into runs, trim glue/kern items at
// both ends of a run (they are white space, e.g. the \parfillskip at the
// end of a line, which is tagged with the next line), and drop runs with
// no characters (math counts when it holds a box; boxes alone are
// reported as boxes). Vbox children (beamer columns sit in $...$ around a
// vbox, minipages) split runs and never join one. A run's rect
// spans its interval horizontally and the enclosing hbox's height and
// depth vertically. This gives a tight highlight for one source line
// inside a multi-line paragraph.
// Character keys are corrected. Glyphs carry no SyncTeX data, so pdftex
// writes an `x` with the key of the last node that had one: the glue
// before the word, or the enclosing line box for the first word of a
// display line. That puts the first word of each source line on the
// previous source line, and the first word of a display line on whatever
// line the box got (for example the frame's \end{frame} line in the main
// file, or the next \item). The glue, kern, math or box node FOLLOWING a
// word was made right after it was read (interword spaces can also be written
// as kerns), so an `x` takes the key of the next non-`x` record; the last
// word of an hbox keeps its own key (the glue after it is line-end fill).
//
// Boxes. A box is a "leaf" when no descendant carries a different
// (tag, line); its rect then belongs to its line (graphics, a short
// \mbox). Records nested inside a leaf hbox are dropped: graphicx scales
// with a PDF matrix, so the inner boxes of \includegraphics carry the
// unscaled image size and would sit in the wrong place. Boxes with mixed
// content are "containers": boxesAt still returns them (leaf: false), and
// lineAt ranks them last; boxesForLine falls back to
// them only for a line that has no runs or leaves on that page and is the
// highest line inside the box (an \end{tikzpicture} or \end{itemize}).
// Last resort for a line with no sized record at all (a tikz \draw, which
// only leaves glue and empty boxes): the innermost sized hbox enclosing
// its records, e.g. the whole tikz picture.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

const SP_PER_BP = 65781.76;
const RECORD = /^.(-?\d+),(-?\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/;
const MERGE_GAP = 2.5;      // bp: horizontal gap bridged when merging rects
const FALLBACK_H = 7, FALLBACK_D = 2;   // bp: run height when hbox has none

function defaultPrefer(p) { return !/[\\/]texmf/.test(p); }

function makePrefer(pref) {
  if (pref == null) return defaultPrefer;
  if (pref instanceof RegExp) return (p) => pref.test(p);
  if (typeof pref === 'function') return pref;
  const s = String(pref);
  return (p) => p === s || p.endsWith('/' + s) || p.endsWith(s);
}

function contains(r, x, y) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

// Distance from a point to a rect; horizontal gaps count 1/5, so a point in
// the margin beside a text line still finds that line (as `synctex edit`).
function dist(r, x, y) {
  const dx = x < r.x ? r.x - x : x > r.x + r.w ? x - r.x - r.w : 0;
  const dy = y < r.y ? r.y - y : y > r.y + r.h ? y - r.y - r.h : 0;
  return Math.hypot(0.2 * dx, dy);
}

/* Merge rects on one page: drop rects inside others, then join rects that
   share a text line (vertical overlap at least half the smaller height) and
   touch horizontally (gap <= MERGE_GAP). Repeats until stable. */
function mergeRects(rects) {
  let list = rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
  let changed = true;
  while (changed && list.length > 1) {
    changed = false;
    list.sort((a, b) => a.y - b.y || a.x - b.x);
    const out = [];
    for (const r of list) {
      let merged = false;
      for (const o of out) {
        const vy = Math.min(o.y + o.h, r.y + r.h) - Math.max(o.y, r.y);
        const hgap = Math.max(o.x, r.x) - Math.min(o.x + o.w, r.x + r.w);
        const inside = (a, b) => a.x >= b.x - 0.01 && a.y >= b.y - 0.01 &&
          a.x + a.w <= b.x + b.w + 0.01 && a.y + a.h <= b.y + b.h + 0.01;
        if (inside(r, o) || inside(o, r) ||
            (vy >= 0.5 * Math.min(o.h, r.h) && hgap <= MERGE_GAP)) {
          const x0 = Math.min(o.x, r.x), y0 = Math.min(o.y, r.y);
          const x1 = Math.max(o.x + o.w, r.x + r.w), y1 = Math.max(o.y + o.h, r.y + r.h);
          o.x = x0; o.y = y0; o.w = x1 - x0; o.h = y1 - y0;
          merged = true; changed = true;
          break;
        }
      }
      if (!merged) out.push(r);
    }
    list = out;
  }
  return list;
}

function parse(text, opts = {}) {
  const dir = opts.dir || process.cwd();
  const inputs = [];            // {tag, path, occurrence}
  const tagPath = new Map();    // tag -> path
  const pathCount = new Map();
  let unit = 1, mag = 1000, xoff = 0, yoff = 0;
  let inContent = false;
  const pages = [];             // index page-1 -> {nodes}
  let page = null;
  let k = 0;                    // conversion factor sp -> bp (set at Content)
  let ox = 0, oy = 0;

  // Open-box stack entries.
  // {kind, tag, line, h, v, W, H, D, foreign, maxLine, children: [] (hbox only)}
  const stack = [];

  function addInput(rest) {
    const c = rest.indexOf(':');
    const tag = parseInt(rest.slice(0, c), 10);
    let p = rest.slice(c + 1);
    if (!path.isAbsolute(p)) p = path.resolve(dir, p);
    p = path.normalize(p);
    const occ = pathCount.get(p) || 0;
    pathCount.set(p, occ + 1);
    inputs.push({ tag, path: p, occurrence: occ });
    tagPath.set(tag, p);
  }

  function rectOf(h, v, W, H, D) {
    const x0 = Math.min(h, h + W), x1 = Math.max(h, h + W);
    return { x: x0 * k + ox, y: (v - H) * k + oy, w: (x1 - x0) * k, h: (H + D) * k };
  }

  // Record a child key in the parent box for leaf/container bookkeeping.
  function noteChild(parent, tag, line, foreign, maxTagLine) {
    if (!parent) return;
    if (foreign || tag !== parent.tag || line !== parent.line) parent.foreign = true;
    if (tag === parent.tag) {
      const m = Math.max(line, maxTagLine);
      if (m > parent.maxLine) parent.maxLine = m;
    }
  }

  // A record with no extent (glue, kern, a zero-size box) registers its key
  // with the nearest enclosing hbox that has an area, so a line that only
  // draws (a tikz \draw) can still be shown as the box it lands in.
  function touch(tag, line) {
    for (let i = stack.length - 1; i >= 0; i--) {
      const b = stack[i];
      if (b.kind !== 'hbox' || b.W === 0 || b.H + b.D <= 0) continue;
      if (b.tag === tag && b.line === line) return;
      (b.touch || (b.touch = new Set())).add(tag * 4194304 + line);
      return;
    }
  }

  function markInner(list) {
    for (const n of list) { n.inner = true; if (n.kids) { markInner(n.kids); n.kids = null; } }
  }

  // Build text runs from an hbox's children (see header comment).
  function buildRuns(box) {
    const ch = box.children;
    if (!ch || !ch.length) return;
    // intervals, in sp
    let prev = box.h;
    for (const c of ch) {
      if (c.box) { c.a = Math.min(c.h, c.h + c.W); c.b = Math.max(c.h, c.h + c.W); prev = c.h + c.W; }
      else { c.a = Math.min(prev, c.h); c.b = Math.max(prev, c.h); prev = c.h; }
    }
    // Re-key characters: an `x` carries the key of the node before it (see
    // header); use the next node's key instead.
    // Glue and kerns after the last content of the hbox are line-end fill
    // (\parfillskip, \rightskip), tagged with whatever line ended the
    // paragraph, so they are not used.
    let next = null, seenContent = false;
    for (let i = ch.length - 1; i >= 0; i--) {
      const c = ch[i];
      if (c.t === 'x') { seenContent = true; if (next) { c.rtag = next.tag; c.rline = next.line; } }
      else if (c.box || c.t === '$') { seenContent = true; next = c; }
      else if (seenContent) next = c;    // g, k between words
    }
    const H = box.H || 0, D = box.D || 0;
    const noHeight = H + D <= 0;
    let i = 0;
    while (i < ch.length) {
      if (ch[i].t === 'vbox') { i++; continue; }   // columns, minipages: own records
      const tag = ch[i].rtag ?? ch[i].tag, line = ch[i].rline ?? ch[i].line;
      let j = i;
      while (j + 1 < ch.length && ch[j + 1].t !== 'vbox' && (ch[j + 1].rtag ?? ch[j + 1].tag) === tag &&
             (ch[j + 1].rline ?? ch[j + 1].line) === line) j++;
      // trim white space (glue/kern) at both ends
      let s = i, e = j;
      while (s <= e && (ch[s].t === 'g' || ch[s].t === 'k')) s++;
      while (e >= s && (ch[e].t === 'g' || ch[e].t === 'k')) e--;
      // a run needs characters, or math with something in it
      let text = false, math = false, boxes = false;
      for (let q = s; q <= e; q++) {
        const t = ch[q].t;
        if (t === 'x') { text = true; break; }
        if (t === '$') math = true; else if (ch[q].box) boxes = true;
      }
      text = text || (math && boxes);
      if (text) {
        let a = Infinity, b = -Infinity;
        for (let q = s; q <= e; q++) { if (ch[q].a < a) a = ch[q].a; if (ch[q].b > b) b = ch[q].b; }
        if (b - a > 0) {
          const y = noHeight ? (box.v * k + oy) - FALLBACK_H : (box.v - H) * k + oy;
          const hh = noHeight ? FALLBACK_H + FALLBACK_D : (H + D) * k;
          const node = { kind: 'run', tag, line, leaf: true, maxLine: line,
            x: a * k + ox, y, w: (b - a) * k, h: hh };
          page.nodes.push(node);
          box.nodes.push(node);
        }
      }
      i = j + 1;
    }
  }

  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const s = lines[li];
    if (!s) continue;
    if (!inContent) {
      if (s.startsWith('Input:')) addInput(s.slice(6));
      else if (s.startsWith('Unit:')) unit = parseFloat(s.slice(5)) || 1;
      else if (s.startsWith('Magnification:')) mag = parseFloat(s.slice(14)) || 1000;
      else if (s.startsWith('X Offset:')) xoff = parseFloat(s.slice(9)) || 0;
      else if (s.startsWith('Y Offset:')) yoff = parseFloat(s.slice(9)) || 0;
      else if (s.startsWith('Content:')) {
        inContent = true;
        k = unit * (mag / 1000) / SP_PER_BP;
        ox = xoff * unit / SP_PER_BP; oy = yoff * unit / SP_PER_BP;
      }
      continue;
    }
    const c = s.charCodeAt(0);
    switch (c) {
      case 123: { // { page start
        const n = parseInt(s.slice(1), 10);
        page = { nodes: [] };
        pages[n - 1] = page;
        stack.length = 0;
        break;
      }
      case 125: // } page end
        page = null; stack.length = 0;
        break;
      case 40: case 91: { // ( hbox, [ vbox
        const m = RECORD.exec(s);
        if (!m || !page) break;
        const b = { kind: c === 40 ? 'hbox' : 'vbox', tag: +m[1], line: +m[2],
          h: +m[3], v: +m[4], W: +(m[5] || 0), H: +(m[6] || 0), D: +(m[7] || 0),
          foreign: false, maxLine: +m[2], children: c === 40 ? [] : null, nodes: [] };
        const parent = stack[stack.length - 1];
        if (parent && parent.children) parent.children.push({ box: true, t: b.kind, tag: b.tag, line: b.line, h: b.h, W: b.W });
        if (b.W === 0 || b.H + b.D <= 0) touch(b.tag, b.line);
        stack.push(b);
        break;
      }
      case 41: case 93: { // ) ] close
        const b = stack.pop();
        if (!b || !page) break;
        const r = rectOf(b.h, b.v, b.W, b.H, b.D);
        const node = { kind: b.kind, tag: b.tag, line: b.line, leaf: !b.foreign,
          maxLine: b.maxLine, x: r.x, y: r.y, w: r.w, h: r.h };
        if (b.touch) node.touch = [...b.touch];
        page.nodes.push(node);
        if (b.kind === 'hbox') buildRuns(b);
        // Inside a leaf everything has the leaf's key; inner boxes can carry
        // untransformed sizes (graphicx scaling), so only the outer one counts.
        node.kids = b.nodes;
        if (!b.foreign && b.kind === 'hbox' && node.w > 0.01 && node.h > 0.01) markInner(b.nodes);
        const parent = stack[stack.length - 1];
        if (parent) parent.nodes.push(node);
        noteChild(parent, b.tag, b.line, b.foreign, b.maxLine);
        break;
      }
      case 104: case 118: case 114: { // h void hbox, v void vbox, r rule
        const m = RECORD.exec(s);
        if (!m || !page) break;
        const tag = +m[1], line = +m[2], h = +m[3], v = +m[4];
        const W = +(m[5] || 0), H = +(m[6] || 0), D = +(m[7] || 0);
        const r = rectOf(h, v, W, H, D);
        const node = { kind: c === 114 ? 'rule' : 'void', tag, line, leaf: true,
          maxLine: line, x: r.x, y: r.y, w: r.w, h: r.h };
        page.nodes.push(node);
        const parent = stack[stack.length - 1];
        if (parent) parent.nodes.push(node);
        if (parent && parent.children) parent.children.push({ box: true, t: 'void', tag, line, h, W });
        if (W === 0 || H + D <= 0) touch(tag, line);
        noteChild(parent, tag, line, false, line);
        break;
      }
      case 120: case 107: case 103: case 36: { // x current, k kern, g glue, $ math
        const m = RECORD.exec(s);
        if (!m || !page) break;
        const tag = +m[1], line = +m[2];
        const parent = stack[stack.length - 1];
        if (parent && parent.children) parent.children.push({ box: false, t: s[0], tag, line, h: +m[3] });
        touch(tag, line);
        noteChild(parent, tag, line, false, line);
        break;
      }
      case 73: // Input: inside content
        if (s.startsWith('Input:')) addInput(s.slice(6));
        break;
      case 80: // Postamble
        if (s.startsWith('Postamble')) li = lines.length;
        break;
      default: break; // '!' byte counts, forms, anything unknown
    }
  }
  for (let i = 0; i < pages.length; i++) if (!pages[i]) pages[i] = { nodes: [] };
  // drop degenerate rects once (keeps lookups cheap)
  for (const p of pages) p.nodes = p.nodes.filter((n) => !n.inner && n.w > 0.01 && n.h > 0.01);
  return new SyncTeX(inputs, tagPath, pages, opts.remap);
}

class SyncTeX {
  constructor(inputs, tagPath, pages, remap) {
    this.inputs = inputs;
    this._tagPath = tagPath;
    this._tagOcc = new Map(inputs.map((i) => [i.tag, i.occurrence]));
    this._pages = pages;
    this.pages = pages.length;
    this.setRemap(remap);
  }

  setRemap(fn) {
    this._remap = typeof fn === 'function' ? fn : null;
    this._keyCache = new Map();
    this._lineIndex = null;
  }

  // (tag, line) -> {path, line} after remap (null when dropped)
  _key(tag, line) {
    const ck = tag * 4194304 + line;
    let v = this._keyCache.get(ck);
    if (v !== undefined) return v;
    const p = this._tagPath.get(tag) || '';
    v = { path: p, line };
    if (this._remap) {
      const r = this._remap({ path: p, line, tag, occurrence: this._tagOcc.get(tag) || 0 });
      v = r ? { path: r.path != null ? path.normalize(r.path) : p, line: r.line != null ? r.line : line } : null;
    }
    this._keyCache.set(ck, v);
    return v;
  }

  _out(n) {
    const kk = this._key(n.tag, n.line);
    if (!kk) return null;
    return { path: kk.path, line: kk.line, tag: n.tag, kind: n.kind,
      x: n.x, y: n.y, w: n.w, h: n.h };
  }

  pageNodes(page) { return (this._pages[page - 1] || { nodes: [] }).nodes; }

  /* Every record of a page as {path, line} after remap (for page -> source
   * line summaries, e.g. which frame a page came from). */
  recordsOnPage(page) {
    const out = [];
    for (const n of this.pageNodes(page)) { const o = this._out(n); if (o) out.push(o); }
    return out;
  }

  boxesAt(page, x, y) {
    const out = [];
    for (const n of this.pageNodes(page)) {
      if (n.kind === 'vbox' || !contains(n, x, y)) continue;
      const o = this._out(n);
      if (o) { o.leaf = n.leaf; out.push(o); }
    }
    out.sort((a, b) => a.w * a.h - b.w * b.h);
    return out;
  }

  lineAt(page, x, y, opts = {}) {
    const prefer = makePrefer(opts.preferPath);
    const maxDist = opts.maxDist != null ? opts.maxDist : 4;
    const hits = this.boxesAt(page, x, y);            // smallest first
    const pick = (f) => hits.find(f) || null;
    return pick((r) => r.kind === 'run' && prefer(r.path)) ||   // text run under the point
      this._nearest(page, x, y, maxDist, prefer) ||     // text run close by
      pick((r) => prefer(r.path)) ||                    // smallest preferred box
      pick((r) => r.leaf) || hits[0] || null;           // anything
  }

  _nearest(page, x, y, maxDist, prefer) {
    let best = null, bd = Infinity;
    for (const n of this.pageNodes(page)) {
      if (n.kind !== 'run') continue;
      const d = dist(n, x, y);
      if (d > maxDist || d >= bd) continue;
      const o = this._out(n);
      if (!o || !prefer(o.path)) continue;
      best = o; bd = d;
    }
    return best;
  }

  _buildLineIndex() {
    const idx = new Map();   // "path\nline" -> [{page, n}]
    const tidx = new Map();  // same, for boxes the line only touches
    this._pages.forEach((p, pi) => {
      for (const n of p.nodes) {
        if (n.kind === 'vbox') continue;
        if (n.touch) {
          for (const ck of n.touch) {
            const kk = this._key(Math.floor(ck / 4194304), ck % 4194304);
            if (!kk) continue;
            const key = kk.path + '\n' + kk.line;
            let arr = tidx.get(key);
            if (!arr) tidx.set(key, (arr = []));
            arr.push({ page: pi + 1, n, touch: true });
          }
        }
        const kk = this._key(n.tag, n.line);
        if (!kk) continue;
        const key = kk.path + '\n' + kk.line;
        let arr = idx.get(key);
        if (!arr) idx.set(key, (arr = []));
        arr.push({ page: pi + 1, n });
      }
    });
    this._lineIndex = idx;
    this._touchIndex = tidx;
    this._paths = new Set();
    for (const key of idx.keys()) this._paths.add(key.slice(0, key.lastIndexOf('\n')));
    this._realCache = new Map();
  }

  _resolvePath(p) {
    if (this._paths.has(p)) return p;
    const np = path.normalize(p);
    if (this._paths.has(np)) return np;
    if (this._realCache.has(p)) return this._realCache.get(p);
    let found = null;
    const real = (q) => { try { return fs.realpathSync(q); } catch (e) { return q; } };
    const rp = real(np);
    for (const q of this._paths) if (real(q) === rp) { found = q; break; }
    if (!found && !p.includes('/')) {
      for (const q of this._paths) if (path.basename(q) === p) { found = q; break; }
    }
    this._realCache.set(p, found);
    return found;
  }

  boxesForLine(p, line, page, opts = {}) {
    if (!this._lineIndex) this._buildLineIndex();
    const rp = this._resolvePath(p);
    if (!rp) return [];
    const key = rp + '\n' + line;
    const list = (this._lineIndex.get(key) || []).concat(this._touchIndex.get(key) || []);
    if (!list.length && opts.lookahead > 0) {
      // like `synctex view`: a line without records takes the next line's
      return this.boxesForLine(p, line + 1, page, Object.assign({}, opts, { lookahead: opts.lookahead - 1 }));
    }
    const byPage = new Map();
    for (const { page: pg, n, touch } of list) {
      if (page && pg !== page) continue;
      if (opts.tag != null && n.tag !== opts.tag) continue;
      if (opts.occurrence != null && this._tagOcc.get(n.tag) !== opts.occurrence) continue;
      let e = byPage.get(pg);
      if (!e) byPage.set(pg, (e = { leaves: [], containers: [], touched: [] }));
      (touch ? e.touched : n.leaf ? e.leaves : e.containers).push(n);
    }
    const holds = (a, b) => a !== b && b.x >= a.x - 0.01 && b.y >= a.y - 0.01 &&
      b.x + b.w <= a.x + a.w + 0.01 && b.y + b.h <= a.y + a.h + 0.01;
    const innermost = (cand) => cand.filter((a) => !cand.some((b) => holds(a, b)));
    const out = [];
    for (const pg of [...byPage.keys()].sort((a, b) => a - b)) {
      const e = byPage.get(pg);
      let rects = e.leaves;
      // fallback 1: innermost containers that close at this line
      if (!rects.length) rects = innermost(e.containers.filter((n) => n.maxLine <= n.line));
      // fallback 2: innermost boxes the line only touches (glue, empty boxes)
      if (!rects.length) rects = innermost(e.touched);
      for (const r of mergeRects(rects)) out.push({ page: pg, x: r.x, y: r.y, w: r.w, h: r.h });
    }
    return out;
  }
}

async function load(file, opts = {}) {
  let f = file;
  if (/\.pdf$/i.test(f)) {
    const base = f.slice(0, -4);
    f = fs.existsSync(base + '.synctex.gz') ? base + '.synctex.gz' : base + '.synctex';
  }
  let buf = await fs.promises.readFile(f);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = await promisify(zlib.gunzip)(buf);
  return parse(buf.toString('utf8'), Object.assign({ dir: path.dirname(path.resolve(f)) }, opts));
}

module.exports = { load, parse, mergeRects };
