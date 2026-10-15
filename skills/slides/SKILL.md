---
name: slides
description: Create presentation decks as PPTX, ODP or PDF from an outline - consistent theme, one idea per slide, charts and images - with python-pptx, Marp or LibreOffice.
---
# Slides

## Plan
Outline first: title, 1 idea per slide, 10–15 slides for a 10-minute talk. Headlines that say the
point ("Costs fell 18% after the switch"), not topics ("Costs").

## Build
- Editable PowerPoint: `python3 -m venv ~/.venvs/pptx && ~/.venvs/pptx/bin/pip install python-pptx`
  ```python
  from pptx import Presentation
  from pptx.util import Inches, Pt
  p = Presentation(); p.slide_width, p.slide_height = Inches(13.333), Inches(7.5)
  s = p.slides.add_slide(p.slide_layouts[5]); s.shapes.title.text = "Costs fell 18%"
  s.shapes.add_picture("chart.png", Inches(1), Inches(1.6), width=Inches(11))
  p.save("deck.pptx")
  ```
  Keep one theme: same fonts, sizes and colours on every slide; 24 pt minimum body text.
- From Markdown quickly: Marp (`npx @marp-team/marp-cli deck.md --pptx` or `--pdf`), with a theme
  set in the front matter; or `pandoc deck.md -o deck.pptx`.
- ODP or PDF from a PPTX: `soffice --headless --convert-to pdf --outdir out deck.pptx`.

## Check before handing over
Export to PDF and look at every page (`pdftoppm -png -r 50 deck.pdf /tmp/s`): nothing overflows,
text is readable, charts are labelled. Hand over the editable file and the PDF.
