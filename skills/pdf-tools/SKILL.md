---
name: pdf-tools
description: Read, search, extract pages or images from, merge, split, rotate, compress, fill in and OCR PDF files from the terminal.
---
# PDFs from the terminal

poppler-utils is installed (`pdftotext`, `pdfinfo`, `pdfimages`, `pdftoppm`, `pdfseparate`,
`pdfunite`). For anything else, make a virtual environment once and install what you need:
`python3 -m venv ~/.venvs/pdf && ~/.venvs/pdf/bin/pip install pypdf pikepdf`.

## Read
- Pages and metadata: `pdfinfo file.pdf`
- Text with layout kept (tables stay aligned): `pdftotext -layout file.pdf -` (add `-f 3 -l 5` for pages 3–5)
- A page as a picture to look at: `pdftoppm -png -r 110 -f 2 -l 2 file.pdf /tmp/page` then open `/tmp/page-2.png`
- Embedded images: `pdfimages -png file.pdf /tmp/img`
- No text comes out: the PDF is a scan. OCR it (below).

## Change (always write a new file; keep the original)
- Merge: `pdfunite a.pdf b.pdf merged.pdf`
- Split into pages: `pdfseparate file.pdf /tmp/page-%d.pdf`
- Pick, reorder or rotate pages with pypdf:
  ```python
  from pypdf import PdfReader, PdfWriter
  r = PdfReader("in.pdf"); w = PdfWriter()
  for i in [2, 0, 1]: w.add_page(r.pages[i])
  w.pages[0].rotate(90); w.write("out.pdf")
  ```
- Compress: `pikepdf` with `pdf.save("out.pdf", compress_streams=True, object_stream_mode=pikepdf.ObjectStreamMode.generate)`;
  for scan-heavy files, rasterise at 150 dpi and rebuild only when the user accepts lower quality.
- Fill a form: list fields with `r.get_fields()`, then `w.update_page_form_field_values(w.pages[0], {"Name": "Ada"})`
  on a writer built with `PdfWriter(clone_from=r)`; set `w.set_need_appearances_writer(True)` so values show.

## OCR a scan
`~/.venvs/pdf/bin/pip install ocrmypdf` needs the tesseract binary; if `tesseract --version` fails and
`sudo -n true` works, `sudo apt-get install -y tesseract-ocr ocrmypdf`. Then
`ocrmypdf --skip-text in.pdf out.pdf` and read it with `pdftotext`.

## Check before handing over
`pdfinfo out.pdf` (page count as expected) and render one changed page with `pdftoppm` to look at it.
