# Line-by-line highlighting

[Documentation](README.md) > Line-by-line highlighting

The [editor](editor.md) matches source lines and slide content through
SyncTeX. Beamer collects an ordinary frame's whole body before typesetting it,
so SyncTeX would point everything on the slide at the frame's last line.
Fragile frames are different: beamer writes their body to a `.vrb` file and
reads it back line by line, so each line can be traced.

SlideX does this for you, in its own one-slide copy of the deck only: the frame
you are editing is compiled as a fragile frame, ending its last paragraph
inside the frame so the page comes out the same. The `.vrb` lines are then
matched back to your source by their text. Your `.tex` is never changed and
stays ordinary beamer, so it builds anywhere, and no package is needed. On a
41-page research talk every frame compiled this way was pixel-identical to the
full build.

## Which frames

Line by line:

- `\begin{frame}[...]{...}` ... `\end{frame}`, when the `\begin` line holds the
  whole header (options and title, nothing after them) and `\end{frame}`
  stands alone on its line;
- frames that are already fragile (`[fragile]`, or the `slidexframes`
  environments below);
- your own frame macros that only wrap a frame, like
  ```latex
  \newcommand{\cframe}[3]{\begin{frame}[#1]{#2} #3 \end{frame}}
  ```
  used as `\cframe{label=x}{Title}{` ... `}` with the closing brace alone on
  its line. SlideX reads the macro's definition (in the deck, its `\input`
  files or `.sty` files beside it) to make sure it is such a wrapper.

Highlighted as a whole frame (they still compile and preview):

- frames with an overlay specification on `\begin{frame}<...>`;
- frames whose header spans lines, or whose `\end{frame}` shares its line;
- macros that do more than wrap a frame, for example ones that store frames
  for the appendix.

## The `slidexframes` package (optional)

[`latex/slidexframes.sty`](../latex/slidexframes.sty), bundled with SlideX,
has fragile frame environments that look exactly like ordinary frames, and a
backup-slide environment. You do not need it for the editor; use it if you
like the shorthand, or want fragile frames (for `\verb`) everywhere.

```latex
\usepackage{slidexframes}
\begin{sframe}{label=name}{Title}  ...  \end{sframe}    % a frame
\begin{sbackup}{}{Title}           ...  \end{sbackup}   % a backup slide: unnumbered, starts the appendix
\newslidexframe{wideframe}{plain}                       % your own kind
```

Rules: the title goes on the `\begin` line, with nothing after it there, and
`\end{sframe}` stands alone on its line. SlideX puts its bundled `latex/`
folder on `TEXINPUTS` when it compiles; to build outside SlideX, copy the
`.sty` next to your `.tex`.
