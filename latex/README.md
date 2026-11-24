# slidemovie: movies in beamer that play

`slidemovie` is a LaTeX package for putting movies and GIFs on beamer slides.
[SlideX](../README.md) plays them in place; every other PDF viewer (Preview,
Skim, Acrobat, a printer) shows a still frame instead, so the PDF always works.

Each movie is a still **poster** image wrapped in a link whose target names the
movie file and its playback options. SlideX reads those links and plays the real
movie exactly on top of the poster.

## Quick start

1. Copy `slidemovie.sty` next to your `.tex` and add `\usepackage{slidemovie}`.
2. Make the still image the PDF shows (needs Python 3 and ffmpeg, `brew install ffmpeg`):
   - mp4: `python3 slidemovie.py poster figures/anim.mp4`
   - GIF: `python3 slidemovie.py encode figures/anim.gif -o figures/anim.mp4`
     (converts it and makes the still)
3. Put it on a slide:
   ```latex
   \slidemovie[width=0.8\linewidth]{figures/anim.mp4}
   ```
4. Compile as usual and open the PDF in SlideX.

Keep the movie at the same path next to the PDF when you move or send the deck.

## Options

```latex
\slidemovie[width=0.8\linewidth]{figures/vorticity.mp4}
\slidemovie[width=5cm, noautoplay, noloop, start=2, end=4]{figures/run.mp4}
\slidemovie[width=\linewidth, rate=0.5, frame=last]{figures/anim.mp4}
```

| Option | Meaning |
|---|---|
| `autoplay` / `noautoplay` | start when the slide appears (default), or on a click |
| `loop` / `noloop` | repeat (default), or play once and hold the last frame |
| `rate=0.5` | playback speed |
| `start=2`, `end=4` | play only this window, in seconds |
| `frame=first\|middle\|last\|<seconds>` | the still shown in the PDF, and in SlideX before a `noautoplay` movie starts |
| `poster=<file>` | use your own still image |
| `slider` | always show the scrub bar (otherwise it appears when the mouse is over the movie) |
| `audio` | play with sound (default muted) |
| `controls` | the browser's own playback bar |
| `continue` / `restart` | on the next overlay step, keep playing (default) or start over |

Anything else (`width`, `height`, `trim`, `clip`, ...) goes to `\includegraphics`
for the poster. Paths are relative to the **PDF**. Beamer overlays work as usual.

The default poster is `<movie>.png`, or `<movie>.<frame>.png` for another frame
(`figures/run.mp4.last.png`). With `frame=` other than `first`, build in three steps:

```bash
pdflatex talk.tex
python3 slidemovie.py posters talk      # makes every missing poster, from talk.smv
pdflatex talk.tex
```

## The helper, `slidemovie.py`

```bash
python3 slidemovie.py posters talk.tex                          # every poster the deck needs
python3 slidemovie.py poster figures/run.mp4 --frame last       # one by hand: run.mp4.last.png
python3 slidemovie.py encode 'frames/*.png' -o run.mp4 --fps 12  # image frames -> mp4 + poster
python3 slidemovie.py encode anim.gif -o anim.mp4               # GIF -> mp4 + poster
python3 slidemovie.py list talk.pdf                             # check that every movie exists
python3 slidemovie.py pack talk.pdf                             # PDF + movies + notes -> one folder and zip, to send
python3 slidemovie.py present talk.pdf                          # present in a browser instead of the app
```

`present` serves the deck on 127.0.0.1 only. If movies live outside the PDF's
folder (`../figures/...`), pass `--root` with a folder that holds both.

## Frames for SlideX's editor mode

The editor highlights source lines on the slide through SyncTeX, which only
works line by line inside **fragile** frames: beamer collects a normal frame's
body (or a macro argument like `\myframe{label}{title}{body}`) before typesetting
it, so everything maps to the frame's last line. `slidexframes.sty`, in this
folder, provides fragile frames that keep the usual look and add what the
editor needs; they were checked to give a pixel-identical deck:

```latex
\usepackage{slidexframes}
\begin{sframe}{label=name}{Title}  ...  \end{sframe}    % a frame; options and label optional
\begin{sbackup}{}{Title}           ...  \end{sbackup}   % a backup slide, unnumbered, in the appendix
\newslidexframe{wideframe}{plain}                       % your own kind
```

Rules: `\end{sframe}` alone on its line; the title on the `\begin` line.
Plain `\begin{frame}[fragile]` frames also compile and preview, with
frame-level highlighting. See [docs/frames.md](../docs/frames.md) for what the
package changes.

## Why not `animate`, `media9` or `multimedia`?

| Approach | Where it plays |
|---|---|
| `animate` (frames + PDF JavaScript) | Acrobat; partly Okular, PDF-XChange, Présentation.app |
| `media9` / `movie15` | old Acrobat; Présentation.app opens the movie in its own view |
| beamer `multimedia` (`\movie`) | pympress, pdfpc (GStreamer), Présentation.app |
| **slidemovie** | SlideX, or any modern browser via `slidemovie.py present`, offline |

## Limits

- A PDF made with `animate` is not played; re-encode its frames with `slidemovie.py encode`.
- GIFs can be restarted but not paused; convert them to mp4 for full control.
- Sound starts only after one key press (a browser rule); movies are muted by default.

## License

MIT, like the rest of SlideX: see [LICENSE](../LICENSE).
