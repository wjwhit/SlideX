// SlideX editor mode, main-process side: the deck's LaTeX source, its frames,
// single-frame and full compiles, LaTeX errors, backups, and SyncTeX lookups.
//
// Single-frame compiles use a one-slide copy of the deck (see oneSlideSource:
// other frames blanked, counters set, the full build's .aux copied, so sections,
// headline and numbering stay right), with the jobname `<deck>.slidex-<label>`
// (`_frame<n>` for a frame without a label) and outputs in `<deck folder>/.slidex/`.
// Frames should be fragile environments (\begin{frame}[fragile], or
// environments built with beamer's `environment=` option and `fragile`): then
// beamer writes each body to a .vrb file and SyncTeX records every line,
// which we map back to the source. Other frames still work, frame by frame.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let synctexLib = null;
try { synctexLib = require('./synctex'); } catch { /* added by the synctex module */ }

const TEX_PATHS = ['/Library/TeX/texbin', '/usr/local/texlive/2024/bin/universal-darwin',
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
/* SlideX's own LaTeX packages (slidemovie, slidexframes) are on the search
 * path, bundled in the app (latex/) or in the repository (../latex), for decks
 * that use them; neither is required. */
const BUNDLED_TEX = [path.join(__dirname, 'latex'), path.join(__dirname, '..', 'latex')].find((d) => fs.existsSync(path.join(d, 'slidemovie.sty')));
const ENV = { ...process.env, PATH: [...TEX_PATHS, process.env.PATH || ''].join(':'),
  TEXINPUTS: (process.env.TEXINPUTS ? process.env.TEXINPUTS.replace(/:*$/, ':') : '') + (BUNDLED_TEX ? BUNDLED_TEX + ':' : '') };

/* Frame-like environments and macros. Environments may be fragile; macros
 * (\cframe{opts}{title}{body}) can be edited and compiled, but SyncTeX can
 * only point at their closing brace. */
const FRAME_ENVS = ['frame', 'cframe', 'appendixframe', 'sframe', 'sbackup'];   // plus \newslidexframe{name} ones
const FRAME_MACROS = ['cframe', 'appendixframe'];

/* ------------------------------------------------------------- source */
function findSource(pdfPath) {
  const tex = pdfPath.replace(/\.pdf$/i, '.tex');
  return fs.existsSync(tex) ? tex : null;
}

/* Skip to the matching closing brace starting at an opening brace index. */
function matchBrace(text, i) {
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '%') { const nl = text.indexOf('\n', i); if (nl < 0) return -1; i = nl; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function lineOf(starts, idx) {           // 1-based line number of a character index
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; }
  return lo + 1;
}

/* All frames in the source, in order: {kind, name, start, end, bodyStart,
 * label, fragile, title}. Lines are 1-based; start/end are the lines of the
 * opening and closing commands. Commented-out frames are ignored. */
function parseFrames(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  // blank out comments (keep length) so matches inside them are ignored
  const clean = text.replace(/(^|[^\\])%[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
  const frames = [];
  const envs = [...FRAME_ENVS, ...[...clean.matchAll(/\\newslidexframe\{([A-Za-z]+)\}/g)].map((m) => m[1])];
  const envRe = new RegExp(String.raw`\\begin\{(${envs.join('|')})\}`, 'g');
  let m;
  while ((m = envRe.exec(clean))) {
    const name = m[1];
    const endTag = `\\end{${name}}`;
    const endIdx = clean.indexOf(endTag, m.index);
    if (endIdx < 0) continue;
    let p = m.index + m[0].length;
    let opts = '';
    let title = '';
    // frame: [opts]{title}; cframe/appendixframe envs: {opts}{title}
    if (name === 'frame') {
      while (clean[p] === ' ') p++;
      if (clean[p] === '<') p = clean.indexOf('>', p) + 1;
      if (clean[p] === '[') { const q = clean.indexOf(']', p); opts = clean.slice(p + 1, q); p = q + 1; }
      while (clean[p] === ' ') p++;
      if (clean[p] === '{') { const q = matchBrace(clean, p); title = clean.slice(p + 1, q); p = q + 1; }
    } else {
      for (let k = 0; k < 2; k++) {
        while (/\s/.test(clean[p] || '') && clean[p] !== '\n') p++;
        if (clean[p] !== '{') break;
        const q = matchBrace(clean, p);
        if (k === 0) opts = clean.slice(p + 1, q); else title = clean.slice(p + 1, q);
        p = q + 1;
      }
    }
    frames.push(frameRecord('env', name, starts, m.index, endIdx, p, opts, title));
  }
  const macRe = new RegExp(String.raw`\\(${FRAME_MACROS.join('|')})\s*\{`, 'g');
  while ((m = macRe.exec(clean))) {
    const name = m[1];
    let p = m.index + m[0].length - 1;
    const args = [];
    for (let k = 0; k < 3; k++) {
      while (/\s/.test(clean[p] || '')) p++;
      if (clean[p] !== '{') break;
      const q = matchBrace(clean, p);
      if (q < 0) break;
      args.push([p + 1, q]);
      p = q + 1;
    }
    if (args.length < 3) continue;
    frames.push(frameRecord('macro', name, starts, m.index, args[2][1], args[2][0],
      clean.slice(args[0][0], args[0][1]), clean.slice(args[1][0], args[1][1])));
  }
  frames.sort((a, b) => a.start - b.start);
  frames.forEach((f, i) => { f.index = i; });
  return frames;
}

function frameRecord(kind, name, starts, startIdx, endIdx, bodyIdx, opts, title) {
  const lm = /(?:^|,)\s*label\s*=\s*([^,\]\s}]+)/.exec(opts);
  return {
    kind, name,
    start: lineOf(starts, startIdx), end: lineOf(starts, endIdx), bodyStart: lineOf(starts, bodyIdx),
    label: lm ? lm[1] : null,
    fragile: kind === 'env' && (name !== 'frame' || /(^|,)\s*fragile/.test(opts)),
    title: title.replace(/\s+/g, ' ').trim(),
  };
}

function frameAtLine(frames, line) {
  return frames.find((f) => line >= f.start && line <= f.end) || null;
}

/* ------------------------------------------------------------ compile */
function buildDir(texPath) { return path.join(path.dirname(texPath), '.slidex'); }

function run(cmd, args, cwd, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { cwd, env: ENV });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, ms: Date.now() - t0 }); });
    p.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out: String(err), ms: Date.now() - t0 }); });
  });
}

/* LaTeX errors from a log written with -file-line-error:
 *   ./deck.tex:123: Undefined control sequence.
 * plus the classic "! message ... l.123" form. Paths are returned as written. */
function parseLog(log) {
  const errors = [];
  const lines = log.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(.*?\.(?:tex|vrb|sty|cls)):(\d+): (.*)$/.exec(lines[i]);
    if (m) {
      let msg = m[3];
      const ctx = lines.slice(i + 1, i + 4).join(' ').match(/l\.\d+\s+(.*)/);
      if (ctx) msg += '  [' + ctx[1].trim().slice(0, 80) + ']';
      errors.push({ file: m[1], line: +m[2], message: msg });
    } else if (/^! /.test(lines[i])) {
      const lm = lines.slice(i, i + 12).join('\n').match(/\nl\.(\d+)/);
      errors.push({ file: null, line: lm ? +lm[1] : null, message: lines[i].slice(2) });
    }
  }
  const seen = new Set();
  return errors.filter((e) => { const k = e.file + e.line + e.message; if (seen.has(k)) return false; seen.add(k); return true; });
}

/* ---------------------------------------------------------- single frame
 * A one-slide document, written to .slidex/<deck>.slidex-<label>.tex from the
 * editor's text (the .tex on disk is not touched):
 *  - the preamble and every line between frames (sections, \appendix, ...)
 *    are kept; the other frames' lines are blanked, so every line keeps its
 *    number and errors and SyncTeX need no translation;
 *  - the frame and page counters are set to their values in the full deck;
 *  - the full build's .aux/.nav/.snm/.toc/.out are copied to the job first,
 *    so headline, sections and links match the deck;
 *  - frames drawn with `remember picture` get the previous run's
 *    \pgfsyspdfmark lines appended to that .aux (one extra pass the first time);
 *  - the preamble is precompiled (mylatexformat) and rebuilt when it, or a
 *    local .tex/.sty/.cls, changes.
 * On the DFD deck this is pixel-identical to the full build and takes about
 * 0.4 to 0.5 s per slide (0.9 s with \includeonlyframes on the whole file). */
function deckBase(texPath) { return path.basename(texPath, '.tex'); }

/* A full-build file (.aux, .synctex.gz, ...): SlideX's own build in .slidex/,
 * or one made by another tool next to the .tex, whichever is newer. */
function fullBuildFile(texPath, ext) {
  const a = path.join(buildDir(texPath), `${deckBase(texPath)}.${ext}`);
  const b = path.join(path.dirname(texPath), `${deckBase(texPath)}.${ext}`);
  const ta = fs.existsSync(a) ? fs.statSync(a).mtimeMs : -1;
  const tb = fs.existsSync(b) ? fs.statSync(b).mtimeMs : -1;
  if (ta < 0 && tb < 0) return null;
  return ta >= tb ? a : b;
}

function prepareAux(texPath, job) {
  const dir = path.dirname(texPath);
  const bdir = buildDir(texPath);
  const old = safeRead(path.join(bdir, `${job}.aux`)) || '';
  const marks = old.split('\n').filter((l) => l.startsWith('\\pgfsyspdfmark')).join('\n');
  for (const ext of ['aux', 'nav', 'snm', 'toc', 'out']) {
    const src = fullBuildFile(texPath, ext);
    const dst = path.join(bdir, `${job}.${ext}`);
    if (src) fs.copyFileSync(src, dst);
    else fs.rmSync(dst, { force: true });
  }
  if (marks) fs.appendFileSync(path.join(bdir, `${job}.aux`), '\n' + marks + '\n');
  return !!marks;
}

function preambleOf(text) { const i = text.indexOf('\\begin{document}'); return i < 0 ? text : text.slice(0, i); }

/* Precompiled preamble: .slidex/<deck>.slidexfmt.fmt, built from the given
 * text's preamble and keyed on it plus the local .tex/.sty/.cls files. */
async function ensureFormat(texPath, text) {
  const dir = path.dirname(texPath);
  const bdir = buildDir(texPath);
  fs.mkdirSync(bdir, { recursive: true });
  const name = `${deckBase(texPath)}.slidexfmt`;
  const pre = preambleOf(text);
  const stamp = [pre];
  for (const f of fs.readdirSync(dir).sort()) {
    if (/\.(sty|tex|cls)$/.test(f) && f !== path.basename(texPath)) {
      try { stamp.push(f + ':' + fs.statSync(path.join(dir, f)).mtimeMs); } catch { /* gone */ }
    }
  }
  const key = require('crypto').createHash('sha1').update(stamp.join('\n')).digest('hex');
  const keyFile = path.join(bdir, `${name}.key`);
  if (safeRead(keyFile) === key && fs.existsSync(path.join(bdir, `${name}.fmt`))) return name;
  const src = path.join(bdir, `${name}-src.tex`);
  fs.writeFileSync(src, pre + '\\begin{document}\n\\end{document}\n');
  const r = await run('pdflatex', ['-ini', '-interaction=nonstopmode', '-output-directory=.slidex',
    `-jobname=${name}`, '&pdflatex', 'mylatexformat.ltx', path.relative(dir, src)], dir);
  if (r.code !== 0 || !fs.existsSync(path.join(bdir, `${name}.fmt`))) return null;
  fs.writeFileSync(keyFile, key);
  return name;
}

function isNumbered(f, lines) {
  return !(f.name === 'appendixframe' || f.name === 'sbackup' || /noframenumbering/.test(lines[f.start - 1] || ''));
}

/* Line-by-line SyncTeX needs a fragile frame (see the synctex section). In
 * SlideX's one-slide copy only (the deck is never changed), an ordinary
 * \begin{frame} or a wrapper macro like \cframe{opts}{title}{body} is turned
 * into the environment below, on the same lines: a fragile frame (beamer's
 * environment= option) that ends its last paragraph inside the frame, as
 * slidexframes does, so the page is the same as the deck's. Skipped unless
 * the \begin line holds the whole header and the closing line stands alone.
 * Returns {pre, opts, title, post} for the \begin line, or null. */
const COPY_ENV = 'slidexcopyframe';
const COPY_DEF = `\\newenvironment{${COPY_ENV}}[2]{\\begin{frame}[environment=${COPY_ENV},fragile,#1]{#2}}{\\ifhmode\\par\\fi\\end{frame}}`;

/* Measurements the editor needs to turn a drag into source units, written to
 * the one-slide build's log only (\write-1), never into the slide:
 *   SLIDEXUNIT <line> ax ay bx by   TikZ node placed `at (...)`: the picture's x and y unit
 *                                   vectors (pt, after its transformations)
 *   SLIDEXLW <line> w               first \column of a columns block: \linewidth there
 *   SLIDEXTP <line> h v             textpos block: \TPHorizModule, \TPVertModule */
const PROBE_DEF = '\\def\\slidexpd#1#2{\\pgfpointdiff{\\pgfpointtransformed{\\pgfpointorigin}}{\\pgfpointtransformed{\\pgfpointxy{#1}{#2}}}}'
  + '\\def\\slidexpu#1{{\\pgfextractx{\\dimen0}{\\slidexpd{1}{0}}\\pgfextracty{\\dimen2}{\\slidexpd{1}{0}}'
  + '\\pgfextractx{\\dimen4}{\\slidexpd{0}{1}}\\pgfextracty{\\dimen6}{\\slidexpd{0}{1}}'
  + '\\immediate\\write-1{SLIDEXUNIT #1 \\the\\dimen0/\\the\\dimen2/\\the\\dimen4/\\the\\dimen6}}}'
  + '\\def\\slidexplw#1{\\immediate\\write-1{SLIDEXLW #1 \\the\\linewidth}}'
  + '\\def\\slidexptp#1{\\ifdefined\\TPHorizModule\\immediate\\write-1{SLIDEXTP #1 \\the\\TPHorizModule/\\the\\TPVertModule}\\fi}';

/* Lines of the frame to probe: {line -> '\\slidexpu'|'\\slidexplw'|'\\slidexptp'}. */
function probeLines(lines, frame) {
  const out = {};
  const nc = (t) => t.replace(/(^|[^\\])%.*$/, '$1');
  let overlay = 0, depth = 0, firstCol = [];
  for (let l = frame.start + 1; l < frame.end; l++) {
    const t = nc(lines[l - 1] || '');
    if (/\\begin\{tikzpicture\}/.test(t)) {
      depth++;
      const head = [t, nc(lines[l] || ''), nc(lines[l + 1] || '')].join(' ');
      if (/\\begin\{tikzpicture\}\s*\[[^\]]*\boverlay\b/.test(head) || /\\begin\{tikzpicture\}\s*\[[^\]]*$/.test(t) && /\boverlay\b/.test(head)) overlay = depth;
    }
    if (depth && /\\node\b[^;]*?\bat\s*\(/.test(t)) out[l] = '\\slidexpu';
    if (/\\end\{tikzpicture\}/.test(t)) { if (overlay === depth) overlay = 0; depth = Math.max(0, depth - 1); }
    if (/\\begin\{columns\}/.test(t)) firstCol.push(true);
    if (/\\end\{columns\}/.test(t)) firstCol.pop();
    if (firstCol.length && firstCol[firstCol.length - 1] && /^\s*\\(?:column\b|begin\{column\})/.test(t)) { out[l] = '\\slidexplw'; firstCol[firstCol.length - 1] = false; }
    if (/\\begin\{textblock\*?\}/.test(t)) out[l] = '\\slidexptp';
  }
  return out;
}

function frameHeader(line) {
  const m = /\\begin\{frame\}/.exec(line);
  if (!m) return null;
  let p = m.index + m[0].length;
  const ws = () => { while (line[p] === ' ' || line[p] === '\t') p++; };
  ws();
  if (line[p] === '<') return null;                 // overlay spec on the frame: leave it
  let opts = '', title = '';
  if (line[p] === '[') { const q = line.indexOf(']', p); if (q < 0) return null; opts = line.slice(p + 1, q); p = q + 1; ws(); }
  if (line[p] === '{') { const q = matchBrace(line, p); if (q < 0) return null; title = line.slice(p + 1, q); p = q + 1; }
  if (!/^\s*(%.*)?$/.test(line.slice(p))) return null;
  return { pre: line.slice(0, m.index), opts, title, post: line.slice(p) };
}

function macroHeader(line, name, template) {
  const m = new RegExp(String.raw`\\${name}\s*\{`).exec(line);
  if (!m || template == null) return null;
  const args = [];
  let p = m.index + m[0].length - 1;
  for (let k = 0; k < 2; k++) {
    while (line[p] === ' ' || line[p] === '\t') p++;
    if (line[p] !== '{') return null;
    const q = matchBrace(line, p);
    if (q < 0) return null;
    args.push(line.slice(p + 1, q));
    p = q + 1;
  }
  while (line[p] === ' ' || line[p] === '\t') p++;
  if (line[p] !== '{' || !/^\s*(%.*)?$/.test(line.slice(p + 1))) return null;
  const opts = template.replace(/#1/g, args[0]).replace(/^\s*,+|,+\s*$/g, '');
  return { pre: line.slice(0, m.index), opts, title: args[1], post: line.slice(p + 1) };
}

/* The one-slide source: same line numbers as `text`. opts.fragile: make the
 * frame fragile as above (sets opts.madeFragile); opts.macroTemplate: from
 * frameMacroTemplate for a macro frame. */
function oneSlideSource(text, frames, frame, firstPage, opts = {}) {
  const lines = text.split('\n');
  if (opts.fragile && !frame.fragile) {
    let h = null;
    const endLine = lines[frame.end - 1] || '';
    // beamer also takes the title (or options) from the next line: then leave the frame as it is
    const nextArg = /^\s*[{[<]/.test(lines[frame.start] || '');
    if (frame.kind === 'env' && frame.name === 'frame' && !nextArg && /^\s*\\end\{frame\}\s*$/.test(endLine)) h = frameHeader(lines[frame.start - 1]);
    if (frame.kind === 'macro' && /^\s*\}\s*(%.*)?$/.test(endLine)) h = macroHeader(lines[frame.start - 1], frame.name, opts.macroTemplate);
    if (h) {
      lines[frame.start - 1] = `${COPY_DEF}${h.pre}\\begin{${COPY_ENV}}{${h.opts}}{${h.title}}${h.post}`;
      lines[frame.end - 1] = `\\end{${COPY_ENV}}`;
      opts.madeFragile = true;
    }
  }
  const probes = probeLines(text.split('\n'), frame);
  // after the indentation, which TeX skips (in front of it the tabs would become a space)
  for (const [l, cmd] of Object.entries(probes)) lines[l - 1] = lines[l - 1].replace(/^\s*/, (ws) => ws + `${cmd}{${l}}`);
  for (const g of frames) {
    if (g.index === frame.index) continue;
    for (let i = g.start - 1; i < g.end && i < lines.length; i++) lines[i] = '';
  }
  const fnum = frames.filter((g) => g.index < frame.index && isNumbered(g, text.split('\n'))).length;
  // fastest zlib level: pages identical, compiles of image-heavy slides about
  // 35% faster, files about the size of the deck's (level 0 would be 5-10x larger)
  let set = `\\pdfcompresslevel=1 ${Object.keys(probes).length ? PROBE_DEF : ''}\\setcounter{framenumber}{${fnum}}`;
  if (firstPage != null) set += `\\setcounter{page}{${firstPage}}`;
  lines[frame.start - 1] = set + lines[frame.start - 1];
  return lines.join('\n');
}

/* opts: {frames, firstPage} (firstPage: 0-based index of the frame's first
 * page in the full deck, for the page counter; null if unknown). */
async function compileFrame(texPath, frame, text, opts = {}) {
  if (!frame) return { ok: false, errors: [{ file: null, line: null, message: 'The cursor is not inside a frame.' }] };
  const dir = path.dirname(texPath);
  const bdir = buildDir(texPath);
  fs.mkdirSync(bdir, { recursive: true });
  // unlabelled frames are named by position (the cache is cleared on every compile)
  const job = `${deckBase(texPath)}.slidex-${frame.label ? frame.label.replace(/[^\w.-]/g, '_') : '_frame' + (frame.index + 1)}`;
  const frames = opts.frames || parseFrames(text);
  const srcPath = path.join(bdir, `${job}.tex`);
  const so = { fragile: opts.fragile !== false,
    macroTemplate: frame.kind === 'macro' ? frameMacroTemplate(texPath, text, frame.name) : null };
  fs.writeFileSync(srcPath, oneSlideSource(text, frames, frame, opts.firstPage, so));
  const fmt = await ensureFormat(texPath, text);
  const args = ['-interaction=nonstopmode', '-file-line-error', '-synctex=1', '-output-directory=.slidex', `-jobname=${job}`];
  if (fmt) args.push(`-fmt=.slidex/${fmt}`);
  args.push(path.relative(dir, srcPath));
  let hadMarks = prepareAux(texPath, job);
  const t0 = Date.now() - 1000;
  let r = await run('pdflatex', args, dir);
  if (!hadMarks && /remember picture/.test(text.split('\n').slice(frame.start - 1, frame.end).join('\n'))) {
    hadMarks = prepareAux(texPath, job);                      // second pass for remember picture
    if (hadMarks) { const r2 = await run('pdflatex', args, dir); r = { ...r2, ms: r.ms + r2.ms }; }
  }
  const pdf = path.join(bdir, `${job}.pdf`);
  const log = safeRead(path.join(bdir, `${job}.log`)) || r.out;
  const errors = parseLog(log);
  const probes = { units: {}, lw: {}, tp: {} };
  const pt = (v) => parseFloat(v);
  for (const m of (log || '').matchAll(/^SLIDEXUNIT (\d+) (\S+)pt\/(\S+)pt\/(\S+)pt\/(\S+)pt$/gm)) probes.units[m[1]] = [pt(m[2]), pt(m[3]), pt(m[4]), pt(m[5])];
  for (const m of (log || '').matchAll(/^SLIDEXLW (\d+) (\S+)pt$/gm)) probes.lw[m[1]] = pt(m[2]);
  for (const m of (log || '').matchAll(/^SLIDEXTP (\d+) (\S+)pt\/(\S+)pt$/gm)) probes.tp[m[1]] = [pt(m[2]), pt(m[3])];
  const ok = r.code === 0 && fs.existsSync(pdf);
  if (so.madeFragile && (!ok || errors.length)) {
    // a frame that cannot be fragile (or a real error): try it as written;
    // keep that result only if it is clean, else report the fragile run's
    // errors, which carry exact lines
    const plain = await compileFrame(texPath, frame, text, { ...opts, fragile: false });
    if (plain.ok && !plain.errors.length) { cleanBuildDir(texPath, { keepJob: job, jobSince: t0 }); return { ...plain, ms: plain.ms + r.ms }; }
    fs.writeFileSync(srcPath, oneSlideSource(text, frames, frame, opts.firstPage, { fragile: true, macroTemplate: so.macroTemplate }));
    await run('pdflatex', args, dir);
  }
  if (opts.fragile !== false) cleanBuildDir(texPath, { keepJob: job, jobSince: t0 });
  return { ok, probes, pdf: fs.existsSync(pdf) ? pdf : null, srcPath, frameStart: frame.start, frameEnd: frame.end, madeFragile: !!so.madeFragile,
    synctex: path.join(bdir, `${job}.synctex.gz`), job, errors, ms: r.ms, key: frameKey(frame), name: frameName(frame), fmt: !!fmt, log };
}

/* Full deck from the file on disk, built in .slidex/ (so the .aux, .log,
 * .vrb and other build files stay out of the deck's folder), with the
 * precompiled preamble when there is one; a second pass only when LaTeX asks.
 * Only the PDF is copied next to the .tex. */
async function compileDeck(texPath) {
  const dir = path.dirname(texPath);
  const bdir = buildDir(texPath);
  fs.mkdirSync(bdir, { recursive: true });
  const base = deckBase(texPath);
  const text = safeRead(texPath) || '';
  const fmt = await ensureFormat(texPath, text);
  const t0 = Date.now() - 1000;
  const args = ['-interaction=nonstopmode', '-file-line-error', '-synctex=1', '-output-directory=.slidex', `-jobname=${base}`];
  if (fmt) args.push(`-fmt=.slidex/${fmt}`);
  args.push(path.basename(texPath));
  let r = await run('pdflatex', args, dir, 300000);
  const logPath = path.join(bdir, `${base}.log`);
  if (r.code === 0 && /Rerun to get|undefined references|Label\(s\) may have changed/i.test(safeRead(logPath) || '')) {
    const r2 = await run('pdflatex', args, dir, 300000);
    r = { ...r2, ms: r.ms + r2.ms };
  }
  const built = path.join(bdir, `${base}.pdf`);
  const pdf = texPath.replace(/\.tex$/, '.pdf');
  if (fs.existsSync(built)) {
    const tmp = pdf + '.slidex-tmp';
    fs.copyFileSync(built, tmp);
    fs.renameSync(tmp, pdf);
  }
  const log = safeRead(logPath) || r.out;
  if (r.code === 0) cleanBuildDir(texPath, { deckSince: t0 });
  return { ok: r.code === 0 && fs.existsSync(built), built: fs.existsSync(built), pdf, errors: parseLog(log), ms: r.ms, fmt: !!fmt, log };
}

/* .slidex/ housekeeping, for this deck's files only. Always kept: the full
 * build (<deck>.aux, .nav, ... and its PDF: one-slide compiles and the slide
 * strip read them), the precompiled preamble, and backups/.
 *   deckSince: after a full build, remove the deck's .vrb files it did not
 *              write (frames that moved or were deleted leave old ones).
 *   keepJob:   remove every one-slide build except this one (null: all of
 *              them; undefined: leave them alone), and the .vrb files of
 *              keepJob older than jobSince. Other frames' .aux files that hold
 *              remember-picture marks stay until the editor closes. */
function cleanBuildDir(texPath, { deckSince = null, keepJob, jobSince = 0 } = {}) {
  const bdir = buildDir(texPath);
  const base = deckBase(texPath);
  let names;
  try { names = fs.readdirSync(bdir); } catch { return 0; }
  let n = 0;
  const rm = (f) => { try { fs.rmSync(path.join(bdir, f), { force: true }); n++; } catch { /* in use */ } };
  const mtime = (f) => { try { return fs.statSync(path.join(bdir, f)).mtimeMs; } catch { return Infinity; } };
  const deckVrb = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-L\\d+|\\.\\d+)?\\.vrb$`);
  for (const f of names) {
    if (f.startsWith(`${base}.slidex-`)) {
      if (keepJob === undefined) continue;
      const mine = keepJob && (f.startsWith(`${keepJob}.`) || f.startsWith(`${keepJob}-L`));
      // a frame's remember-picture marks (in its .aux) save a second pass next time
      if (!mine && keepJob && f.endsWith('.aux') && /\\pgfsyspdfmark/.test(safeRead(path.join(bdir, f)) || '')) continue;
      if (!mine) rm(f);
      else if (/\.vrb$/.test(f) && mtime(f) < jobSince) rm(f);
    } else if (deckSince != null && deckVrb.test(f) && mtime(f) < deckSince) rm(f);
  }
  return n;
}

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

/* ------------------------------------------------------------- saving */
const backedUp = new Set();
function saveSource(texPath, text) {
  if (!backedUp.has(texPath)) {               // first save this session: keep the original
    const bdir = path.join(buildDir(texPath), 'backups');
    fs.mkdirSync(bdir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    fs.copyFileSync(texPath, path.join(bdir, `${path.basename(texPath, '.tex')}-${stamp}.tex`));
    backedUp.add(texPath);
  }
  const tmp = texPath + '.slidex-tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, texPath);
}

/* ------------------------------------------------------------- synctex */
/* Fragile frames are written to a .vrb file and read back line by line, so
 * SyncTeX records point into the .vrb. Its lines are the frame's source lines
 * with a few changes (a generated \frametitle first, leading comment lines
 * dropped, a closing line added), so each .vrb line is matched to the frame's
 * source by its text, in order. Which frame: <job>-L<B>.vrb (slidexframes
 * names it after the \begin line B), or, for a one-slide build, the frame it
 * holds. A .vrb with no known frame maps to nothing. The one-slide sources in
 * .slidex/ keep the deck's line numbers, so their own records map unchanged. */
const vrbCache = new Map();
function vrbTable(vrbPath, srcLines, B, E) {
  let st;
  try { st = fs.statSync(vrbPath); } catch { return null; }
  const key = `${vrbPath}|${B}|${E}|${st.mtimeMs}`;
  if (vrbCache.has(key)) return vrbCache.get(key);
  const v = (safeRead(vrbPath) || '').split('\n');
  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const map = [B];
  let j = B;                                    // next source line to match
  for (let n = 1; n <= v.length; n++) {
    const t = norm(v[n - 1]);
    let hit = null;
    if (norm(srcLines[j - 1]) === t) hit = j;
    else if (t) for (let k = j + 1; k <= E; k++) if (norm(srcLines[k - 1]) === t) { hit = k; break; }
    if (hit != null) { map[n] = hit; j = hit + 1; } else map[n] = map[n - 1];
  }
  if (vrbCache.size > 200) vrbCache.clear();
  vrbCache.set(key, map);
  return map;
}

/* (vrb file, line) -> source line, or null. ctx: {texPath, srcPath (the
 * one-slide copy, or the deck), frames, oneSlideStart, job}. */
function vrbMapper(ctx) {
  const dir = path.dirname(ctx.texPath);
  let src = null;
  return (file, n) => {
    if (!/\.vrb$/.test(file || '')) return null;
    const abs = path.resolve(dir, file);
    let B = null;
    const m = /-L(\d+)\.vrb$/.exec(abs);
    if (m) B = +m[1];
    else if (ctx.oneSlideStart && ctx.job && path.basename(abs).startsWith(ctx.job + '.')) B = ctx.oneSlideStart;
    if (B == null) return null;
    if (!src) src = (safeRead(ctx.srcPath || ctx.texPath) || '').split('\n');
    const f = ctx.oneSlideEnd && B === ctx.oneSlideStart ? { end: ctx.oneSlideEnd } : frameAtLine(ctx.frames || parseFrames(src.join('\n')), B);
    const t = vrbTable(abs, src, B, f ? f.end : src.length);
    if (!t) return m ? vrbToSource(B, n) : null;
    return t[Math.min(n, t.length - 1)];
  };
}
function vrbToSource(B, n) { return n <= 1 ? B : B + n - 2; }   // sframe layout, when the .vrb is gone

function remapFor(texPath, alias, ctx = {}) {
  const aliasReal = alias ? path.resolve(alias) : null;
  const toSrc = vrbMapper({ texPath, srcPath: alias, ...ctx });
  return (r) => {
    if (/\.vrb$/.test(r.path)) { const line = toSrc(r.path, r.line); return line == null ? null : { path: texPath, line }; }
    if (aliasReal && path.resolve(path.dirname(texPath), r.path) === aliasReal) return { path: texPath, line: r.line };
    return { path: r.path, line: r.line };
  };
}

function sameFile(a, b) {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return path.resolve(a) === path.resolve(b); }
}

async function loadSync(texPath, result, frame) {
  if (!synctexLib || !result.synctex || !fs.existsSync(result.synctex)) return null;
  const ctx = { oneSlideStart: frame.start, oneSlideEnd: frame.end, job: result.job };
  const st = await synctexLib.load(result.synctex, { remap: remapFor(texPath, result.srcPath, ctx) });
  const toSrc = vrbMapper({ texPath, srcPath: result.srcPath, ...ctx });
  const exact = st.inputs.some((i) => toSrc(i.path, 1) != null);
  const isMain = (p) => sameFile(path.resolve(path.dirname(texPath), p), texPath);
  return {
    st, exact,
    lineAt(page, x, y) {
      const r = st.lineAt(page, x, y, { preferPath: isMain });
      if (!r || !isMain(r.path) || r.line < frame.start || r.line > frame.end) return null;
      return { line: r.line, exact: exact && r.line !== frame.end };
    },
    boxesForLine(line, opts = {}) {
      if (!exact || line < frame.start || line > frame.end) return [];
      return st.boxesForLine(texPath, line, undefined, opts.textOnly ? { textOnly: true } : { lookahead: 2 });
    },
  };
}

/* Deck page (0-based index) -> frame label (or "#<index>" for unlabelled
 * frames), from the full build's SyncTeX. Labels survive edits that shift
 * frame indices. */
/* Deck page (0-based) -> frame index. Beamer's .nav lists each frame's pages
 * in the order they are typeset, which is robust to line changes since the
 * build (notes added, edits). Used when it has one entry per frame and agrees
 * with SyncTeX wherever a fresh SyncTeX (not older than the .tex) maps a page;
 * otherwise SyncTeX alone. */
async function pageFrameIndices(texPath, frames) {
  const viaSync = async () => (await syncPageFrames(texPath, frames)).map((k) => {
    const f = k == null ? null : frames.find((g) => frameKey(g) === k);
    return f ? f.index : null;
  });
  const nav = fullBuildFile(texPath, 'nav');
  const ranges = nav ? [...(safeRead(nav) || '').matchAll(/\\beamer@framepages\s*\{(\d+)\}\{(\d+)\}/g)].map((m) => [+m[1], +m[2]]) : [];
  if (ranges.length !== frames.length || !ranges.length) return viaSync();
  const out = [];
  ranges.forEach(([a, b], k) => { for (let pg = a; pg <= b; pg++) out[pg - 1] = k; });
  const sync = fullBuildFile(texPath, 'synctex.gz');
  let fresh = false;
  try { fresh = !!sync && fs.statSync(sync).mtimeMs >= fs.statSync(texPath).mtimeMs; } catch { /* no build */ }
  if (fresh) {
    const s = await viaSync();
    if (s.some((k, i) => k != null && out[i] != null && k !== out[i])) return s;
  }
  return Array.from(out, (k) => (k == null ? null : k));
}

/* Deck page (0-based) -> frame key (label, or "#<index>"), or null. */
async function pageFrames(texPath, frames) {
  return (await pageFrameIndices(texPath, frames)).map((k) => (k == null || !frames[k] ? null : frameKey(frames[k])));
}

async function syncPageFrames(texPath, frames) {
  const sync = fullBuildFile(texPath, 'synctex.gz');
  if (!synctexLib || !sync) return [];
  const st = await synctexLib.load(sync, { remap: remapFor(texPath) });
  const out = [];
  for (let pg = 1; pg <= st.pages; pg++) {
    const hits = new Map();
    for (const r of st.recordsOnPage(pg)) {
      if (!sameFile(path.resolve(path.dirname(texPath), r.path), texPath)) continue;
      const f = frameAtLine(frames, r.line);
      if (f) hits.set(f.index, (hits.get(f.index) || 0) + 1);
    }
    let best = null, n = 0;
    for (const [fi, c] of hits) if (c > n) { best = fi; n = c; }
    out.push(best == null ? null : (frames[best].label || '#' + best));
  }
  return out;
}

function frameKey(f) { return f.label || '#' + f.index; }
function frameName(f) { return f.label || `frame ${f.index + 1}`; }

/* ---------------------------------------------------------- completion */
/* Files under the deck's folder that \includegraphics, \slidemovie and
 * \input can take (relative paths; build and hidden folders skipped). */
function listFiles(texPath, maxFiles = 4000) {
  const dir = path.dirname(texPath);
  const out = [];
  const walk = (d, depth) => {
    if (depth > 5 || out.length >= maxFiles) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(d, e.name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) { try { isDir = fs.statSync(full).isDirectory(); } catch { continue; } }
      if (isDir) walk(full, depth + 1);
      else if (/\.(pdf|png|jpe?g|eps|svg|mp4|m4v|mov|webm|gif|tex|sty|bib)$/i.test(e.name) && full !== texPath) {
        out.push(path.relative(dir, full).split(path.sep).join('/'));
      }
      if (out.length >= maxFiles) return;
    }
  };
  walk(dir, 0);
  return out.sort();
}

/* Commands and environments the deck defines: its preamble, files it \input s
 * from its folder, and local .sty files. */
/* The deck's text, its \input/\include files, and the .sty files beside it. */
function deckSources(texPath, text) {
  const dir = path.dirname(texPath);
  const sources = [text];
  for (const m of text.matchAll(/\\(?:input|include)\{([^}]+)\}/g)) {
    const f = path.join(dir, m[1].endsWith('.tex') ? m[1] : m[1] + '.tex');
    const t = safeRead(f); if (t) sources.push(t);
  }
  try { for (const f of fs.readdirSync(dir)) if (/\.sty$/.test(f)) { const t = safeRead(path.join(dir, f)); if (t) sources.push(t); } } catch { /* none */ }
  return sources;
}

/* A frame macro that is only a wrapper, \newcommand{\name}[3]{\begin{frame}[..#1..]{#2} #3 \end{frame}}:
 * returns its option template ('#1', '#1,noframenumbering', ...), else null. */
function frameMacroTemplate(texPath, text, name) {
  for (const t0 of deckSources(texPath, text)) {
    const t = t0.replace(/(^|[^\\])%[^\n]*/g, '$1');
    const re = new RegExp(String.raw`\\(?:re)?newcommand\*?\s*\{?\\${name}\}?\s*\[3\]\s*\{`, 'g');
    const m = re.exec(t);
    if (!m) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBrace(t, open);
    if (close < 0) return null;
    const body = t.slice(open + 1, close).replace(/\s+/g, '');
    const w = /^\\begin\{frame\}(?:\[([^\]]*)\])?\{#2\}#3\\end\{frame\}$/.exec(body);
    return w ? (w[1] == null ? '' : w[1]) : null;
  }
  return null;
}

function scanMacros(texPath, text) {
  const sources = deckSources(texPath, text);
  const cmds = new Map(), envs = new Map(), boxes = new Set();
  for (const t of sources) {
    for (const m of t.matchAll(/\\(?:re)?newcommand\*?\s*\{?\\([A-Za-z@]+)\}?\s*(?:\[(\d)\])?/g)) {
      if (m[1].includes('@')) continue;
      cmds.set(m[1], +(m[2] || 0));
      const body = t.slice(m.index + m[0].length, m.index + m[0].length + 700).split(/\\(?:re)?newcommand/)[0];
      if (/\\begin\{tcolorbox\}|\\tcbox\b|\\fbox\b|\\colorbox\b/.test(body)) boxes.add(m[1]);
    }
    for (const m of t.matchAll(/\\(?:New|Renew|Provide)DocumentCommand\s*\{?\\([A-Za-z]+)\}?\s*\{([^}]*)\}/g)) cmds.set(m[1], (m[2].match(/[mo]/g) || []).length);
    for (const m of t.matchAll(/\\DeclareMathOperator\*?\s*\{?\\([A-Za-z]+)\}?/g)) cmds.set(m[1], 0);
    for (const m of t.matchAll(/\\def\\([A-Za-z]+)(#\d)*/g)) cmds.set(m[1], m[2] ? (m[0].match(/#/g) || []).length : 0);
    for (const m of t.matchAll(/\\(?:re)?newenvironment\*?\s*\{([A-Za-z*]+)\}\s*(?:\[(\d)\])?/g)) envs.set(m[1], +(m[2] || 0));
    for (const m of t.matchAll(/\\NewDocumentEnvironment\s*\{([A-Za-z*]+)\}\s*\{([^}]*)\}/g)) envs.set(m[1], (m[2].match(/[mo]/g) || []).length);
  }
  return { commands: [...cmds].map(([name, args]) => ({ name, args, box: boxes.has(name) })), environments: [...envs].map(([name, args]) => ({ name, args })) };
}

/* ------------------------------------------------------- media drop-in */
/* Copy a dropped image or movie into <deck folder>/figures/, convert GIFs
 * and folders of frames to H.264 mp4, and make the poster (<movie>.png) the
 * slidemovie package shows in the PDF. Returns the path to put in the source. */
const IMAGE_RE = /\.(pdf|png|jpe?g|eps|svg)$/i;
const MOVIE_RE = /\.(mp4|m4v|mov|webm)$/i;

function uniqueTarget(dir, name, src) {
  const ext = path.extname(name), stem = path.basename(name, ext);
  for (let n = 1; ; n++) {
    const cand = path.join(dir, n === 1 ? name : `${stem}-${n}${ext}`);
    if (!fs.existsSync(cand)) return { path: cand, reuse: false };
    try { if (src && fs.statSync(cand).size === fs.statSync(src).size) return { path: cand, reuse: true }; } catch { /* keep looking */ }
  }
}

async function ffmpeg(args, cwd) { return run('ffmpeg', ['-v', 'error', '-y', ...args], cwd, 600000); }

async function makePoster(movie) {
  const r = await ffmpeg(['-i', movie, '-filter_complex',
    '[0:v]format=rgba,split[a][b];[a]drawbox=c=white:t=fill[w];[w][b]overlay,format=rgb24', '-frames:v', '1', movie + '.png'], path.dirname(movie));
  return r.code === 0;
}

async function encodeMp4(input, out, { glob = false, fps = 10 } = {}) {
  const args = glob ? ['-framerate', String(fps), '-pattern_type', 'glob', '-i', input] : ['-i', input];
  args.push('-filter_complex', '[0:v]format=rgba,split[a][b];[a]drawbox=c=white:t=fill[w];[w][b]overlay,pad=ceil(iw/2)*2:ceil(ih/2)*2:color=white,format=yuv420p',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-movflags', '+faststart', '-an', out);
  const r = await ffmpeg(args, path.dirname(out));
  return r.code === 0 && fs.existsSync(out);
}

function safeName(n) { return n.replace(/[\s#%&{}\\$~^]+/g, '-'); }

async function importMedia(texPath, src) {
  const dir = path.join(path.dirname(texPath), 'figures');
  fs.mkdirSync(dir, { recursive: true });
  const st = fs.statSync(src);
  const notes = [];
  let target, kind;
  if (st.isDirectory()) {                                        // a folder of frames
    const frames = fs.readdirSync(src).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
    if (!frames.length) throw new Error('That folder has no PNG or JPEG frames.');
    const ext = path.extname(frames[0]);
    target = uniqueTarget(dir, safeName(path.basename(src)) + '.mp4');
    if (!await encodeMp4(path.join(src, '*' + ext), target.path, { glob: true })) throw new Error('ffmpeg could not encode the frames (is ffmpeg installed?).');
    notes.push(`${frames.length} frames at 10 fps`);
    kind = 'movie';
  } else if (/\.gif$/i.test(src)) {                              // GIF -> mp4
    const same = path.join(dir, safeName(path.basename(src, path.extname(src))) + '.mp4');
    if (fs.existsSync(same) && fs.statSync(same).mtimeMs >= st.mtimeMs) target = { path: same, reuse: true };   // converted before
    else target = uniqueTarget(dir, path.basename(same));
    if (!target.reuse && !await encodeMp4(src, target.path)) throw new Error('ffmpeg could not convert the GIF (is ffmpeg installed?).');
    if (!target.reuse) notes.push('GIF converted to mp4');
    kind = 'movie';
  } else if (MOVIE_RE.test(src) || IMAGE_RE.test(src)) {
    target = uniqueTarget(dir, safeName(path.basename(src)), src);
    if (!target.reuse) fs.copyFileSync(src, target.path);
    kind = MOVIE_RE.test(src) ? 'movie' : 'image';
  } else {
    throw new Error('Drop an image (pdf, png, jpg, eps, svg), a movie (mp4, mov, webm), a GIF, or a folder of frames.');
  }
  if (kind === 'movie' && !fs.existsSync(target.path + '.png')) {
    if (!await makePoster(target.path)) notes.push('no poster (is ffmpeg installed?)');
  }
  if (target.reuse) notes.push('already in figures/');
  return { rel: './' + path.relative(path.dirname(texPath), target.path).split(path.sep).join('/'), kind, notes };
}

/* Make sure LaTeX finds slidemovie.sty: copy the bundled one next to the deck if not. */
async function ensureSlidemovieSty(texPath, bundled) {
  const dir = path.dirname(texPath);
  const r = await run('kpsewhich', ['slidemovie.sty'], dir, 20000);
  if (r.code === 0 && r.out.trim()) return false;
  if (!bundled || !fs.existsSync(bundled)) return false;
  fs.copyFileSync(bundled, path.join(dir, 'slidemovie.sty'));
  return true;
}

module.exports = { pageFrameIndices, cleanBuildDir, vrbMapper, importMedia, ensureSlidemovieSty, listFiles, scanMacros, findSource, parseFrames, frameAtLine, compileFrame, compileDeck, saveSource, loadSync, pageFrames, frameKey, parseLog, buildDir, vrbToSource };
