// SlideX's log: ~/Library/Logs/SlideX/slidex.log (Help > Show Log File).
// Records what is needed to understand a crash or a failure: exceptions in
// the main process, renderer and helper processes that die or hang, errors
// printed in any window's console, pages that fail to load, and a few events
// (decks and editors opened, builds). Native crash dumps are written by
// Electron's crash reporter to the app's Crashpad folder; nothing is uploaded.
// The log is local only; it is cut to its last half when it passes 2 MB.
'use strict';
const fs = require('fs');
const path = require('path');

const MAX = 2 * 1024 * 1024;
let file = null;

function stamp() { return new Date().toISOString().replace('T', ' ').slice(0, 23); }

function write(level, parts) {
  const line = `${stamp()} ${level.padEnd(5)} ${parts.map((p) => (p instanceof Error ? (p.stack || p.message)
    : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  if (level === 'ERROR' || level === 'CRASH') process.stderr.write(line);
  if (!file) return;
  try {
    fs.appendFileSync(file, line);
    if (fs.statSync(file).size > MAX) {                // keep the newer half
      const buf = fs.readFileSync(file);
      const cut = buf.indexOf(10, buf.length / 2);
      fs.writeFileSync(file, buf.subarray(cut + 1));
    }
  } catch { /* logging must never break the app */ }
}

const log = {
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
  crash: (...a) => write('CRASH', a),
  get file() { return file; },
};

/* Call once, before app 'ready'. onWindowGone(win, details) lets the app
 * offer to reload a window whose page crashed. */
function init(app, { crashReporter, onWindowGone } = {}) {
  try {
    const dir = app.getPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'slidex.log');
  } catch { file = null; }
  try { if (crashReporter) crashReporter.start({ uploadToServer: false }); } catch { /* not available */ }
  log.info(`start ${app.getName()} ${app.getVersion()} (Electron ${process.versions.electron}, ${process.platform} ${process.arch})`);

  process.on('uncaughtException', (err) => log.error('main process exception:', err));
  process.on('unhandledRejection', (err) => log.error('main process unhandled rejection:', err instanceof Error ? err : String(err)));

  app.on('render-process-gone', (e, wc, d) => {
    if (d.reason === 'clean-exit') return;
    log.crash(`window process gone: ${d.reason} (exit code ${d.exitCode}) ${safeUrl(wc)}`);
    if (onWindowGone) { try { onWindowGone(wc, d); } catch (err) { log.error(err); } }
  });
  app.on('child-process-gone', (e, d) => {
    if (d.reason === 'clean-exit') return;
    log.crash(`${d.type} process gone: ${d.reason} (exit code ${d.exitCode})${d.name ? ' ' + d.name : ''}`);
  });
  app.on('web-contents-created', (e, wc) => {
    wc.on('console-message', (ev, level, message, line, source) => {
      // Electron passes the details on the event; older versions as arguments
      const lv = typeof level === 'number' ? level : ({ debug: 0, info: 1, warning: 2, error: 3 })[ev.level];
      if (lv < 3) return;
      const msg = message ?? ev.message, ln = line ?? ev.lineNumber, src = source ?? ev.sourceId;
      log.error(`console: ${msg}${src ? ` (${shortUrl(src)}:${ln})` : ''}`);
    });
    wc.on('preload-error', (ev, p, err) => log.error('preload error:', err));
    wc.on('did-fail-load', (ev, code, desc, url, isMain) => { if (isMain && code !== -3) log.error(`page failed to load: ${desc} (${code}) ${shortUrl(url)}`); });
    wc.on('unresponsive', () => log.warn(`window not responding: ${safeUrl(wc)}`));
    wc.on('responsive', () => log.info(`window responding again: ${safeUrl(wc)}`));
  });
}

function shortUrl(u) { return String(u || '').replace(/^http:\/\/127\.0\.0\.1:\d+/, ''); }
function safeUrl(wc) { try { return shortUrl(wc.getURL()); } catch { return ''; } }

module.exports = { log, init };
