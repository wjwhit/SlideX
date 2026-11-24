# Frames for the editor

[Documentation](README.md) > Frames for the editor

The [editor](editor.md) matches source lines and slide content through
SyncTeX. Beamer collects a normal frame's whole body before typesetting it, so
SyncTeX points everything on the slide at the frame's last line. Fragile frames
are different: beamer writes their body to a `.vrb` file and reads it back
line by line, so each line can be traced.

The `slidexframes` package (in [`latex/`](../latex/slidexframes.sty), and
bundled with SlideX) provides fragile frame environments that look exactly
like ordinary frames:

```latex
\usepackage{slidexframes}
...
\begin{sframe}{label=figure}{Figures, boxes and captions}
	...
\end{sframe}

\begin{sframe}{}{}          % no options, no title
	\titlepage
\end{sframe}

\begin{sbackup}{}{Backup: where the example media came from}
	...
\end{sbackup}
```

- `sframe{<frame options>}{<title>}`: a frame. The options are beamer's
  (`label=`, `t`, `c`, `plain`, ...); labels are optional.
- `sbackup{<frame options>}{<title>}`: a backup slide, not counted in the frame
  numbers. The first one starts the appendix, so put them last.
- `\newslidexframe{<name>}{<extra frame options>}` defines your own, for
  example `\newslidexframe{wideframe}{plain}`.

Rules: the title goes on the `\begin` line, with nothing after it there, and
`\end{sframe}` stands alone on its line.

What the package changes, so the output stays identical to an ordinary frame:

- each frame gets its own `.vrb` file, named after its `\begin` line
  (`<job>-L<line>.vrb`), so SlideX can map every line (beamer would reuse one
  file);
- a mark after the title makes beamer copy the body verbatim from the `\begin`
  line (otherwise leading comment lines are dropped);
- the body's last paragraph ends before the frame's group closes.

The package was checked on a 41-page research talk: converting every frame
gave a pixel-identical PDF.

Neither package is required. A plain beamer deck presents and edits as it
is; add `slidexframes` for line-by-line highlighting, and
[`slidemovie`](movies.md) only if the deck has movies or GIFs. SlideX adds its
bundled `latex/` folder to `TEXINPUTS` when it compiles, so either package
works in the editor without copying anything. To build the deck outside
SlideX, copy the `.sty` files you use next to your `.tex`, or set `TEXINPUTS`
as in the comment at the top of [`example/demo.tex`](../example/demo.tex).

Plain `\begin{frame}[fragile]` frames, and ordinary frames, also compile and
preview in the editor; the highlight then covers the whole frame instead of
the line.
