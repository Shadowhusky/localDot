---
name: bookkeeping
description: Tidy personal or small-business money admin - import bank CSV exports, categorise transactions, reconcile balances, track a budget, and make invoices or expense reports as PDF.
---
# Bookkeeping

`python3 -m venv ~/.venvs/books && ~/.venvs/books/bin/pip install pandas openpyxl`

## Import and clean
- Bank exports differ: read the header, then normalise to `date, description, amount, balance`
  with money as integers in pence/cents to avoid float drift. Parse dates explicitly (day-first in
  the UK and EU). Keep the raw file untouched.
- De-duplicate overlapping exports on (date, amount, description, balance).

## Categorise
- Rules first: a table of `pattern → category` (e.g. `TESCO|SAINSBURY → Groceries`), applied
  case-insensitively; show the uncategorised rest to the user rather than guessing wildly.
- Transfers between the user's own accounts are not spending; tag them `Transfer`.

## Reconcile and report
- Opening balance + sum of transactions = closing balance, per account and month. Report any gap
  with the rows around it.
- Monthly summary pivot (category × month), budget vs actual, top merchants. Save as XLSX with a chart.

## Invoices and expense reports
Write the invoice as Markdown or HTML (number, dates, parties, line items, tax, total, payment
details), then `pandoc invoice.md -o invoice.pdf` (or print the HTML to PDF with Chromium headless:
`chromium --headless --print-to-pdf=invoice.pdf invoice.html`). Check every total by recomputing it.
