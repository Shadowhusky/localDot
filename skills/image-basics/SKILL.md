---
name: image-basics
description: Resize, crop, convert, compress, annotate and batch-process images (PNG, JPEG, WebP, GIF, HEIC, SVG) with ImageMagick from the terminal.
---
# Images from the terminal

ImageMagick 6 (`convert`, `mogrify`, `identify`, `montage`) and `cwebp` are installed; GIMP is there
for hands-on edits. Write results to new files; never overwrite the user's originals.

## Look first
- Size, format, colour space: `identify -format '%f %wx%h %m %[colorspace]\n' *.png`
- See it: open the image in the desktop viewer, or make a contact sheet of many:
  `montage *.jpg -thumbnail 240x240 -geometry +6+6 -tile 6x /tmp/sheet.jpg`

## Common jobs
- Fit inside a box, never upscale: `convert in.jpg -resize '1600x1600>' out.jpg`
- Exact size, cropped to fill (social posts, thumbnails): `convert in.jpg -resize 1080x1080^ -gravity center -extent 1080x1080 out.jpg`
- Crop a region: `convert in.png -crop 800x450+120+60 +repage out.png`
- Format: `convert in.heic out.jpg` · `cwebp -q 82 in.png -o out.webp` · SVG to PNG at a size: `convert -background none -density 384 logo.svg -resize 512x512 logo.png`
- Compress a JPEG for the web: `convert in.jpg -strip -interlace Plane -sampling-factor 4:2:0 -quality 82 out.jpg`
- Transparent background from a flat colour: `convert in.png -fuzz 8% -transparent white out.png`
- Text or a watermark: `convert in.jpg -gravity southeast -pointsize 36 -fill 'rgba(255,255,255,0.8)' -font Inter -annotate +24+24 '© 2026' out.jpg`
- A batch into a new folder: `mkdir -p out && mogrify -path out -resize '1200x1200>' -quality 85 *.jpg`
- An animated GIF from frames: `convert -delay 8 -loop 0 frame-*.png -layers Optimize out.gif`

## Check before handing over
`identify` the result (size and format as asked) and look at it. Report the size in KB when the
user cares about weight.
