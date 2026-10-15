---
name: financial-analysis
description: Analyse a company or an investment from its filings, statements and prices - growth, margins, ratios, cash flow and simple valuations - with every figure sourced and dated.
---
# Financial analysis

## Get the numbers
- Public US companies: SEC EDGAR. Company facts JSON (XBRL) is the cleanest source:
  `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json` (10-digit CIK; find it with
  `https://www.sec.gov/cgi-bin/browse-edgar?company=NAME&type=10-K`). Send a descriptive
  User-Agent header with the request, as SEC requires.
- Other markets: the company's investor-relations annual report (PDF; read tables with
  `pdftotext -layout`), or the official regulator's filings.
- Prices and FX: an official or widely used source; note the timestamp and currency.
- Record source, period (FY/quarter, fiscal year end) and units (thousands vs millions) for each figure.

## Analyse (in a spreadsheet, formulas live)
- Growth: revenue, operating income, EPS year over year and CAGR `=(end/start)^(1/years)-1`.
- Margins: gross, operating, net. Returns: ROE, ROIC. Cash: operating cash flow, free cash flow
  (OCF − capex), cash conversion (FCF / net income).
- Balance sheet: net debt, current ratio, debt / EBITDA, interest cover.
- Valuation: P/E, EV/EBITDA, FCF yield against peers; a simple DCF with explicit growth, margin,
  discount rate and terminal assumptions, plus a sensitivity table.

## Present
Lead with what the numbers say in plain words; show a compact table and a chart; list assumptions
and sources with dates. Flag one-offs, restatements and currency effects. When asked whether to buy
or sell, give the analysis and say it is not personal financial advice.
