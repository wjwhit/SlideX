#!/bin/bash
# Builds the SlideX wordmarks and superscript icon mark from their LaTeX sources.
set -euo pipefail
cd "$(dirname "$0")"
render() {
  local name=$1 dpi=$2 source=$3
  if command -v pdftocairo >/dev/null 2>&1; then
    pdftocairo -svg "$name.pdf" "$name.svg"
    pdftocairo -png -r "$dpi" -singlefile -transp "$name.pdf" "$name"
  else
    latex -interaction=nonstopmode -halt-on-error -jobname="$name" "$source" >/dev/null
    dvisvgm --no-fonts --bbox=papersize --output="$name.svg" "$name.dvi"
    gs -q -dSAFER -dBATCH -dNOPAUSE -sDEVICE=pngalpha -r"$dpi" \
      -dTextAlphaBits=4 -dGraphicsAlphaBits=4 -sOutputFile="$name.png" "$name.pdf"
    rm -f "$name.dvi"
  fi
}
for v in dark:ink light:white; do
  name=${v%%:*}; color=${v##*:}
  pdflatex -interaction=nonstopmode -jobname=wordmark-$name "\def\inkcolor{$color}\input{wordmark}" >/dev/null
  render "wordmark-$name" 300 "\def\inkcolor{$color}\input{wordmark}"
  rm -f wordmark-$name.aux wordmark-$name.log
done
pdflatex -interaction=nonstopmode -halt-on-error iconmark.tex >/dev/null
render iconmark 600 '\input{iconmark}'
rm -f iconmark.aux iconmark.log
cp wordmark-light.svg ../../viewer/wordmark-light.svg
python3 ../../app/make_icon.py
echo "built wordmarks, icon mark, viewer logo and app icons"
