# SlideX

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
  share it), saved next to the PDF.
- **beamer aware:** `show notes on second screen` decks are split automatically;
  internal links (navigation buttons, `\hyperlink`) work.
- Fully offline. macOS on Apple silicon for now.

## Install

Download `SlideX-<version>-arm64.dmg` (see Releases, or build it below), open it
and drag SlideX to Applications. SlideX is not notarized by Apple yet, so the
first open needs one step: System Settings > Privacy & Security > "Open Anyway".

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

Speaker notes are saved as `<deck>.pdf.notes.json` next to the PDF, keyed by
beamer's frame number, so every overlay step of a slide shows the same note.

## Building

Needs Node.js (and Python 3 with Pillow for the icon).

```bash
cd app
npm install
node node_modules/electron/install.js   # only if npm skipped Electron's binary download
npm start                               # run from source
npm run dmg                             # build app/dist/SlideX.app and SlideX-<version>-arm64.dmg
```

The build is signed ad hoc. `SlideX.app/Contents/MacOS/SlideX --selftest deck.pdf`
opens a deck off screen and reports what it plays (`SLIDEX_SELFTEST_PAGES=4,10`
visits pages, `SLIDEX_SELFTEST_PNG=out.png` saves screenshots,
`SLIDEX_SELFTEST_NOTES=1` checks saving notes).

## How it works

- `viewer/`: the presenter itself, plain HTML and JavaScript. pdf.js 3.11.174
  (vendored, Apache-2.0) draws the pages; `viewer.js` places `<video>` elements
  on the movie links, runs navigation and the presenter window (synced over a
  `BroadcastChannel`); `tools.js` has the laser, magnifier, toolbars and notes.
- `app/`: the Electron shell (Electron 45). `main.js` runs a small local HTTP
  server (byte ranges for video, and writes only to `*.pdf.notes.json`), opens
  windows, places the presenter window on a second display, and handles Finder
  and Dock opens. `build.js` assembles the app bundle from the installed
  Electron; `make_dmg.sh` makes the disk image.
- `latex/`: the `slidemovie` package and its helper script (see
  [latex/README.md](latex/README.md)).
- `example/`: a demo deck (`TEXINPUTS=../latex: pdflatex demo.tex`).

`npm run sync-viewer` copies `viewer/` into `app/viewer/` (done by `start` and
`dmg`); edit `viewer/`, not the copy.

## Roadmap

- iPad reader: open packed talks, navigate, play movies, present to an external display.
- Apple notarization, so the first open needs no extra step.
- Ideas: an assisted beamer editor (fast one-slide preview, click a slide to jump
  to its source, drag handles that rewrite sizes, drop-in movies).

## License

MIT, see [LICENSE](LICENSE). pdf.js (in `viewer/vendor/`) is Apache-2.0 and
keeps its own notice; Electron is MIT.
