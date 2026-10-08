// Words people using localDot should never read: our internal names, plumbing and audit-speak.
// The UI guard (apps/web/scripts/ui-guard.mjs) checks every string a screen can show against them.
export const BANNED_COPY: readonly string[] = [
  "daemon",
  "daemons",
  "keyd",
  "hairpin",
  "cell",
  "cells",
  "container",
  "containers",
  "microdollar",
  "microdollars",
  "stdout",
  "stderr",
  "heartbeat",
  "heartbeats",
  "session",
  "sessions",
  "contain",
  "frozen model identity",
  "resume computer",
];

// Fine inside a sentence, wrong as a heading or on a button.
export const BANNED_IN_LABELS: readonly string[] = ["verified", "unconfirmed", "retained"];

// A word ends at anything but a letter, digit, "_", "-" or "/", and "." may not come just before it,
// so class names, paths and identifiers ("cell-row", "/api/cells", "obj.session") are never copy.
function matcher(words: readonly string[]): RegExp {
  const alternatives = words.map((word) =>
    word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"),
  );
  return new RegExp(`(?<![\\w/.-])(?:${alternatives.join("|")})(?![\\w/-])`, "gi");
}

const COPY = matcher(BANNED_COPY);
const LABELS = matcher(BANNED_IN_LABELS);

export function bannedWords(text: string, label = false): string[] {
  const found = [...text.matchAll(COPY)];
  if (label) found.push(...text.matchAll(LABELS));
  return found.map(([word]) => word.toLowerCase().replace(/\s+/g, " "));
}
