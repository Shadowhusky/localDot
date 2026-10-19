---
name: spreadsheet-models
description: Build spreadsheet models and trackers as XLSX or ODS with live formulas, an assumptions sheet, scenarios, formatting and charts, then recalculate and check them headless.
---

Before delivery use [model review](references/model-review.md) to recalculate, check assumptions and inspect the actual workbook.

# Spreadsheet models

Write the workbook with openpyxl, then let LibreOffice calculate it.
`python3 -m venv ~/.venvs/xl && ~/.venvs/xl/bin/pip install openpyxl pandas`

## Structure
- Sheet `Inputs`: every assumption in one place, labelled, with units and source. Inputs blue font.
- Calculation sheets reference inputs by cell or defined name, never pasted numbers.
- Sheet `Summary`: the few outputs that answer the question, plus a chart.
- One row per period or item, one column per measure; totals in their own labelled row.

## Write it
```python
from openpyxl import Workbook
from openpyxl.chart import LineChart, Reference
from openpyxl.styles import Font
wb = Workbook(); inp = wb.active; inp.title = "Inputs"
inp.append(["Growth per month", 0.05]); inp["B1"].font = Font(color="1F4E9E"); inp["B1"].number_format = "0.0%"
m = wb.create_sheet("Model"); m.append(["Month", "Revenue"]); m.append([1, 1000])
for r in range(3, 14): m.append([r - 1, f"=B{r-1}*(1+Inputs!$B$1)"])
m["B14"] = "=SUM(B2:B13)"; m["A14"] = "Total"
c = LineChart(); c.title = "Revenue"; c.add_data(Reference(m, min_col=2, min_row=1, max_row=13), titles_from_data=True); m.add_chart(c, "D2")
wb.save("model.xlsx")
```
- Formats: currency `'#,##0.00 [$£-809]'` or `'$#,##0'`, percent `"0.0%"`, dates `"yyyy-mm-dd"`.
- Scenarios: a column per case on `Inputs` and a selector cell the formulas `CHOOSE` from.
- Freeze headers (`m.freeze_panes = "A2"`) and size columns to fit.

## Recalculate and check
openpyxl writes formulas but not their values. Recalculate with LibreOffice, then read results:
`soffice --headless -env:UserInstallation=file:///tmp/lo-$$ --convert-to xlsx --outdir /tmp/recalc model.xlsx`
and `pandas.read_excel("/tmp/recalc/model.xlsx", sheet_name=None)`.
- No `#REF!`, `#DIV/0!`, `#NAME?` anywhere (search every sheet).
- Totals tie out (sum of parts = total; balance sheet balances).
- Change one input and confirm the outputs move the way they should.
Hand over the recalculated file (copy it back over the original you wrote) so values show on open.
