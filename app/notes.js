// Speaker notes kept in the deck's .tex, as beamer's \note{...} inside each
// frame (beamer leaves notes out of the slides unless `show notes` is set, so
// the PDF does not change). A note is plain text: special characters are
// escaped on the way in and unescaped on the way out, so typing never breaks
// the build. A new note goes at the top of the frame body. Only the first plain \note{...} of a frame is managed; \note<2>,
// \note[item] and others are left alone.
'use strict';

const ESC = [['\\', '\\textbackslash{}'], ['{', '\\{'], ['}', '\\}'], ['$', '\\$'], ['&', '\\&'],
  ['%', '\\%'], ['#', '\\#'], ['_', '\\_'], ['^', '\\textasciicircum{}'], ['~', '\\textasciitilde{}']];

function escapeTex(s) {
  let out = '';
  for (const ch of s) { const e = ESC.find(([c]) => c === ch); out += e ? e[1] : ch; }
  return out;
}

function unescapeTex(s) {
  let out = '';
  for (let i = 0; i < s.length;) {
    const e = ESC.find(([, t]) => s.startsWith(t, i));
    if (e) { out += e[0]; i += e[1].length; } else { out += s[i]; i++; }
  }
  return out;
}

/* Same length as text, with comments blanked (so braces and \note in them are ignored). */
function clean(text) { return text.replace(/(^|[^\\])%[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length)); }

function matchBrace(text, i) {
  let depth = 0;
  for (let k = i; k < text.length; k++) {
    if (text[k] === '\\') { k++; continue; }
    if (text[k] === '{') depth++;
    else if (text[k] === '}' && --depth === 0) return k;
  }
  return -1;
}

function lineStarts(text) { const s = [0]; for (let i = 0; i < text.length; i++) if (text[i] === '\n') s.push(i + 1); return s; }

/* The managed note of a frame: {from, to, text} (from/to: the \note{...} span,
 * widened to whole lines when it has its own lines), or null. The search runs
 * between the frame's \begin line and its closing line. */
function findNote(text, frame) {
  const starts = lineStarts(text);
  if (frame.end <= frame.start) return null;
  const a = starts[frame.start] ?? text.length;             // line after the \begin line
  const b = starts[frame.end - 1] ?? text.length;           // start of the closing line
  const c = clean(text);
  const re = /\\note\s*\{/g;
  re.lastIndex = a;
  let m;
  while ((m = re.exec(c)) && m.index < b) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(c, open);
    if (close < 0 || close >= b) return null;
    let from = m.index, to = close + 1;
    const ls = c.lastIndexOf('\n', from - 1) + 1;
    const le = c.indexOf('\n', to);
    if (/^\s*$/.test(c.slice(ls, from)) && /^\s*$/.test(c.slice(to, le < 0 ? c.length : le))) {
      from = ls; to = le < 0 ? c.length : le + 1;                // whole lines
    }
    const body = text.slice(open + 1, close).split('\n').map((l, i) => (i ? l.replace(/^\s+/, '') : l)).join('\n');
    return { from, to, text: unescapeTex(body) };
  }
  return null;
}

/* The text with the frame's note set to `note` ('' removes it). */
function setNote(text, frame, note) {
  const old = findNote(text, frame);
  note = (note || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (!note) return old ? text.slice(0, old.from) + text.slice(old.to) : text;
  const starts = lineStarts(text);
  const lineAt = (n) => text.slice(starts[n - 1], (starts[n] ?? text.length + 1) - 1);
  // indent like the frame's first body line, else one deeper than its closing line
  const first = frame.start < frame.end ? lineAt(frame.start + 1) : '';
  const indent = /\S/.test(first) && frame.start + 1 < frame.end ? /^\s*/.exec(first)[0] : (/^\s*/.exec(lineAt(frame.end))[0]) + '\t';
  const body = note.split('\n').map((l, i) => (i && l ? indent : '') + escapeTex(l)).join('\n');
  const block = `${indent}\\note{${body}}\n`;
  if (old) return text.slice(0, old.from) + block + text.slice(old.to);
  if (frame.end <= frame.start) throw new Error('This frame is on one line; notes need a line of their own.');
  // a new note goes first in the frame body: there TeX is between paragraphs,
  // so the note's line breaks add no space to the slide
  const at = starts[frame.start];
  return text.slice(0, at) + block + text.slice(at);
}

/* The smallest {from, to, insert} that turns a into b. */
function change(a, b) {
  if (a === b) return null;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  return { from: p, to: a.length - q, insert: b.slice(p, b.length - q) };
}

module.exports = { findNote, setNote, change, escapeTex, unescapeTex };
