---
name: visual-design
description: Design graphics, logos, social posts, banners, posters and UI mockups as editable SVG or HTML/CSS, and export them at the exact sizes and formats needed.
---
# Visual design

## Start from the brief
Audience, platform, size, text, brand colours and fonts. Common sizes: Instagram post 1080×1080,
story 1080×1920, X/LinkedIn image 1200×675, YouTube thumbnail 1280×720, OG image 1200×630,
A4 print 2480×3508 at 300 dpi.

## System
- Palette: 1 brand colour, 1 accent, neutrals; check text contrast ≥ 4.5:1.
- Type: one family, two or three sizes on a clear scale (e.g. 64/32/20); fonts installed: Inter,
  JetBrains Mono, Noto (CJK, emoji) - `fc-list : family | sort -u`.
- Grid and margins (8 px steps); align everything; leave space.

## Build editable sources
- Vector art and logos: write SVG by hand or generate it in code; keep text as `<text>` with the
  font named. Render: `convert -background none -density 300 art.svg -resize 1080x1080 art.png`.
- Layouts with real text (posters, posts, mockups): HTML + CSS at the exact size, then screenshot:
  `chromium --headless --hide-scrollbars --window-size=1080,1080 --screenshot=post.png post.html`.
- Photo edits: ImageMagick (see image-basics) or GIMP for hands-on retouching.
- Look at a real picture for reference first when the user names a style, brand or character.

## Deliver
PNG for graphics with text, JPEG for photos, SVG for logos and icons, PDF for print. Hand over the
source file too. Look at the export at 100% and at phone size before calling it done.
