// Deck settings: what the panel in the editor shows (title page, themes,
// colours, header and footer), read from the deck's preamble, its \input
// files and the .sty files beside it. Edits are made by the editor in the
// main .tex only (app/deck.js computes them, viewer/editor.js applies them),
// so they can be undone like any other edit.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const nc = (t) => t.replace(/(^|[^\\])%[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));   // comments blanked, same length

function matchBrace(text, i) {
  let d = 0;
  for (let k = i; k < text.length; k++) {
    const c = text[k];
    if (c === '\\') { k++; continue; }
    if (c === '{') d++;
    else if (c === '}' && --d === 0) return k;
  }
  return -1;
}
function matchBracket(text, i) {
  let d = 0;
  for (let k = i; k < text.length; k++) {
    const c = text[k];
    if (c === '\\') { k++; continue; }
    if (c === '{') d++;
    else if (c === '}') d--;
    else if (c === ']' && d === 0) return k;
  }
  return -1;
}

/* \cmd[opt]{arg}...: the first call in text (comments ignored), as
 * {from, to, opt, args:[...]} with character offsets, or null. */
function findCommand(text, name, nargs = 1, from = 0, to = text.length) {
  const c = nc(text);
  const re = new RegExp(String.raw`\\${name}(?![A-Za-z@])`, 'g');
  re.lastIndex = from;
  let m;
  while ((m = re.exec(c)) && m.index < to) {
    let p = m.index + m[0].length;
    const ws = () => { while (/\s/.test(c[p] || '') && c[p] !== '\n') p++; };
    ws();
    let opt = null;
    if (c[p] === '[') { const q = matchBracket(c, p + 1); if (q < 0) continue; opt = text.slice(p + 1, q); p = q + 1; ws(); }
    const args = [];
    for (let k = 0; k < nargs; k++) {
      while (/\s/.test(c[p] || '')) p++;
      if (c[p] !== '{') break;
      const q = matchBrace(c, p);
      if (q < 0) break;
      args.push(text.slice(p + 1, q));
      p = q + 1;
    }
    if (args.length === nargs) return { from: m.index, to: p, opt, args };
  }
  return null;
}
function findAll(text, name, nargs, from = 0, to = text.length) {
  const out = [];
  let r, at = from;
  while ((r = findCommand(text, name, nargs, at, to))) { out.push(r); at = r.to; }
  return out;
}

/* ---- package options: \usepackage[key=value,...]{pkg} in the main file */
function pkgOptions(text, pkg) {
  const pre = nc(text).slice(0, preambleEnd(text));
  const re = new RegExp(String.raw`\\usepackage\s*\[`, 'g');
  let m;
  while ((m = re.exec(pre))) {
    const open = m.index + m[0].length - 1, close = matchBracket(text, open + 1);
    if (close < 0) continue;
    const nm = /^\s*\{([^}]*)\}/.exec(text.slice(close + 1));
    if (!nm || !nm[1].split(',').map((x) => x.trim()).includes(pkg)) continue;
    // split at top-level commas, with offsets
    const out = [];
    let start = open + 1, depth = 0;
    const push = (end) => {
      const raw = text.slice(start, end);
      const kv = /^(\s*)([A-Za-z@-]+)(\s*=\s*)([\s\S]*?)(\s*)$/.exec(raw);
      if (kv) out.push({ key: kv[2], raw: kv[4], from: start + kv[1].length + kv[2].length + kv[3].length, to: start + kv[1].length + kv[2].length + kv[3].length + kv[4].length });
    };
    for (let k = open + 1; k < close; k++) {
      const c = text[k];
      if (c === '\\') { k++; continue; }
      if (c === '{') depth++; else if (c === '}') depth--;
      else if (c === ',' && depth === 0) { push(k); start = k + 1; }
    }
    push(close);
    return { opts: out, open, close };
  }
  return null;
}
const unbrace = (v) => { v = v.trim(); return v.startsWith('{') && matchBrace(v, 0) === v.length - 1 ? v.slice(1, -1) : v; };
/* A value like \textbf{\mypkg@title}: the package option it comes from. */
function viaOption(text, expr) {
  const m = /\\([A-Za-z]+)@([A-Za-z]+)/.exec(expr || '');
  if (!m) return null;
  const po = pkgOptions(text, m[1]);
  const o = po && po.opts.find((x) => x.key === m[2]);
  return po ? { pkg: m[1], key: m[2], value: o ? unbrace(o.raw) : null } : null;
}
function setPkgOption(text, pkg, key, value) {
  const po = pkgOptions(text, pkg);
  if (!po) return text;
  const o = po.opts.find((x) => x.key === key);
  const v = value == null ? '' : /[,=\]\[{}]|^\s|\s$/.test(value) || o && o.raw.trim().startsWith('{') ? `{${value}}` : value;
  if (o) return text.slice(0, o.from) + v + text.slice(o.to);
  // add it as the last option
  const before = text.slice(0, po.close).replace(/[\s,]*$/, '');
  const ws = /\n/.test(text.slice(po.open, po.close)) ? ',\n' : ', ';
  return before + ws + `${key}=${v}` + (ws === ',\n' ? ',\n' : '') + text.slice(po.close);
}

/* ---- colours */
const BASE = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '00FF00', blue: '0000FF', cyan: '00FFFF',
  magenta: 'FF00FF', yellow: 'FFFF00', gray: '808080', darkgray: '404040', lightgray: 'BFBFBF', orange: 'FF8000',
  brown: 'BF8040', lime: 'BFFF00', olive: '808000', pink: 'FFBFBF', purple: 'BF0040', teal: '008080', violet: '800080' };
const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0').toUpperCase();
function modelToHex(model, spec) {
  const n = spec.split(/[\s,]+/).filter(Boolean).map(Number);
  switch (model) {
    case 'HTML': return /^[0-9A-Fa-f]{6}$/.test(spec.trim()) ? spec.trim().toUpperCase() : null;
    case 'RGB': return n.length === 3 ? n.map(hex2).join('') : null;
    case 'rgb': return n.length === 3 ? n.map((v) => hex2(v * 255)).join('') : null;
    case 'gray': return n.length === 1 ? hex2(n[0] * 255).repeat(3) : null;
    case 'cmyk': return n.length === 4 ? [0, 1, 2].map((i) => hex2(255 * (1 - n[i]) * (1 - n[3]))).join('') : null;
    case 'cmy': return n.length === 3 ? n.map((v) => hex2(255 * (1 - v))).join('') : null;
    default: return null;
  }
}
/* An xcolor expression (name, name!p, a!p!b, ...) to hex, from known colours. */
function exprToHex(expr, known) {
  const parts = expr.trim().replace(/^-/, '').split('!');
  const get = (nm) => known[nm.trim()] || BASE[nm.trim()] || null;
  let cur = get(parts[0]);
  if (!cur) return null;
  for (let i = 1; i < parts.length; i += 2) {
    const p = parseFloat(parts[i]) / 100;
    const other = i + 1 < parts.length ? get(parts[i + 1]) : 'FFFFFF';
    if (!(p >= 0) || !other) return null;
    const a = [0, 2, 4].map((k) => parseInt(cur.slice(k, k + 2), 16)), b = [0, 2, 4].map((k) => parseInt(other.slice(k, k + 2), 16));
    cur = a.map((v, k) => hex2(v * p + b[k] * (1 - p))).join('');
  }
  return cur;
}

/* The deck's sources in load order: the main file (preamble), its \input
 * files and the .sty files beside it that it loads. */
function sources(texPath, text) {
  const dir = path.dirname(texPath);
  const pre = text.slice(0, Math.max(0, nc(text).indexOf('\\begin{document}')) || text.length);
  const out = [{ file: path.basename(texPath), text: pre, main: true }];
  for (const m of nc(pre).matchAll(/\\(?:input|include)\{([^}]+)\}/g)) {
    const f = m[1].endsWith('.tex') ? m[1] : m[1] + '.tex';
    try { out.push({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }); } catch { /* missing */ }
  }
  for (const m of nc(pre).matchAll(/\\(?:usepackage|RequirePackage|usetheme|usecolortheme|usefonttheme|useinnertheme|useoutertheme)(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
    const th = /\\use(\w*)theme/.exec(m[0]);                 // \usecolortheme{x} -> beamercolorthemex.sty
    for (const name of m[1].split(',').map((s) => s.trim())) {
      const f = th ? `beamer${th[1]}theme${name}.sty` : `${name}.sty`;
      try { out.push({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }); } catch { /* not local */ }
    }
  }
  return out;
}

/* Themes installed in TeX (from the ls-R database) and beside the deck. */
let themeCache = null;
function installedThemes(dir) {
  if (!themeCache) {
    themeCache = { theme: new Set(), color: new Set(), font: new Set() };
    try {
      const root = execFileSync('kpsewhich', ['-var-value', 'TEXMFDIST'], { encoding: 'utf8', env: process.env }).trim();
      const lsr = fs.readFileSync(path.join(root, 'ls-R'), 'utf8');
      for (const m of lsr.matchAll(/^beamer(color|font|)theme([A-Za-z0-9-]+)\.sty$/gm)) themeCache[m[1] || 'theme'].add(m[2]);
    } catch { /* no TeX: lists stay short */ }
    for (const t of ['default', 'Madrid', 'Warsaw', 'Berlin', 'CambridgeUS', 'Boadilla']) themeCache.theme.add(t);
  }
  const local = { theme: [], color: [], font: [] };
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = /^beamer(color|font|)theme([A-Za-z0-9-]+)\.sty$/.exec(f);
      if (m) local[m[1] || 'theme'].push(m[2]);
    }
  } catch { /* unreadable */ }
  const list = (k) => [...new Set([...local[k], ...themeCache[k]])].filter((n) => /^[A-Za-z]/.test(n)).sort((a, b) => a.localeCompare(b));
  return { theme: list('theme'), color: list('color'), font: list('font') };
}

const SLOTS = [
  { slot: 'structure', label: 'Structure (bullets, links)', keys: ['fg'] },
  { slot: 'frametitle', label: 'Frame title', keys: ['fg', 'bg'] },
  { slot: 'title', label: 'Title', keys: ['fg', 'bg'] },
  { slot: 'normal text', label: 'Text', keys: ['fg', 'bg'] },
  { slot: 'alerted text', label: 'Alerted text', keys: ['fg'] },
  { slot: 'block title', label: 'Block title', keys: ['fg', 'bg'] },
  { slot: 'footline', label: 'Footline', keys: ['fg', 'bg'] },
];
const FIELDS = ['title', 'subtitle', 'author', 'institute', 'date'];

/* ---- page size: beamer's aspectratio, unless something sets the paper itself
 * (a style's \geometry{paperwidth=...}, often fed by its own options) */
const RATIO_MM = { 169: [160, 90], 1610: [160, 100], 149: [140, 90], 43: [128, 96], 54: [125, 100], 32: [135, 90] };
const LEN_PT = { pt: 1, bp: 72.27 / 72, mm: 72.27 / 25.4, cm: 72.27 / 2.54, in: 72.27 };
const lenPt = (v) => { const m = /^\s*([0-9]*\.?[0-9]+)\s*(pt|bp|mm|cm|in)\s*$/.exec(v || ''); return m ? { n: parseFloat(m[1]), unit: m[2], pt: parseFloat(m[1]) * LEN_PT[m[2]] } : null; };
function geometryKeys(body) {
  const out = {};
  for (const kv of body.split(',')) { const m = /^\s*(paperwidth|paperheight|papersize)\s*=\s*(.+?)\s*$/.exec(kv); if (m) out[m[1]] = m[2]; }
  if (out.papersize) { const p = /^\{?\s*([^,}]+?)\s*,\s*([^,}]+?)\s*\}?$/.exec(out.papersize); if (p) { out.paperwidth = p[1]; out.paperheight = p[2]; } }
  return out;
}
/* {w, h} as lengths, and where they are set: {via: {pkg, wkey, hkey}} or {main: true} */
function paperInfo(texPath, text) {
  let found = null;
  for (const s of sources(texPath, text)) {
    for (const g of findAll(s.text, 'geometry', 1)) {
      const k = geometryKeys(g.args[0]);
      if (!k.paperwidth || !k.paperheight) continue;
      const rec = { file: s.file, main: !!s.main, w: k.paperwidth, h: k.paperheight };
      const vw = /\\([A-Za-z]+)@([A-Za-z]+)/.exec(k.paperwidth), vh = /\\([A-Za-z]+)@([A-Za-z]+)/.exec(k.paperheight);
      if (vw && vh && vw[1] === vh[1]) {
        const po = pkgOptions(text, vw[1]);
        const ow = po && po.opts.find((o) => o.key === vw[2]), oh = po && po.opts.find((o) => o.key === vh[2]);
        rec.via = { pkg: vw[1], wkey: vw[2], hkey: vh[2] };
        if (ow) rec.w = unbrace(ow.raw);
        if (oh) rec.h = unbrace(oh.raw);
        if (!ow || !oh) rec.defaults = true;        // the style's own defaults: shown, set as options when changed
      }
      found = rec;                                  // the last one wins
    }
  }
  return found;
}
function ratioOf(w, h) {
  const W = lenPt(w), H = lenPt(h);
  if (!W || !H) return null;
  const r = W.pt / H.pt;
  for (const [k, [a, b]] of Object.entries(RATIO_MM)) if (Math.abs(r - a / b) / (a / b) < 0.01) return k;
  return 'custom';
}

/* What the panel shows. */
function info(texPath, text) {
  const src = sources(texPath, text);
  const main = src[0];
  const known = {}, colors = [];
  for (const s of src) {
    for (const d of findAll(s.text, 'definecolor', 3)) {
      const hex = modelToHex(d.args[1].trim(), d.args[2]);
      if (!hex) continue;
      known[d.args[0].trim()] = hex;
      const prev = colors.findIndex((c) => c.name === d.args[0].trim());
      const rec = { name: d.args[0].trim(), hex, file: s.file, main: !!s.main };
      if (prev >= 0) colors[prev] = rec; else colors.push(rec);
    }
  }
  const slots = SLOTS.map((sl) => {
    const out = { ...sl, values: {} };
    for (const s of src) {
      for (const c of findAll(s.text, 'setbeamercolor', 2)) {
        if (c.args[0].trim() !== sl.slot) continue;
        for (const kv of c.args[1].split(',')) {
          const m = /^\s*(fg|bg)\s*=\s*(.+?)\s*$/.exec(kv);
          if (m) out.values[m[1]] = { expr: m[2], hex: exprToHex(m[2], known), file: s.file, main: !!s.main };
        }
      }
    }
    return out;
  });
  const fields = {};
  const whole = text;                                          // title fields may follow \begin{document}
  for (const f of FIELDS) {
    const r = findCommand(whole, f, 1);
    let where = r ? path.basename(texPath) : null, val = r;
    if (!r) for (const s of src.slice(1)) { const q = findCommand(s.text, f, 1); if (q) { val = q; where = s.file; break; } }
    const rec = val ? { long: val.args[0], short: val.opt, file: where, main: where === path.basename(texPath) } : null;
    if (rec && !rec.main) {                     // set through a style package's options (title={...})
      const vl = viaOption(text, rec.long), vs = viaOption(text, rec.short);
      if (vl) { rec.long = vl.value || ''; rec.via = { pkg: vl.pkg, key: vl.key }; }
      if (vs) { rec.short = vs.value || ''; rec.viaShort = { pkg: vs.pkg, key: vs.key }; }
      else if (vl) rec.short = null;
    }
    fields[f] = rec;
  }
  const themes = {};
  for (const k of ['theme', 'colortheme', 'fonttheme']) {
    let v = null;
    for (const s of src) for (const t of findAll(s.text, 'use' + k, 1)) v = { name: t.args[0].trim(), file: s.file, main: !!s.main };
    if (v && !v.main) { const vo = viaOption(text, v.name); if (vo) { v.name = vo.value || 'default'; v.via = { pkg: vo.pkg, key: vo.key }; } }
    themes[k] = v;
  }
  const dc = findCommand(main.text, 'documentclass', 1);
  const ar = dc && dc.opt && /aspectratio\s*=\s*(\d+)/.exec(dc.opt);
  const paper = paperInfo(texPath, text);
  const paperRatio = paper && ratioOf(paper.w, paper.h);
  const tmpl = (name) => {
    for (const s of [...src].reverse()) {
      const c = nc(s.text);
      const re = new RegExp(String.raw`\\setbeamertemplate\s*\{${name}\}\s*(\[[^\]]*\])?\s*(\{)?`, 'g');
      let m, last = null;
      while ((m = re.exec(c))) last = m;
      if (last) {
        const empty = last[2] && /^\{\s*\}/.test(c.slice(last.index + last[0].length - 1));
        return { file: s.file, main: !!s.main, preset: last[1] ? last[1].slice(1, -1).trim() : null, empty: !!empty };
      }
    }
    return null;
  };
  return {
    fields, themes, aspect: paperRatio || (ar ? ar[1] : null), paper, colors, slots,
    templates: { footline: tmpl('footline'), headline: tmpl('headline'), nav: tmpl('navigation symbols') },
    installed: installedThemes(path.dirname(texPath)),
  };
}

/* ------------------------------------------------------------ edits */
/* Each returns the new text of the main file. Lines are added before
 * \begin{document} (after everything else in the preamble, so they win), or
 * for themes next to the line that sets the current theme. */
function preambleEnd(text) { const i = nc(text).indexOf('\\begin{document}'); return i < 0 ? text.length : i; }
function insertBeforeDoc(text, line) {
  const i = preambleEnd(text);
  return text.slice(0, i) + line + '\n' + text.slice(i);
}
function lineEnd(text, i) { const k = text.indexOf('\n', i); return k < 0 ? text.length : k + 1; }

function setField(text, field, long, short) {
  const r = findCommand(text, field, 1);
  const call = long == null || long === '' ? '' : `\\${field}${short ? `[${short}]` : ''}{${long}}`;
  if (r) {
    if (!call) {                                                // remove, with its line if it is alone there
      const ls = text.lastIndexOf('\n', r.from - 1) + 1, le = lineEnd(text, r.to);
      if (/^\s*$/.test(text.slice(ls, r.from)) && /^\s*$/.test(text.slice(r.to, le))) return text.slice(0, ls) + text.slice(le);
      return text.slice(0, r.from) + text.slice(r.to);
    }
    return text.slice(0, r.from) + call + text.slice(r.to);
  }
  if (!call) return text;
  // next to the other title-page fields, if the file has some
  let last = null;
  for (const g of FIELDS) { const q = findCommand(text, g, 1); if (q && (!last || q.to > last.to)) last = q; }
  if (last) { const at = lineEnd(text, last.to); return text.slice(0, at) + call + '\n' + text.slice(at); }
  return insertBeforeDoc(text, call);
}

function setTheme(text, kind, name, after) {
  const pre = preambleEnd(text);
  const all = findAll(text, 'use' + kind, 1, 0, pre);
  const line = name ? `\\use${kind}{${name}}` : '';
  if (all.length) {
    const r = all[all.length - 1];
    if (!line) { const ls = text.lastIndexOf('\n', r.from - 1) + 1; return text.slice(0, ls) + text.slice(lineEnd(text, r.to)); }
    return text.slice(0, r.from) + `\\use${kind}${r.opt != null ? `[${r.opt}]` : ''}{${name}}` + text.slice(r.to);
  }
  if (!line) return text;
  // after the line loading the file that sets the current one, else after \documentclass
  let at = -1;
  if (after) {
    const base = after.replace(/\.(sty|tex)$/, '').replace(/^beamer(color|font|)theme/, '');
    const m = new RegExp(String.raw`\\(?:usepackage|input|include|usetheme|usecolortheme|usefonttheme)(?:\[[^\]]*\])?\{[^}]*\b${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b[^}]*\}`).exec(nc(text).slice(0, pre));
    if (m) at = lineEnd(text, m.index + m[0].length);
  }
  if (at < 0) { const dc = findCommand(text, 'documentclass', 1); at = dc ? lineEnd(text, dc.to) : 0; }
  return text.slice(0, at) + line + '\n' + text.slice(at);
}

function setAspect(text, ratio) {
  const dc = findCommand(text, 'documentclass', 1);
  if (!dc) return text;
  const opt = dc.opt || '';
  const m = /(^|,)(\s*aspectratio\s*=\s*)(\d+)/.exec(opt);
  const keep = ratio && ratio !== '43';
  let next;
  if (m) {                                                   // change the value where it is
    if (m[3] === ratio) return text;
    next = keep ? opt.slice(0, m.index) + m[1] + m[2] + ratio + opt.slice(m.index + m[0].length)
      : (opt.slice(0, m.index) + opt.slice(m.index + m[0].length)).replace(/^\s*,\s*|\s*,\s*$/g, '');
  } else {
    if (!keep) return text;
    next = opt.trim() ? `${opt}, aspectratio=${ratio}` : `aspectratio=${ratio}`;
  }
  return text.slice(0, dc.from) + `\\documentclass${next.trim() ? `[${next}]` : ''}{${dc.args[0]}}` + text.slice(dc.to);
}

/* The paper size for a ratio, where the deck sets it (style options or a
 * \geometry in this file): beamer's size for that ratio, scaled like the
 * current paper (a 222 x 125 mm deck stays about that size). */
function setPaper(texPath, text, ratio) {
  const p = paperInfo(texPath, text);
  if (!p || !(p.via || p.main)) return text;
  const W = lenPt(p.w), H = lenPt(p.h);
  if (!W || !H) return text;
  const cur = ratioOf(p.w, p.h);
  const base = RATIO_MM[cur] || [W.pt / LEN_PT.mm, H.pt / LEN_PT.mm];
  const scale = Math.sqrt((W.pt / LEN_PT.mm) * (H.pt / LEN_PT.mm) / (base[0] * base[1]));
  const [a, b] = RATIO_MM[ratio] || RATIO_MM[43];
  const unit = W.unit;
  const fmt = (mm) => { const v = mm * LEN_PT.mm / LEN_PT[unit]; return (Math.round(v * 10) / 10).toString() + unit; };
  const nw = fmt(a * scale), nh = fmt(b * scale);
  if (p.via) return setPkgOption(setPkgOption(text, p.via.pkg, p.via.wkey, nw), p.via.pkg, p.via.hkey, nh);
  // \geometry{...} in this file
  const g = findAll(text, 'geometry', 1).filter((x) => { const k = geometryKeys(x.args[0]); return k.paperwidth && k.paperheight; }).pop();
  if (!g) return text;
  const body = g.args[0].split(',').map((kv) => kv.replace(/^(\s*paperwidth\s*=\s*).+?(\s*)$/, `$1${nw}$2`).replace(/^(\s*paperheight\s*=\s*).+?(\s*)$/, `$1${nh}$2`)
    .replace(/^(\s*papersize\s*=\s*).+$/, `$1{${nw},${nh}}`)).join(',');
  return text.slice(0, g.from) + `\\geometry{${body}}` + text.slice(g.to);
}

/* A named colour: change its \definecolor in the main file, or add one
 * (overriding a definition from another file) before \begin{document}. */
function setColor(text, name, hex) {
  const pre = preambleEnd(text);
  const all = findAll(text, 'definecolor', 3, 0, pre).filter((d) => d.args[0].trim() === name);
  const call = `\\definecolor{${name}}{HTML}{${hex.toUpperCase()}}`;
  if (all.length) { const r = all[all.length - 1]; return text.slice(0, r.from) + call + text.slice(r.to); }
  return insertBeforeDoc(text, call);
}

/* A beamer colour slot's fg or bg: a named colour slidex<Slot><Key> defined
 * just before its \setbeamercolor line (hex null: remove our setting). */
function slotColorName(slot, key) { return 'slidex' + slot.replace(/(^|\s)(\w)/g, (m, s, c) => c.toUpperCase()) + key.toUpperCase(); }
function setSlot(text, slot, key, hex) {
  const pre = preambleEnd(text);
  const cname = slotColorName(slot, key);
  const sets = findAll(text, 'setbeamercolor', 2, 0, pre).filter((c) => c.args[0].trim() === slot);
  if (hex) text = setColor(text, cname, hex);
  const pre2 = preambleEnd(text);
  const sets2 = findAll(text, 'setbeamercolor', 2, 0, pre2).filter((c) => c.args[0].trim() === slot);
  const r = sets2[sets2.length - 1];
  if (r) {
    const kvs = r.args[1].split(',').map((s) => s.trim()).filter(Boolean).filter((kv) => !new RegExp(`^${key}\\s*=`).test(kv));
    if (hex) kvs.push(`${key}=${cname}`);
    const call = `\\setbeamercolor{${slot}}{${kvs.join(',')}}`;
    text = text.slice(0, r.from) + call + text.slice(r.to);
  } else if (hex) {
    // after our \definecolor line
    const d = findAll(text, 'definecolor', 3, 0, preambleEnd(text)).filter((x) => x.args[0].trim() === cname).pop();
    const at = lineEnd(text, d.to);
    text = text.slice(0, at) + `\\setbeamercolor{${slot}}{${key}=${cname}}\n` + text.slice(at);
  }
  if (!hex) {                                                    // drop our colour if nothing uses it now
    const uses = (nc(text).match(new RegExp(`\\b${cname}\\b`, 'g')) || []).length;
    const d = findAll(text, 'definecolor', 3).filter((x) => x.args[0].trim() === cname).pop();
    if (d && uses === 1) { const ls = text.lastIndexOf('\n', d.from - 1) + 1; text = text.slice(0, ls) + text.slice(lineEnd(text, d.to)); }
  }
  void sets;
  return text;
}

const FOOTLINES = {
  none: '\\setbeamertemplate{footline}{}',
  number: '\\setbeamertemplate{footline}[frame number]',
  authortitle: '\\setbeamertemplate{footline}{\\leavevmode\\hbox{\\begin{beamercolorbox}[wd=\\paperwidth,ht=2.5ex,dp=1ex,leftskip=1em,rightskip=1em]{footline}'
    + '\\usebeamerfont{footline}\\insertshortauthor\\hfill\\insertshorttitle\\hfill\\insertframenumber{} / \\inserttotalframenumber\\end{beamercolorbox}}}',
};
/* \setbeamertemplate{name}...: replace the main file's (whole, braces
 * matched) or add one; line '' removes the main file's. */
function setTemplate(text, name, line) {
  const pre = preambleEnd(text);
  const c = nc(text);
  const re = new RegExp(String.raw`\\setbeamertemplate\s*\{${name}\}`, 'g');
  let m, last = null;
  while ((m = re.exec(c)) && m.index < pre) last = m;
  if (last) {
    let p = last.index + last[0].length;
    while (/\s/.test(c[p] || '')) p++;
    if (c[p] === '[') { const q = matchBracket(c, p + 1); p = q + 1; }
    let q = p;
    while (/[ \t]/.test(c[q] || '')) q++;
    if (c[q] === '{') { const e = matchBrace(c, q); if (e > 0) p = e + 1; }
    const ls = text.lastIndexOf('\n', last.index - 1) + 1, le = lineEnd(text, p);
    const whole = /^\s*$/.test(text.slice(ls, last.index)) && /^\s*$/.test(text.slice(p, le));
    if (!line) return whole ? text.slice(0, ls) + text.slice(le) : text.slice(0, last.index) + text.slice(p);
    return text.slice(0, last.index) + line + text.slice(p);
  }
  return line ? insertBeforeDoc(text, line) : text;
}

/* One edit from the panel: {kind, ...} -> new text. */
function apply(texPath, text, e) {
  switch (e.kind) {
    case 'field': {
      if (e.via || e.viaShort) {
        if (e.via) text = setPkgOption(text, e.via.pkg, e.via.key, e.long);
        if (e.viaShort) text = setPkgOption(text, e.viaShort.pkg, e.viaShort.key, e.short);
        return text;
      }
      return setField(text, e.field, e.long, e.short);
    }
    case 'theme': return e.via ? setPkgOption(text, e.via.pkg, e.via.key, e.name) : setTheme(text, e.which, e.name, e.after);
    case 'aspect': return setPaper(texPath, setAspect(text, e.ratio), e.ratio);
    case 'color': return setColor(text, e.name, e.hex);
    case 'slot': return setSlot(text, e.slot, e.key, e.hex);
    case 'footline': return setTemplate(text, 'footline', e.preset === 'default' ? '' : FOOTLINES[e.preset]);
    case 'headline': return setTemplate(text, 'headline', e.on ? '' : '\\setbeamertemplate{headline}{}');
    case 'nav': return setTemplate(text, 'navigation symbols', e.on ? '' : '\\setbeamertemplate{navigation symbols}{}');
    default: return text;
  }
}

module.exports = { pkgOptions, setPkgOption, info, apply, findCommand, exprToHex, modelToHex, slotColorName, FOOTLINES };
