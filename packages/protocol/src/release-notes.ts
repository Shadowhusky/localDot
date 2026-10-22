// Release notes are written for the people who use localDot: docs/releases/<version>.md, in at
// most three sections of short bullets. The release scripts refuse notes that break these rules,
// and the app drops any it reads that do, so a note is shown as written or not at all.

export const RELEASE_NOTES_SECTIONS = ["What's new", "Fixes", "Before you update"] as const;
export const RELEASE_NOTES_MAX_CHARS = 1500;
export const RELEASE_NOTES_MAX_BULLETS = 5;
// What the app reads of one notes file; anything longer was never a valid note.
export const RELEASE_NOTES_MAX_BYTES = 2048;

// Our own names and engineering words. Matched as whole words, in any case.
const INTERNAL_WORDS = [
  "keyd",
  "brain",
  "gate",
  "gates",
  "cell",
  "cells",
  "daemon",
  "daemons",
  "container",
  "containers",
  "digest",
  "digests",
  "harness",
  "hairpin",
  "heartbeat",
  "heartbeats",
  "session",
  "sessions",
  "stdout",
  "stderr",
  "microdollar",
  "microdollars",
  "PR",
  "PRs",
  "refactor",
  "refactors",
  "refactored",
  "refactoring",
  "commit",
  "commits",
  "merge",
  "merged",
  "rebase",
  "CI",
  "lint",
  "typecheck",
  "worktree",
  "repo",
  "schema",
  "endpoint",
  "endpoints",
  "regression",
  "regressions",
  "npm",
  "pnpm",
  "e2e",
  "QA",
  "WIP",
  "TODO",
  "FIXME",
];
const INTERNAL = new RegExp(`\\b(?:${INTERNAL_WORDS.join("|")})\\b`, "i");
const HEADING = /^#{1,6}(?:\s|$)/;
const SECTION = /^## (.+)$/;
const BULLET = /^[-*] (\S.*)$/;

function section(title: string): number {
  return RELEASE_NOTES_SECTIONS.indexOf(
    title.replace(/’/g, "'").trim() as (typeof RELEASE_NOTES_SECTIONS)[number],
  );
}

/** Everything wrong with one release's notes, in words a release author can act on. */
export function releaseNotesProblems(markdown: string): string[] {
  const problems = new Set<string>();
  const text = markdown.replace(/\r\n?/g, "\n").trim();
  if (!text) return ["The notes are empty."];
  if (text.length > RELEASE_NOTES_MAX_CHARS)
    problems.add(`The notes are longer than ${RELEASE_NOTES_MAX_CHARS} characters.`);
  if (/!\[/.test(text)) problems.add("Images aren't allowed.");
  if (/\]\(|https?:|\bwww\./i.test(text)) problems.add("Links aren't allowed.");
  if (/<[A-Za-z/!?]/.test(text)) problems.add("HTML isn't allowed.");
  if (/`|~~~/.test(text)) problems.add("Code isn't allowed.");
  const internal = text.match(INTERNAL);
  if (internal) problems.add(`"${internal[0]}" is an internal word; say what changed for people.`);
  let current = -1;
  let bullets = 0;
  const seen = new Set<number>();
  const close = () => {
    if (current < 0) return;
    const name = RELEASE_NOTES_SECTIONS[current];
    if (!bullets) problems.add(`${name} has no bullets.`);
    if (bullets > RELEASE_NOTES_MAX_BULLETS)
      problems.add(`${name} has more than ${RELEASE_NOTES_MAX_BULLETS} bullets.`);
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (/^\s/.test(line)) {
      problems.add("Indented lines aren't allowed.");
      continue;
    }
    if (HEADING.test(line)) {
      const index = section(line.match(SECTION)?.[1] ?? "");
      if (index < 0) {
        problems.add("Only ## What's new, ## Fixes and ## Before you update headings are allowed.");
        continue;
      }
      if (seen.has(index) || index < current)
        problems.add("Use each heading once, in the order What's new, Fixes, Before you update.");
      close();
      seen.add(index);
      current = index;
      bullets = 0;
      continue;
    }
    const bullet = line.match(BULLET)?.[1];
    if (bullet === undefined) {
      problems.add("Write each point as a bullet under a heading.");
      continue;
    }
    if (current < 0) problems.add("Start with a heading.");
    bullets++;
    if (/[.!?]["’)]?\s+\S/.test(bullet)) problems.add("Keep each bullet to one sentence.");
  }
  close();
  if (!seen.size) problems.add("Add at least one section.");
  return [...problems];
}
