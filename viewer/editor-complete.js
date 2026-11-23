/* SlideX editor: LaTeX completion for CodeMirror 6.
 *   \com...            commands: common LaTeX/beamer/math ones plus the deck's own
 *   \begin{ / \end{    environments, \begin also writes the matching \end
 *   \ref{ \hyperlink{ ...    labels (\label{...} and frame label=...)
 *   \includegraphics{ \slidemovie{ \input{    files near the deck, with thumbnails
 *   \includegraphics[ \slidemovie[            option keys
 * window.SlidexComplete.extension(getInfo) returns the CodeMirror extension;
 * getInfo() gives {files, baseUrl, commands, environments} (see app/editor.js). */
'use strict';

(function () {
  const C = (name, args = 0, detail = '') => ({ name, args, detail });
  const COMMANDS = [
    // structure and beamer
    C('section', 1), C('subsection', 1), C('frametitle', 1), C('framesubtitle', 1), C('title', 1), C('subtitle', 1),
    C('author', 1), C('institute', 1), C('date', 1), C('titlepage'), C('tableofcontents'), C('maketitle'),
    C('pause'), C('only', 1, '<n>{...}'), C('uncover', 1, '<n>{...}'), C('visible', 1, '<n>{...}'), C('invisible', 1),
    C('alert', 1), C('onslide', 0, '<n>'), C('item'), C('note', 1), C('againframe', 1), C('hyperlink', 2), C('hypertarget', 2),
    C('beamergotobutton', 1), C('usetheme', 1), C('usecolortheme', 1), C('setbeamertemplate', 2), C('setbeamercolor', 2),
    C('setbeamerfont', 2), C('column', 1), C('appendix'), C('label', 1), C('ref', 1), C('eqref', 1), C('cite', 1), C('url', 1), C('href', 2),
    // text
    C('textbf', 1), C('textit', 1), C('emph', 1), C('texttt', 1), C('textsc', 1), C('textrm', 1), C('textsf', 1), C('underline', 1),
    C('textcolor', 2), C('color', 1), C('colorbox', 2), C('fbox', 1), C('mbox', 1), C('makebox', 1), C('parbox', 2), C('raisebox', 2),
    C('footnote', 1), C('centering'), C('raggedright'), C('raggedleft'), C('par'), C('newline'), C('linebreak'),
    C('tiny'), C('scriptsize'), C('footnotesize'), C('small'), C('normalsize'), C('large'), C('Large'), C('LARGE'), C('huge'), C('Huge'),
    C('bfseries'), C('itshape'), C('ttfamily'), C('sffamily'), C('rmfamily'), C('scshape'),
    // space and size
    C('vspace', 1), C('hspace', 1), C('vfill'), C('hfill'), C('smallskip'), C('medskip'), C('bigskip'), C('noindent'),
    C('linewidth'), C('textwidth'), C('textheight'), C('paperwidth'), C('columnwidth'), C('setlength', 2), C('addtolength', 2),
    // figures
    C('includegraphics', 1, '[width=...]{file}'), C('slidemovie', 1, '[width=...]{movie}'), C('caption', 1), C('input', 1), C('include', 1),
    C('resizebox', 3), C('scalebox', 2), C('rotatebox', 2),
    // math
    C('frac', 2), C('dfrac', 2), C('tfrac', 2), C('sqrt', 1), C('partial'), C('nabla'), C('cdot'), C('times'), C('pm'), C('mp'),
    C('approx'), C('sim'), C('simeq'), C('propto'), C('equiv'), C('neq'), C('leq'), C('geq'), C('ll'), C('gg'), C('infty'), C('to'),
    C('rightarrow'), C('Rightarrow'), C('leftarrow'), C('mathrm', 1), C('mathbf', 1), C('mathit', 1), C('mathcal', 1), C('mathbb', 1),
    C('boldsymbol', 1), C('operatorname', 1), C('text', 1), C('left'), C('right'), C('big'), C('Big'), C('sum'), C('int'), C('oint'),
    C('lim'), C('exp'), C('ln'), C('log'), C('sin'), C('cos'), C('tan'), C('hat', 1), C('bar', 1), C('tilde', 1), C('vec', 1), C('dot', 1),
    C('ddot', 1), C('overline', 1), C('alpha'), C('beta'), C('gamma'), C('Gamma'), C('delta'), C('Delta'), C('epsilon'), C('varepsilon'),
    C('zeta'), C('eta'), C('theta'), C('Theta'), C('kappa'), C('lambda'), C('Lambda'), C('mu'), C('nu'), C('xi'), C('pi'), C('rho'),
    C('sigma'), C('Sigma'), C('tau'), C('phi'), C('varphi'), C('Phi'), C('chi'), C('psi'), C('Psi'), C('omega'), C('Omega'), C('ell'),
    // tikz
    C('node'), C('draw'), C('fill'), C('path'), C('coordinate'), C('usetikzlibrary', 1),
    // definitions
    C('newcommand', 2), C('renewcommand', 2), C('usepackage', 1), C('documentclass', 1),
  ];
  const ENVS = ['frame', 'itemize', 'enumerate', 'description', 'columns', 'column', 'block', 'alertblock', 'exampleblock',
    'center', 'flushleft', 'flushright', 'figure', 'table', 'tabular', 'minipage', 'tikzpicture', 'scope', 'equation',
    'equation*', 'align', 'align*', 'gather', 'gather*', 'split', 'cases', 'pmatrix', 'bmatrix', 'array', 'quote',
    'verbatim', 'tcolorbox', 'overprint', 'onlyenv', 'thebibliography', 'document'];
  const GRAPHICS_KEYS = ['width=', 'height=', 'scale=', 'angle=', 'trim=', 'clip', 'keepaspectratio', 'page=', 'origin='];
  const MOVIE_KEYS = ['width=', 'height=', 'frame=last', 'frame=middle', 'frame=first', 'noautoplay', 'noloop', 'slider',
    'rate=', 'start=', 'end=', 'audio', 'controls', 'restart', 'poster='];
  const LABEL_CMDS = 'ref|eqref|cref|Cref|autoref|pageref|hyperlink|againframe|label';
  const FILE_CMDS = { includegraphics: /\.(pdf|png|jpe?g|eps|svg)$/i, slidemovie: /\.(mp4|m4v|mov|webm|gif)$/i,
    input: /\.(tex)$/i, include: /\.(tex)$/i, bibliography: /\.(bib)$/i };

  function labelsIn(text) {
    const out = new Set();
    for (const m of text.matchAll(/\\label\{([^}]+)\}/g)) out.add(m[1]);
    for (const m of text.matchAll(/(?:^|[\[{,])\s*label\s*=\s*([^,\]}\s]+)/gm)) out.add(m[1]);
    return [...out].sort();
  }

  /* A command's snippet: \name{} for each argument, cursor in the first. */
  function applyCommand(name, args) {
    return (view, completion, from, to) => {
      const insert = name + '{}'.repeat(args);
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + name.length + (args ? 1 : 0) } });
    };
  }

  function thumbnail(info, file) {
    return () => {
      const box = document.createElement('div');
      box.className = 'cm-thumb';
      const url = info.baseUrl + file.split('/').map(encodeURIComponent).join('/');
      if (/\.(png|jpe?g|gif|svg)$/i.test(file)) {
        const img = document.createElement('img'); img.src = url; box.appendChild(img);
      } else if (/\.(mp4|m4v|mov|webm)$/i.test(file)) {
        const poster = info.files.find((f) => f === file + '.png');
        if (poster) { const img = document.createElement('img'); img.src = info.baseUrl + poster.split('/').map(encodeURIComponent).join('/'); box.appendChild(img); }
        else { const v = document.createElement('video'); v.src = url; v.muted = true; v.preload = 'metadata'; box.appendChild(v); }
      } else if (/\.pdf$/i.test(file) && window.pdfjsLib) {
        const c = document.createElement('canvas'); box.appendChild(c);
        pdfjsLib.getDocument({ url, isEvalSupported: false }).promise.then((doc) => doc.getPage(1)).then((page) => {
          const vp1 = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: 360 / vp1.width });
          c.width = vp.width; c.height = vp.height;
          return page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        }).catch(() => { box.textContent = file; });
      } else box.textContent = file;
      return box;
    };
  }

  function source(getInfo) {
    return (ctx) => {
      const info = getInfo() || { files: [], commands: [], environments: [], baseUrl: '' };
      const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 300), ctx.pos);

      // \begin{env  /  \end{env
      let m = /\\(begin|end)\{([A-Za-z*]*)$/.exec(before);
      if (m) {
        const from = ctx.pos - m[2].length;
        const names = [...new Set([...info.environments.map((e) => e.name), ...ENVS])];
        return { from, validFor: /^[A-Za-z*]*$/, options: names.map((n) => {
          const user = info.environments.find((e) => e.name === n);
          return {
            label: n, type: 'type', detail: user ? `defined in the deck (${user.args} arg${user.args === 1 ? '' : 's'})` : '',
            apply: m[1] === 'end' ? n + '}' : (view, c, f, t) => {
              // \begin{env}{args...} on this line, an indented empty line, \end{env}
              const line = view.state.doc.lineAt(f);
              const indent = /^\s*/.exec(line.text)[0];
              const end = view.state.sliceDoc(t, t + 1) === '}' ? t + 1 : t;   // reuse a typed }
              const args = user ? '{}'.repeat(user.args) : '';
              const head = n + '}' + args;
              const insert = head + '\n' + indent + '\t\n' + indent + '\\end{' + n + '}';
              const anchor = user && user.args ? f + n.length + 2 : f + head.length + 1 + indent.length + 1;
              view.dispatch({ changes: { from: f, to: end, insert }, selection: { anchor } });
            },
          };
        }) };
      }

      // \ref{label
      m = new RegExp(`\\\\(?:${LABEL_CMDS})\\{([^}\\s]*)$`).exec(before);
      if (m) {
        return { from: ctx.pos - m[1].length, validFor: /^[^}\s]*$/,
          options: labelsIn(ctx.state.doc.toString()).map((l) => ({ label: l, type: 'constant' })) };
      }

      // \includegraphics[..]{file  /  \slidemovie{  /  \input{
      m = /\\(includegraphics|slidemovie|input|include|bibliography)(?:\[[^\]]*\])?\{([^}]*)$/.exec(before);
      if (m) {
        const typed = m[2];
        const dot = typed.startsWith('./') ? './' : '';
        const want = FILE_CMDS[m[1]];
        const files = info.files.filter((f) => want.test(f) && !/\.mp4\.png$|\.(mp4|gif)\.\w+\.png$/.test(f));
        return { from: ctx.pos - typed.length, validFor: /^[^}]*$/, options: files.map((f) => ({
          label: dot + f, type: 'text', info: thumbnail(info, f),
          apply: (view, c, from, to) => {
            const ins = (m[1] === 'input' || m[1] === 'include') ? (dot + f).replace(/\.tex$/, '') : dot + f;
            view.dispatch({ changes: { from, to, insert: ins }, selection: { anchor: from + ins.length } });
          },
        })) };
      }

      // \includegraphics[key  /  \slidemovie[key
      m = /\\(includegraphics|slidemovie)\[([^\]]*)$/.exec(before);
      if (m) {
        const word = /[^,=\s]*$/.exec(m[2])[0];
        const keys = m[1] === 'slidemovie' ? MOVIE_KEYS : GRAPHICS_KEYS;
        return { from: ctx.pos - word.length, validFor: /^[^,=\s\]]*$/,
          options: keys.map((k) => ({ label: k, type: 'property' })) };
      }

      // \command
      m = /\\([A-Za-z@]*)$/.exec(before);
      if (m && (m[1].length || ctx.explicit)) {
        const seen = new Set();
        const opts = [];
        for (const c of [...info.commands.map((c) => ({ ...c, user: true })), ...COMMANDS]) {
          if (seen.has(c.name)) continue;
          seen.add(c.name);
          opts.push({ label: '\\' + c.name, type: c.user ? 'function' : 'keyword', boost: c.user ? 2 : 0,
            detail: c.user ? `deck${c.args ? ', ' + c.args + ' arg' + (c.args > 1 ? 's' : '') : ''}` : (c.detail || ''),
            apply: applyCommand('\\' + c.name, c.args) });
        }
        return { from: ctx.pos - m[1].length - 1, validFor: /^\\[A-Za-z@]*$/, options: opts };
      }
      return null;
    };
  }

  window.SlidexComplete = {
    extension(getInfo) {
      return [CM.autocompletion({ override: [source(getInfo)], activateOnTyping: true, maxRenderedOptions: 60,
        icons: false, defaultKeymap: true })];
    },
  };
})();
