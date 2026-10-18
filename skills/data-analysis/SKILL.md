---
name: data-analysis
description: Inspect and analyze structured datasets, training data and spreadsheets with reproducible Python or SQL workflows. Use for statistics, cleaning, charts, large files, financial datasets and evidence-driven reports.
---

# Data analysis

Start with the user’s question, data origin, units and intended output. Inventory files and sizes before reading them into memory. Check manifests/checksums and inspect a small sample, schema, row counts, nulls, duplicates and date ranges. Do not treat a ZIP or binary dataset as a text document.

Use SQL/DuckDB or chunked/column-selected Python reads when data is large. Work on copies; keep raw inputs immutable. Record transformations in a runnable script or notebook. Avoid uploading private data to external services unless the task authorizes it.

Choose a method appropriate to the question. Separate exploratory patterns from tested hypotheses; state assumptions, missingness, confounding and uncertainty. For model evaluation, prevent train/test leakage and choose splits that reflect time or entities. Validate joins and aggregations with counts and independent totals.

Read current official documentation for unfamiliar methods. Use the spreadsheet and financial-analysis skills for financial models; cite dated inputs and recalculate formulas with a real spreadsheet engine. A library writing formulas does not calculate them.

Render charts with clear units, readable labels and honest axes. Inspect exports at final size. Deliver the result, reproducible analysis and a brief explanation of the supported findings; distinguish estimates from observations and avoid unsupported causal claims.
