<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="tools/logo/wordmark-light.svg">
    <img src="tools/logo/wordmark-dark.svg" alt="SlideX" height="72">
  </picture>
</h1>

A presenter for PDF slides, made for beamer decks. Open the PDF and present: the
slides are drawn sharply at any screen size, movies play in place, and a
presenter window shows the current and next slide, a timer and your notes.

- **Movies that play.** Movies and GIFs placed with the
  [`slidemovie` LaTeX package](latex/README.md) play exactly where they sit on the
  slide, with a scrub bar, frame stepping, and no restart across overlay steps.
- **Presenter window.** Current slide (live), next slide, timer, clock, and a box
  for speaker notes. With a projector connected, the slides go full screen there
  and the presenter view stays on the laptop.
- **Laser pointer and magnifier**, driven from either window and shown on the projector.
- **Speaker notes** typed in the presenter window, one per slide (overlay steps
  share it), saved in the deck's `.tex` as beamer `\note{...}` (or next to the
  PDF when there is no source).
- **beamer aware:** `show notes on second screen` decks are split automatically;
  internal links (navigation buttons, `\hyperlink`) work.
- **Editor.** The deck's LaTeX next to its slides: one-slide compiles in about
  half a second, the source line under the mouse highlighted on the slide and
  back, completion, and figures, movies and boxes resized by dragging them.
- Fully offline. macOS on Apple silicon for now.

![The SlideX editor on the example deck](docs/images/editor.png)

## Documentation

Guides with screenshots, all made with the [example deck](example/demo.tex):

- [Presenting](docs/presenting.md): keys, presenter window, laser, magnifier, slides panel, notes
- [Movies and GIFs](docs/movies.md): the `slidemovie` package, options, posters, sending a deck
- [The editor](docs/editor.md): one-slide compiles, highlighting, completion, resizing, captions, errors
- [Line-by-line highlighting](docs/frames.md): how the editor maps lines, and which frames it can

## Install

Download `SlideX-<version>-arm64.dmg` (see Releases, or build it: see Building), open it
and drag SlideX to Applications. SlideX is not notarized by Apple yet, so the
first open needs one step: System Settings > Privacy & Security > "Open Anyway".

The start window has your recent decks, new decks from templates (a talk, a
short update, the example deck), the example deck to try, and these docs.

## Presenting

Open a PDF with File > Open (Cmd-O), by dropping it on the window or the Dock
icon, or with Finder's "Open With > SlideX". Press `?` for all keys.

| Key | Action |
|---|---|
| → ↓ Space PgDn Enter n | next page (clickers send PgDn) |
| ← ↑ PgUp Backspace p | previous page |
| Home / End, *number* Enter | jump |
| f | full screen |
| s | presenter window |
| Slides (toolbar) | panel of slide thumbnails: click one to go there; Esc closes it |
| l | laser pointer |
| m | magnifier; scroll to change its power |
| e | type speaker notes (presenter window); Esc leaves the box |
| click a movie, k | pause or play; a finished clip replays |
| hover a movie | scrub bar (always shown in the presenter window) |
| [ / ] | step movies one frame back / forward |
| r | restart this slide's movies |
| b or . / w | black / white screen |
| t | reset the timer |
| Esc | turn off the laser or magnifier, close the help; otherwise leave full screen |

The toolbar (laser, magnifier, restart movies) sits under the notes in the
presenter window, and appears at the bottom of the projector while the mouse moves.

Speaker notes are saved in the deck's `.tex`, as a beamer `\note{...}` at the
top of the slide's frame, so every overlay step shows the same note. Beamer
leaves notes out of the slides, so the PDF does not change, and special
characters are escaped, so a note never breaks the build. A PDF without its
`.tex` keeps its notes in `<deck>.pdf.notes.json`; notes found there are moved
into the `.tex` once it exists.

## Editor mode

Open a deck, then File > Edit Source of This Deck (Cmd-E) or the deck
toolbar's **Edit** button: the editor opens the `.tex` with the same name as
the PDF. File > Open LaTeX Source (Shift-Cmd-O) starts from a `.tex` instead,
building it first if its PDF is missing or older.

- **Slide strip** on the left: one thumbnail per frame, drawn from the full
  deck and redrawn after Compile deck. Click one to go to that frame.
- **One slide at a time.** Cmd-Enter compiles only the frame under the cursor,
  from the text in the editor (your file is not saved): about 0.4 to 0.6 s per
  slide. With **Live** on, the slide recompiles half a second after you stop
  typing. Cmd-S saves.
- **Compile deck** (Shift-Cmd-Enter) saves, builds the whole deck, reloads the
  presenter and the strip.
- **Two-way highlighting.** Hover over the preview to highlight the source line
  that made it; put the cursor on a line to outline what it made. Click the
  preview to jump to the line.
- **Present ▶** hides the editor and brings the deck forward on the same slide;
  **Edit** (or Cmd-E) in the deck switches back to the slide you are on. Deck
  and editor follow each other frame by frame.
- **Compile & Present** saves, builds the deck and switches to presenting;
  **Present** switches straight away with the deck as last built.
- **Completion** as you type: LaTeX and beamer commands plus the deck's own
  (`\newcommand`s in the preamble and `\input` files), environments
  (`\begin` writes the `\end`), labels for `\ref`/`\hyperlink`, figure and movie
  paths with thumbnails, and `\includegraphics`/`\slidemovie` options.
- **Resize figures and movies on the preview:** hover one, drag its corner
  handle; `width=`/`height=`/`scale=` are scaled in your own units.
- **Resize boxes:** `tcolorbox` environments and the deck's own box macros
  (any `\newcommand` that draws a `tcolorbox`, e.g. a `\keybox`) get a handle
  on their right edge. A `tcolorbox` gets its `width=` scaled; a macro use is
  wrapped in `\makebox[\linewidth]{\begin{minipage}{0.8\linewidth}...}`, centred,
  and resizing again rescales that width.
- **Click** the preview to show that line in the code; **double-click text** to
  edit its source line in place (Enter applies, Esc cancels). Enter at the end of an `\item`, here or in the code, starts the
  next item; Enter on an empty item ends the list.
- **Move things on the preview:** drag a TikZ node or `textpos` block anywhere
  (its coordinates are rewritten in their own units), a figure or box up or
  down (a `\vspace` pair around it), or a column divider; arrow keys nudge the
  selected item.
- **Slide sorter:** drag thumbnails to reorder frames (sections shown in the
  strip), right-click to duplicate or delete, **+ New slide** from a layout
  (bullets, two columns, figure, title, full-slide image, section, blank),
  written in the deck's own frame style.
- **Spelling:** misspelled words in the text get a red wavy underline (macOS's
  spell checker; LaTeX commands, math, labels and paths are skipped).
- **Deck settings** (toolbar **Deck…**, Shift-Cmd-D): title page fields, theme,
  colour and font themes, aspect ratio, the deck's colours and beamer's colour
  slots, footline, headline and navigation symbols, all written into the
  preamble (also through a style package's options).
- **Right-click a figure or movie** to add or edit its caption.
- **Drop images, movies, GIFs or folders of frames** on the editor: they are
  copied into `./figures/` (GIFs and frames become mp4 with a poster, needs
  ffmpeg) and the `\includegraphics`/`\slidemovie` line is inserted.
- **Find** (Cmd-F): a search bar over the code, with replace.
- Edit menu: undo, redo, cut, copy, paste, select all, find. View menu:
  bigger, smaller and default code text size (Cmd-=, Cmd--, Cmd-0), and the
  editor theme (light, dark, or following macOS).
- Your file is safe: one undo per action, edits made in other programs are
  noticed (Save never overwrites them silently), unsaved edits are recovered
  after a crash, and closing with unsaved edits asks.
- File > Check Deck… before a talk: every movie found, readable and playable.
- Errors and crashes are written to `~/Library/Logs/SlideX/slidex.log`
  (Help > Show Log File); a window whose page crashes offers to reload.
- LaTeX errors are listed under the preview and marked in the code.
- Before the first save in a session, the original source is copied to
  `.slidex/backups/`. Builds go to `.slidex/` next to the deck.

How single slides are fast: SlideX writes a one-slide copy of the document to
`.slidex/` (preamble and everything between frames kept, other frames blanked
so line numbers match, frame and page counters set as in the deck), with the
preamble precompiled. On the test deck the result is pixel-identical to the
full build's pages.

Any frame compiles on its own, with or without a `label=`, and plain
`\begin{frame}` frames are matched to the source **line by line**: in its
one-slide copy SlideX makes the frame fragile, so SyncTeX can follow every line
(see [Line-by-line highlighting](docs/frames.md)). Your `.tex` stays ordinary
beamer and builds anywhere; no package is needed. `slidemovie` is only for
decks with movies (dropping a movie on the editor adds it).

## Building

No DMG? Three ways to get SlideX running from this repository. Each was tested
from a fresh clone on an Apple-silicon Mac with Node.js 25.

**1. Build the app (macOS).** Needs [Node.js](https://nodejs.org) (`brew install node`).

```bash
git clone https://github.com/wjwhit/SlideX.git
cd SlideX/app
npm install        # also downloads Electron (about 100 MB, once)
npm run dmg        # makes app/dist/SlideX.app and app/dist/SlideX-<version>-arm64.dmg
```

Drag `app/dist/SlideX.app` to Applications. A build you make yourself opens
without the "Open Anyway" step. `npm run package` makes only the app, no DMG.

**2. Run from source (any platform Electron supports).** After `npm install`:

```bash
npm start          # opens SlideX straight from the source files
```

This is the quickest loop when changing the code. Packaging (`npm run package`
and `npm run dmg`) uses macOS tools (`ditto`, `PlistBuddy`, `codesign`,
`hdiutil`); `npm start` does not, but it has only been tried on macOS so far.

**3. No install: present in a browser.** Needs only Python 3.

```bash
python3 latex/slidemovie.py present path/to/talk.pdf
```

This opens the same presenter in your web browser, with movies, the presenter
window (`s`), laser, magnifier and notes. Use full screen with `f`.

If `npm install` stops without Electron (`node_modules/electron/dist` missing),
run `node node_modules/electron/install.js`. `SlideX.app/Contents/MacOS/SlideX
--selftest deck.pdf` opens a deck off screen and reports what it plays
(`SLIDEX_SELFTEST_PAGES=4,10` visits pages, `SLIDEX_SELFTEST_PNG=out.png` saves
screenshots, `SLIDEX_SELFTEST_NOTES=1` checks saving notes).

## How it works

- `viewer/`: the presenter itself, plain HTML and JavaScript. pdf.js 3.11.174
  (vendored, Apache-2.0) draws the pages; `viewer.js` places `<video>` elements
  on the movie links, runs navigation and the presenter window (synced over a
  `BroadcastChannel`); `tools.js` has the laser, magnifier, toolbars and notes.
- `app/`: the Electron shell (Electron 45). `main.js` runs a small local HTTP
  server (byte ranges for video, and writes only to `*.pdf.notes.json`), opens
  windows, places the presenter window on a second display, and handles Finder
  and Dock opens. `editor.js` runs the editor's builds, `synctex.js` reads
  SyncTeX, and `notes.js` reads and writes speaker notes as `\note{...}` in the
  deck's `.tex`. `build.js` assembles the app bundle from the installed
  Electron; `make_dmg.sh` makes the disk image.
- `latex/`: the `slidemovie` package and its helper script (see
  [latex/README.md](latex/README.md)).
- `example/`: a demo deck (`TEXINPUTS=../latex: pdflatex demo.tex`).

`npm run sync-viewer` copies `viewer/` into `app/viewer/` (done by `start`,
`package` and `dmg`); edit `viewer/`, not the copy.

## Roadmap

- iPad reader: open packed talks, navigate, play movies, present to an external display.
- Apple notarization, so the first open needs no extra step.

## License

MIT, see [LICENSE](LICENSE). pdf.js (in `viewer/vendor/`) is Apache-2.0 and
keeps its own notice; Electron is MIT.
