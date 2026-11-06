#!/bin/zsh
# Cut-outs from the Codex renders: the faint alpha haze around each dropped, trimmed to the dot with a margin.
cd "${0:A:h}"
echo "{" > dots.json
first=1
for n in coder researcher finance video designer everyday; do
  magick src/$n.png -channel A -level 4%,100% +channel -trim +repage -bordercolor none -border 16 dot-$n.png
  dims=$(magick identify -format "%w %h" dot-$n.png)
  w=${dims% *}; h=${dims#* }
  [[ $first -eq 1 ]] || echo "," >> dots.json
  first=0
  printf '  "%s": { "w": %s, "h": %s }' $n $w $h >> dots.json
done
echo "\n}" >> dots.json
cat dots.json
# Specks the render left apart from the dot go.
for n in coder researcher finance video designer everyday; do
  magick dot-$n.png \( +clone -alpha extract \( +clone -threshold 1% -define connected-components:area-threshold=200 -define connected-components:mean-color=true -connected-components 8 \) -compose multiply -composite \) -alpha off -compose copy_opacity -composite dot-$n.png
done
