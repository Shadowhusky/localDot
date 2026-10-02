# Job: write the Part 10 plan: M9 Ship (it ships before M8)

- **Output branch:** made from `origin/planning`, named `claude/plan-part10`. Commit:
  - `docs/superpowers/plans/2026-10-01-localdot-core-part10-ship.md`;
  - `reports/plan-part10-report.md`.
  Push it. Follow `jobs/PLAN-WRITING.md` and `jobs/PROCESS.md`.
- **Format:** the **interface-and-test** format. Give complete code for the installer's integrity checks, `update`'s verification, and anything handling the install token (`#code=`). Label each task's review tier.

## Scope
The M9 row:
- `npx localdot`;
- onboarding;
- `doctor`;
- `update`;
- the docs;
- arm64 CI;
- publishing hygiene.

Read the spec's "Setup and operations", "Repository", "Testing", "Risks and open questions", "Milestones" (and the order note: M9 before M8), and every line naming M9. Include the one-time `#code=` install link the Part 2 ledger defers to M9.

## Inputs
- **The spec.**
- **Part 1** (`origin/main`): the CLI, the daemon and `doctor` as built.
- **Part 2 as built** (`origin/feat/core-part2`): `doctor`'s Docker checks, and the README from its Task 15 plan.
- **The closing interfaces of the later parts:**
  - Part 3;
  - Part 4a;
  - Part 4b (`origin/claude/plan-part4b-fix2`);
  - Part 5a (`origin/claude/plan-part5a-providers`);
  - Part 7 (`origin/claude/plan-part7`);
  - Part 6 and Part 8, if their branches exist.

  Onboarding covers the provider picker and keys, so read Part 5b's branch if it exists. Otherwise define the seam.

## Rules
- **Publishing hygiene:**
  - licences (mediabunny is MPL-2.0, and Selkies is vendored);
  - no avatar names or assets;
  - no secrets;
  - the npm `files` allowlist;
  - provenance;
  - signed tags.
- **Review Focus, each with a pinning test:**
  - a first run on a clean Mac without Docker Desktop;
  - `update` interrupted mid-way;
  - an install link replayed or leaked;
  - the published tarball containing anything outside the allowlist;
  - `doctor` on arm64 versus amd64 images.
- Where the spec is silent, decide, and record it as `P10-R…`.
