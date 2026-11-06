#!/bin/zsh
# The masters into output/imagegen (never over a file already there), and the files the site and README
# take, into out/ until they are asked for in place.
set -euo pipefail
cd "${0:A:h}"
DRAFT=out/draft
MASTERS="/Volumes/Husky's SSD 4T/Projects/localdot/output/imagegen"
for name in douyin-9x16-zh rednote-3x4-zh landscape-zh landscape-en; do
  to="$MASTERS/localdot-update-real-$name-20261105.png"
  if [[ -e "$to" && "${1:-}" != "--replace-own" ]]; then
    echo "kept existing $to"
  else
    cp "$DRAFT/$name.png" "$to"
    echo "wrote $to"
  fi
done
magick "$DRAFT/douyin-9x16-zh.png" -strip -quality 94 out/cover-zh-9x16.jpg
magick "$DRAFT/rednote-3x4-zh.png" -strip -quality 94 out/cover-zh-3x4.jpg
magick "$DRAFT/landscape-en@2x.png" -filter Lanczos -resize 1280x720! -strip -quality 82 out/poster-update.webp
magick "$DRAFT/landscape-zh@2x.png" -filter Lanczos -resize 1280x720! -strip -quality 82 out/poster-update-zh.webp
magick "$DRAFT/landscape-en@2x.png" -filter Lanczos -resize 1280x720! -strip -quality 90 out/update.jpg
for f in out/*.jpg out/*.webp; do magick identify -format "%f %wx%h %m %b\n" "$f"; done
