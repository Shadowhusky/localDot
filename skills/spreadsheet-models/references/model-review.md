# Review a model before delivery

Start with the decision the workbook supports, source data, currency, units and period. Preserve raw inputs separately. Build formulas around named assumptions and show provenance beside imported data. Make uncertain assumptions adjustable rather than presenting a point estimate as fact.

Use the installed spreadsheet engine for recalculation; writing formula strings is not proof of calculated values. Check representative cells against independent arithmetic, balance totals, units, signs and date boundaries. Exercise a small sensitivity change: dependent outputs should move in the expected direction and then return when the input is restored. Inspect blanks, zero denominators and missing rows; do not silently treat unknowns as zero.

Preview the dense sheet at useful zoom and inspect print/export boundaries, clipped headers and number formats. Keep live formulas and readable notes in the editable file. Financial-analysis handles interpretation; data-analysis handles larger inputs. For large datasets select columns, inspect a sample and use columnar/streaming processing rather than loading the entire file into model context. Deliver the workbook and an explanation of assumptions, checks and limits.
