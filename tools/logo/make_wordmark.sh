#!/bin/bash
# Builds the SlideX wordmark: dark ink (light backgrounds) and white (dark backgrounds).
set -euo pipefail
cd "$(dirname "$0")"
for v in dark:ink light:white; do
  name=${v%%:*}; color=${v##*:}
  pdflatex -interaction=nonstopmode -jobname=wordmark-$name "\def\inkcolor{$color}\input{wordmark}" >/dev/null
  pdftocairo -svg wordmark-$name.pdf wordmark-$name.svg
  pdftocairo -png -r 300 -singlefile -transp wordmark-$name.pdf wordmark-$name
  rm -f wordmark-$name.aux wordmark-$name.log
done
echo "built wordmark-dark.{pdf,svg,png} and wordmark-light.{pdf,svg,png}"
