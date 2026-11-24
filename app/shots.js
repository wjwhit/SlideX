// Documentation screenshots: `SlideX --shots <out dir> <deck.pdf>` (from source:
// `npm run sync-viewer && npx electron . --shots ../docs/images ../example/demo.pdf`).
// Drives the example deck through the features shown in docs/ and saves one
// PNG per view, 1400 px wide. Windows stay off screen; the source file is
// never saved (edits shown in a shot are undone afterwards).
'use strict';
const fs = require('fs');
const path = require('path');

const WIDTH = 1400;

module.exports = async function shots(ctx) {
  const { outDir, pdf, openDeck, openEditor, showWelcome, editorWindowFor, deckChildren, app } = ctx;
  fs.mkdirSync(outDir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const saved = [];
  async function shot(win, name, crop) {
    await wait(250);
    let img = await win.webContents.capturePage(crop);
    if (img.getSize().width > WIDTH) img = img.resize({ width: WIDTH, quality: 'best' });
    fs.writeFileSync(path.join(outDir, name + '.png'), img.toPNG());
    saved.push(name);
    console.log('SHOT', name, img.getSize().width + 'x' + img.getSize().height);
  }

  // the source, put back exactly at the end (the presenter moves .json notes into it)
  const texPath = pdf.replace(/\.pdf$/i, '.tex');
  const texOrig = fs.existsSync(texPath) ? fs.readFileSync(texPath, 'utf8') : null;
  // a full build first: the slide strip and page numbers come from it
  if (texOrig != null) await require('./editor').compileDeck(texPath);
  // speaker notes for the presenter shot (example/*.notes.json is not committed)
  fs.writeFileSync(pdf + '.notes.json', JSON.stringify({ version: 1, notes: {
    'slide 2': 'Start the movie talk here. Point at the clock: it keeps running when the bullets appear.',
    'slide 3': 'Half speed on the left; the right one waits for a click.',
  } }, null, 2));

  // welcome, with only the example deck in its recent list (yours is put back after)
  const recentWas = ctx.prefs && ctx.prefs.get('slidex.recent');
  if (ctx.prefs) ctx.prefs.set('slidex.recent', [{ pdf, tex: pdf.replace(/\.pdf$/, '.tex'), time: Date.now() - 3600e3 }]);
  const welcome = showWelcome({ hidden: true });
  welcome.setContentSize(940, 600);
  await new Promise((r) => welcome.webContents.once('did-finish-load', r));
  await wait(600);
  await shot(welcome, 'welcome');
  welcome.close();
  if (ctx.prefs) ctx.prefs.set('slidex.recent', recentWas || []);

  // the deck
  const deck = openDeck(pdf, { hidden: true });
  deck.setContentSize(1440, 810);
  await new Promise((r) => deck.webContents.once('did-finish-load', r));
  const djs = (code) => deck.webContents.executeJavaScript(code);
  await wait(1500);
  const goto = async (page) => { await djs(`slidex.goto(${page - 1})`); await wait(1800); };
  const moveTo = (fx, fy) => djs(`(() => { const r = slidex.viewFor.main.div.getBoundingClientRect();
    const ev = new MouseEvent('mousemove', { clientX: r.left + ${fx} * r.width, clientY: r.top + ${fy} * r.height, bubbles: true });
    document.dispatchEvent(ev); document.querySelector('.movies video') && document.getElementById('stage').dispatchEvent(ev); })()`);

  await goto(4);                                             // movie, step 3
  await moveTo(0.33, 0.45);
  await wait(400);
  await shot(deck, 'present-movie');

  await goto(6);                                             // figure slide
  await djs(`toggleSlides(true)`); await wait(1500);
  await shot(deck, 'slides-panel');
  await djs(`toggleSlides(false)`);

  await djs(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }))`);
  for (let i = 0; i <= 12; i++) { await moveTo(0.22 + 0.012 * i, 0.62 - 0.018 * i); await wait(12); }
  await shot(deck, 'laser');
  await djs(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }))`);
  await moveTo(0.2, 0.36); await wait(900);
  await shot(deck, 'magnifier');
  await djs(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

  // presenter window
  await goto(3);
  await djs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }))`);
  await wait(2500);
  const pres = [...(deckChildren.get(deck.id) || [])][0];
  if (pres) {
    pres.setContentSize(1440, 860);
    await wait(1800);
    await shot(pres, 'presenter');
    pres.close();
  }

  // the editor
  await openEditor(deck);
  const ew = editorWindowFor(deck);
  ew.setContentSize(1600, 960);
  const ejs = (code) => ew.webContents.executeJavaScript(code);
  for (let i = 0; i < 80; i++) { await wait(250); if (await ejs('!!(window.S && S.preview && S.preview.page && !S.compiling)')) break; }
  await ejs(`try { localStorage.setItem('slidex.outputHeight', 170); document.getElementById('output').style.height = '170px'; } catch {}`);
  const settle = `(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); await sleep(700);
    for (let i = 0; i < 80 && (S.compiling || S.stale); i++) await sleep(100); await sleep(500); })()`;
  const toFrame = (label, k) => ejs(`(async () => { const f = S.frames.find((x) => x.label === ${JSON.stringify(label)});
    gotoLine(f.bodyStart + ${k}, false); })()`).then(() => ejs(settle));
  const hoverText = (needle) => ejs(`(async () => {
    let line = null; for (let l = S.frame.start; l <= S.frame.end; l++) if (view.state.doc.line(l).text.includes(${JSON.stringify(needle)})) { line = l; break; }
    const b = (await api.boxesForLine(line)).find((x) => x.page === S.preview.page);
    const r = document.getElementById('pagewrap').getBoundingClientRect();
    const ev = { clientX: r.left + (b.x + b.w * 0.35) * pv.scale, clientY: r.top + (b.y + b.h / 2) * pv.scale, bubbles: true };
    document.getElementById('preview').dispatchEvent(new MouseEvent('mousemove', ev));
    return { line, ev };
  })()`);

  await toFrame('movie', 6);                               // cursor on the second \item
  await ejs(`(async () => { S.preview.page = 3; await showPreview(S.preview); })()`); await wait(800);
  await hoverText('Hover the movie'); await wait(700);
  await shot(ew, 'editor');

  // completion
  await ejs(`(() => { const L = view.state.doc.line(cursorLine());
    view.dispatch({ changes: { from: L.to, insert: ' \\\\key' }, selection: { anchor: L.to + 5 }, userEvent: 'input.type' }); })()`);
  await wait(700);
  await shot(ew, 'completion');
  await ejs(`(() => { CM.undo(view); document.querySelector('.cm-tooltip-autocomplete') && view.dispatch({}); })()`);
  await ejs(settle);

  // resize a figure (drag shown mid-way, not applied)
  await toFrame('figure', 3);
  await ejs(`(async () => { await findFigures(); const f = S.figs.find((x) => x.kind === 'figure'); drawFigs(f);
    const h = document.querySelector('.fig-handle').getBoundingClientRect();
    h && document.querySelector('.fig-handle').dispatchEvent(new MouseEvent('mousedown', { clientX: h.left + 5, clientY: h.top + 5, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: h.left - 70, clientY: h.top - 50, bubbles: true })); })()`);
  await wait(300);
  await shot(ew, 'resize-figure');
  await ejs(`(() => { figDrag = null; ghostEl.hidden = true; drawFigs(null); })()`);

  // a box's width handle
  await ejs(`(async () => { const b = S.figs.find((x) => x.kind === 'tcolorbox'); drawFigs(b); })()`);
  await wait(200);
  await shot(ew, 'resize-box');
  await ejs(`drawFigs(null)`);

  // caption menu on the movie slide (the movie has no caption)
  await toFrame('movie', 3);
  await ejs(`(async () => { await findFigures(); const f = S.figs.find((x) => x.kind === 'figure');
    const r = document.getElementById('pagewrap').getBoundingClientRect();
    document.getElementById('preview').dispatchEvent(new MouseEvent('contextmenu', { clientX: r.left + (f.box.x + f.box.w / 2) * pv.scale,
      clientY: r.top + (f.box.y + f.box.h / 2) * pv.scale, bubbles: true, cancelable: true })); })()`);
  await wait(300);
  await shot(ew, 'caption-menu');
  await ejs(`document.querySelector('.ctx-menu').hidden = true`);

  // double-click text to edit it in place
  await toFrame('keybox', 4);
  await ejs(`(async () => { let line = null; for (let l = S.frame.start; l <= S.frame.end; l++) if (/The amplitude grows/.test(view.state.doc.line(l).text)) { line = l; break; }
    await openTextEdit(line); })()`);
  await wait(400);
  await shot(ew, 'edit-text');
  await ejs(`popTa.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

  // an error, shown in the code and the LaTeX output
  await ejs(`(() => { const L = view.state.doc.line(cursorLine()); view.dispatch({ changes: { from: L.to, insert: ' \\\\undefinedmacro' }, userEvent: 'input.type' }); })()`);
  await ejs(settle);
  await shot(ew, 'errors');
  await ejs(`CM.undo(view)`);
  await ejs(settle);

  // find
  await ejs(`(() => { editorCommand('find'); const i = document.querySelector('.cm-search input[name=search]');
    i.value = 'movie'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await wait(500);
  await shot(ew, 'find');

  // the slide sorter: a thumbnail's menu, then the layouts of + New slide
  await ejs(`(() => { const c = document.querySelector('.cm-search [name=close]'); if (c) c.click(); })()`);
  await toFrame('figure', 0);
  await ejs(`(async () => { const t = [...document.querySelectorAll('#strip .thumb')][3]; t.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 200)); const r = t.getBoundingClientRect(); slideMenu(r.left + r.width * 0.6, r.top + 20, 3); })()`);
  await wait(300);
  await shot(ew, 'slide-menu');
  await ejs(`document.querySelector('.ctx-menu').hidden = true`);
  await ejs(`(async () => { const b = document.querySelector('.strip-new'); b.scrollIntoView({ block: 'end' }); await new Promise((r) => setTimeout(r, 200));
    const r = b.getBoundingClientRect(); layoutMenu(r.left + 10, r.top - 330, S.frames.findIndex((f) => f.label === 'figure')); })()`);
  await wait(300);
  await shot(ew, 'new-slide');
  await ejs(`document.querySelector('.ctx-menu').hidden = true`);

  // deck settings, on the title slide
  await ejs(`(() => { const c = document.querySelector('.cm-search [name=close]'); if (c) c.click(); })()`);
  await toFrame('title', 0);
  await ejs(`(async () => { toggleDeckPanel(true); await new Promise((r) => setTimeout(r, 900)); })()`);
  await shot(ew, 'deck-settings');
  await ejs(`toggleDeckPanel(false)`);
  await ejs(settle);

  // moving things: a node, a figure and a column divider mid-drag, then a node moved
  await ejs(`(() => { const c = document.querySelector('.cm-search [name=close]'); if (c) c.click(); })()`);
  await toFrame('place', 2);
  const drag = (pick, dx, dy) => ejs(`(async () => { await waitPreview(); const f = (${pick})(); if (!f) return false;
    S.sel = f; drawFigs(f); await new Promise((r) => setTimeout(r, 50));
    const g = moveEl.getBoundingClientRect();
    moveEl.dispatchEvent(new MouseEvent('mousedown', { clientX: g.left + 6, clientY: g.top + 6, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: g.left + 6 + ${dx}, clientY: g.top + 6 + ${dy}, bubbles: true }));
    return true; })()`);
  const cancel = () => ejs(`(() => { moveDrag = null; colDrag = null; ghostEl.hidden = true; colLbl.textContent = ''; colEl.hidden = true; S.colHover = null; })()`);
  await drag(`() => S.figs.find((f) => f.kind === 'node')`, -150, 95); await wait(200);
  await shot(ew, 'move-node');
  await cancel();
  await drag(`() => S.figs.find((f) => f.kind === 'figure')`, 0, 45); await wait(200);
  await shot(ew, 'move-figure');
  await cancel();
  await ejs(`(async () => { const c = S.cols[0]; if (!c) return; S.sel = null; drawFigs(null); S.colHover = c; colEl.hidden = false; placeCol(c, 0);
    const g = colEl.getBoundingClientRect();
    colEl.dispatchEvent(new MouseEvent('mousedown', { clientX: g.left + 4, clientY: g.top + 20, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: g.left + 4 + 55, clientY: g.top + 20, bubbles: true })); })()`);
  await wait(200);
  await shot(ew, 'move-columns');
  await cancel();
  await ejs(`(async () => { const f = S.figs.find((x) => x.kind === 'node'); S.sel = null;
    await moveItem(f, -45, 30); await waitPreview(); gotoLine(f.line, false);
    await new Promise((r) => setTimeout(r, 300)); await waitPreview();
    const g = S.figs.find((x) => x.kind === 'node'); S.sel = g; drawFigs(g); })()`);
  await wait(400);
  await shot(ew, 'move-result');

  fs.rmSync(pdf + '.notes.json', { force: true });
  if (texOrig != null && fs.readFileSync(texPath, 'utf8') !== texOrig) fs.writeFileSync(texPath, texOrig);
  console.log('SHOTS done:', saved.length);
  app.quit();
};
