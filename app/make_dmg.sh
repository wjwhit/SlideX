#!/bin/bash
# Build dist/SlideX-<version>-<arch>.dmg: the app, an Applications link,
# first-open instructions, and the LaTeX kit (package, helper, example).
set -euo pipefail
cd "$(dirname "$0")"
ROOT=..
VERSION=$(node -p "require('./package.json').version")
ARCH=$(uname -m)
STAGE=dist/dmg-stage
DMG="dist/SlideX-$VERSION-$ARCH.dmg"

rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE/slidemovie LaTeX kit/example"
ditto dist/SlideX.app "$STAGE/SlideX.app"
ln -s /Applications "$STAGE/Applications"

cp "$ROOT/latex/slidemovie.sty" "$ROOT/latex/slidemovie.py" "$ROOT/latex/README.md" "$STAGE/slidemovie LaTeX kit/"
cp "$ROOT/example/demo.tex" "$ROOT/example/demo.pdf" "$STAGE/slidemovie LaTeX kit/example/"
mkdir -p "$STAGE/slidemovie LaTeX kit/example/media"
cp "$ROOT"/example/media/*.mp4 "$ROOT"/example/media/*.gif "$ROOT"/example/media/*.png "$STAGE/slidemovie LaTeX kit/example/media/"

cat > "$STAGE/Read me first.txt" <<EOF
SlideX $VERSION: a presenter for PDF slides (beamer), with movies that play.

INSTALL
  Drag SlideX onto Applications.

FIRST OPEN (once)
  SlideX is not from the App Store, so macOS asks before the first open:
   1. Double-click SlideX. macOS says it cannot verify the app. Click Done.
   2. Open System Settings > Privacy & Security, scroll down, and click
      "Open Anyway" next to SlideX. Confirm.
  After that it opens normally. (Terminal alternative:
      xattr -dr com.apple.quarantine /Applications/SlideX.app )

  This build runs on Macs with Apple silicon (M1 or later).

USE
  Open a PDF (File > Open, or drag it onto the window or Dock icon).
  Press ? for keys. s opens the presenter window; with a projector
  connected, the slides go full screen there and the presenter view stays
  on the laptop. Hover over a movie for its slider.

  Movies are separate files next to the PDF. To receive a talk, keep the
  folder you were sent intact.

MAKING DECKS
  "slidemovie LaTeX kit" has the LaTeX package (slidemovie.sty), the helper
  (slidemovie.py, needs Python 3 and ffmpeg) and an example. See its README.md.
EOF

hdiutil create -volname "SlideX" -srcfolder "$STAGE" -ov -format UDZO -quiet "$DMG"
rm -rf "$STAGE"
echo "built $DMG ($(du -h "$DMG" | cut -f1))"
