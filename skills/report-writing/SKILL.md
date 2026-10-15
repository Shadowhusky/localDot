---
name: report-writing
description: Turn research or analysis into a clear, well-structured report with numbered citations, tables and figures, exported to PDF, DOCX or HTML with pandoc.
---
# Writing a report

## Structure
1. Title, date and a one-paragraph summary that answers the question outright.
2. Key findings as short paragraphs or bullets, each with citations [1].
3. Details: comparison tables, figures, methodology and caveats.
4. Sources: numbered list matching the citations, with title, publisher, date and link.

## Style
Plain words, short sentences, active voice. Numbers with units and dates ("£4.2m in FY2025").
Separate what sources say from your own judgement, and say how confident you are.

## Build it
Write `report.md` (Markdown tables, `![Caption](chart.png)` for figures; make charts with
matplotlib in a venv). Then:
- PDF: `pandoc report.md -o report.pdf --pdf-engine=wkhtmltopdf` if present; otherwise make HTML
  and print it: `pandoc report.md -s --metadata title="..." -o report.html && chromium --headless --print-to-pdf=report.pdf report.html`
- Word: `pandoc report.md -o report.docx` (add `--reference-doc=style.docx` for house styles).
- HTML to share: `pandoc report.md -s --toc -o report.html`.

## Check before handing over
Open the output; every citation number has a source, tables are not cut off, figures render,
and the summary still matches the findings.
