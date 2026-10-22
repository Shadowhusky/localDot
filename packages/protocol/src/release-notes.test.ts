import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASE_VERSION } from "./release.ts";
import { releaseNotesProblems } from "./release-notes.ts";

const GOOD = `## What's new

- Updates show their progress and what's new before you install.
- Installing an update only restarts localDot.

## Fixes

- Setup finds Docker Desktop's sign-in helpers again.

## Before you update

- Your computer restarts once; your files and sign-ins stay.
`;

describe("release notes", () => {
  it("accepts the documented shape, with either apostrophe and only some sections", () => {
    expect(releaseNotesProblems(GOOD)).toEqual([]);
    expect(releaseNotesProblems(GOOD.replace("What's", "What’s"))).toEqual([]);
    expect(releaseNotesProblems("## Fixes\n\n* One fix.\n")).toEqual([]);
    expect(releaseNotesProblems("## Fixes\r\n\r\n- One fix.\r\n")).toEqual([]);
  });
  it.each([
    ["# localDot 1.2.0\n\n## Fixes\n\n- One fix.", "headings are allowed"],
    ["## Fixes\n\n### Details\n\n- One fix.", "headings are allowed"],
    ["## Highlights\n\n- One fix.", "headings are allowed"],
    ["## Fixes\n\n- One.\n\n## What's new\n\n- Two.", "in the order"],
    ["## Fixes\n\n- One.\n\n## Fixes\n\n- Two.", "in the order"],
    ["- Before any heading.\n\n## Fixes\n\n- One.", "Start with a heading"],
    ["## Fixes\n\nA paragraph.", "as a bullet"],
    ["## Fixes\n\n1. Numbered.", "as a bullet"],
    ["## Fixes\n\n- One.\n  - Nested.", "Indented"],
    ["## Fixes\n\n    code block", "Indented"],
    ["## Fixes\n", "no bullets"],
    ["## What's new\n\n## Fixes\n\n- One.", "What's new has no bullets"],
    ["## Fixes\n\n- One fix. And another.", "one sentence"],
    ["## Fixes\n\n- See [the guide](https://localdot.dev).", "Links"],
    ["## Fixes\n\n- Open https://localdot.dev to read more.", "Links"],
    ["## Fixes\n\n- Visit www.localdot.dev for more.", "Links"],
    ["## Fixes\n\n- ![Screenshot](shot.png)", "Images"],
    ["## Fixes\n\n- Safer <b>sign-in</b>.", "HTML"],
    ["## Fixes\n\n- Run `localdot up` once.", "Code"],
    ["## Fixes\n\n~~~\nlocaldot up\n~~~", "Code"],
    ["## Fixes\n\n- The keyd service restarts less.", '"keyd" is an internal word'],
    ["## Fixes\n\n- Brain cells start faster.", "internal word"],
    ["## Fixes\n\n- Merged PR 12 with the refactor.", "internal word"],
    ["## Fixes\n\n- Image digest checks are quicker.", "internal word"],
    ["", "empty"],
  ])("refuses %j", (markdown, problem) => {
    expect(releaseNotesProblems(markdown).join(" ")).toContain(problem);
  });
  it("refuses more than five bullets in a section and more than 1,500 characters", () => {
    const six = Array.from({ length: 6 }, (_, i) => `- Fix number ${i + 1}.`).join("\n");
    expect(releaseNotesProblems(`## Fixes\n\n${six}`).join(" ")).toContain("more than 5 bullets");
    const long = `## Fixes\n\n- ${"Quicker ".repeat(200)}start.`;
    expect(releaseNotesProblems(long).join(" ")).toContain("longer than 1500 characters");
  });
  it("keeps every published note in docs/releases valid and named by its version", () => {
    const directory = join(import.meta.dirname, "../../../docs/releases");
    for (const name of readdirSync(directory).filter((file) => file !== "README.md")) {
      expect(name).toMatch(/\.md$/);
      expect(name.slice(0, -3)).toMatch(RELEASE_VERSION);
      expect(releaseNotesProblems(readFileSync(join(directory, name), "utf8")), name).toEqual([]);
    }
  });
});
