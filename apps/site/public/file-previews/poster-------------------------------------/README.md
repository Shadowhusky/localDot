# Blue Hour — jazz night poster

Friday 21 November, 8 pm, The Lantern, free entry.

## Files
- `poster.html` — the print source (A3 trim + 3 mm bleed + crop marks)
- `instagram.html` — the same design re-set for the 4:5 social crop
- `theme.css` — palette, type scale and components shared by both
- `illo.svg` — the geometric illustration (lantern, moon, horizon lines)
- `export/blue-hour-a3.pdf` — A3 print PDF, 313 × 436 mm page, 297 × 420 mm trim
- `export/blue-hour-1080x1350.png` — Instagram image
- `proof.html` — check sheet with both exports side by side

## Design system
Palette (three colours, plus tints of the ink):

| token | value | use |
|---|---|---|
| `--night` | `#0A1430` | ground |
| `--ink` | `#F2EEE3` | type, moon, horizon lines |
| `--amber` | `#F2A03C` | lantern, labels, free-entry badge |

Contrast, measured: ink on night 15.7:1, amber on night 8.5:1, night on the amber
badge 8.5:1, 70 % ink on night 8.0:1 — all above WCAG AA.

Type: Inter Display Black for the title, Inter ExtraBold (800) for the details,
JetBrains Mono for the small labels. Sizes live in `--fs-*` variables per sheet:
A3 title 88 mm / details 13 mm / labels 4 mm; Instagram title 228 px / details
42 px / labels 20 px. Grid: 8 px steps, 22 mm margins on A3, 76/56 px on the
Instagram crop.

## Re-export
```sh
/usr/bin/chromium --headless --no-pdf-header-footer \
  --print-to-pdf=export/blue-hour-a3.pdf poster.html
/usr/bin/chromium --headless --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1080,1350 --screenshot=export/blue-hour-1080x1350.png instagram.html
```
