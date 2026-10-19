---
name: web-research
description: Answer a question from the web reliably - plan the searches, read primary sources, cross-check facts, note dates and cite every claim.
---

For investigations, use [the evidence loop](references/evidence-loop.md) to track sources, resolve contradictions and stop research when the question is answered.

# Research on the web

## Plan
1. Restate the question and what a good answer needs (numbers, a comparison, a recommendation).
2. Split it into 2–5 sub-questions. Note what would change the answer.

## Search and read
- Use `web_search` with specific terms; add the year for anything that changes ("2026 pricing").
- Prefer primary sources: official sites, documentation, filings, papers, statistics offices,
  the company's own announcement. Treat SEO listicles and aggregators as leads, not evidence.
- Read the page itself with `web_fetch` (or the browser for pages that need it). Quote exact figures.
- Record for each source: title, publisher, date, URL and the exact claim it supports.

## Check
- Confirm every key fact in two independent sources; if they disagree, say so and prefer the
  more primary, more recent one.
- Watch dates: say "as of <date>" for prices, policies, schedules and anything else that moves.
- Never present a guess as a finding. Say what you could not confirm.

## Answer
Lead with the direct answer in a few sentences, then the supporting points with numbered
citations [1], [2] that match a source list with links. Keep opinions separate from facts.
