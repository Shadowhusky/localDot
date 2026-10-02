# Job: Part 5a plan, first-class providers (user ruling 2026-10-02)

- **Base:** `origin/claude/plan-part5a` at `2c94cd5` (the plan without its report). Then merge `origin/planning`, which carries the spec change below.
- **Branch:** `git checkout -b claude/plan-part5a-providers 2c94cd5`. Commit there and push it. The controller merges this branch in place of `claude/plan-part5a`.
- **Report:** `reports/plan-part5a-providers-report.md`, as the LAST commit, touching only that file.

## The ruling
The user rejected P5a-R4 as written. **xAI, Mistral, DeepSeek, Groq and OpenRouter** become first-class, like Anthropic, OpenAI, Google and Azure:
- each uses its official AI SDK provider package (`@ai-sdk/xai`, `@ai-sdk/mistral`, `@ai-sdk/deepseek`, `@ai-sdk/groq`, and OpenRouter's official `@openrouter/ai-sdk-provider`);
- each gets its own keyd route, as the spec's "Keys" paragraph says.

The other eight (Together, Fireworks, Cerebras, Perplexity, Cohere, DeepInfra, Moonshot and Alibaba) stay on the OpenAI-compatible client, so R4 is narrowed to them. Read the spec's new "First-class providers" paragraph on `origin/planning`.

## Apply
1. **Part 5a plan:** the provider registry, `languageModel`, the capability mapping and usage parsing, the catalog mapping (models.dev ids for these five), the tests and the "Interfaces Part 5b builds on" section.
   - Rewrite P5a-R4 to the narrowed form, with why and the cost if wrong.
   - Pin each package's exact version, checked against the npm registry, and record its licence (all must be Apache-2.0 or MIT).
   - Each provider needs a test that its requests go to its keyd route with the right auth style, and that its usage is counted. Use a fixture and no network.
2. **keyd routes:** read Part 4a's plan (`docs/superpowers/plans/2026-10-01-localdot-core-part4a-keyd-core.md`, Tasks 13 and 14, the LLM bookkeeping and gateway; not yet built, so the plan can change).
   - Decide whether these five need new route kinds, or can use one shared bearer-style kind with a per-provider host, base path and usage parser. Pick the smaller change that still gives each provider its own route (its own host binding, prices and budget line), and record it as `P5a-R…`.
   - If Part 4a's plan must change, edit Tasks 13 and 14 in it, with complete code and tests, and note it in a short `docs/superpowers/plans/2026-10-01-localdot-core-handoff/part4a-providers-amendment.md`.
3. Keep every other part of the 5a plan as it is.

## Verify
Re-run the scratch verification the 5a job used (see `git show origin/claude/plan-part5a:reports/plan-part5a-report.md`), with the five packages installed at their pinned versions from the npm registry: typecheck, Biome, Vitest and hygiene. If Part 4a's plan changed, compile its changed Go code against `origin/feat/core-part4a` in a scratch copy and run its tests. Make no real provider calls.
