import type { MemoryEntry, Person, RecentOutcome } from "@localdot/protocol";

const NBSP = "\u00a0";

// A YYYY-MM-DD day in the user's locale, with the year only when it isn't this one. It never breaks
// across lines.
export function dayLabel(day: string, now = new Date()): string {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return date
    .toLocaleDateString([], {
      day: "numeric",
      month: "short",
      ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    })
    .replace(/\s/g, NBSP);
}

// Where something came from, and the day after it (" · 9 Oct"), kept apart so a link to the task
// can shorten while the day stays.
export function sourceLine(
  item: Pick<MemoryEntry, "source" | "at">,
  now = new Date(),
): { text: string; day: string; sessionId?: string } {
  const day = item.at ? `${NBSP}·${NBSP}${dayLabel(item.at, now)}` : "";
  switch (item.source.kind) {
    case "task":
      return item.source.title
        ? { text: `From ${item.source.title}`, day, sessionId: item.source.sessionId }
        : { text: "From a deleted task", day };
    case "user":
      return { text: "Added by you", day };
    default:
      return { text: "Source unknown", day: "" };
  }
}

export function personLine(person: Person, now = new Date()): string {
  return [person.app, person.handle, person.lastAt ? `last ${dayLabel(person.lastAt, now)}` : null]
    .filter(Boolean)
    .join(" · ");
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = (words.length > 1 ? [words[0], words.at(-1)] : [name.trim()]).map(
    (word) => [...(word ?? "")][0] ?? "",
  );
  return letters.join("").toLocaleUpperCase();
}

export const OUTCOME: Record<RecentOutcome, string> = {
  done: "Done",
  stopped: "Stopped",
  error: "Ended with an error",
  interrupted: "Interrupted",
  running: "Running",
};
