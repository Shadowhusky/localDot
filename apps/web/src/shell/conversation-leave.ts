import type { Organize } from "../agent/conversation-list.ts";
import { CLOSES_AT, MOST_POPS, type PoppingDot, popDots, rippleDelays } from "../dot/pop.ts";
import { leaveRows } from "../ui/leave.ts";
import { matches, REDUCED_MOTION } from "../ui/media.ts";

// A conversation's row in any list, marked with its id; several lists can show one.
const ROWS = "[data-conversation]";
const LIST = ".sessions, .conversations, .phone-list-screen";
const SCROLLS = ".sessions-scroll, .conversations-body, .phone-list-scroll";
// What a row hands the keys to: where the arrows go on from, or its menu where a field takes them.
const TAKES_FOCUS = ".sessions-row, .conversations-more, .phone-row, .phone-rail-button";
// Where the keys go in a list left with no rows.
const FIRST_RESORT = '[aria-label="New conversation"], input';
const HEADING = ".sessions-group-label, .conversations-day";

function rowsOf(ids: readonly string[]): HTMLElement[] {
  const asked = new Set(ids);
  return [...document.querySelectorAll<HTMLElement>(ROWS)].filter((row) =>
    asked.has(row.dataset.conversation ?? ""),
  );
}

// Its middle shows: not scrolled away, nor in a list that isn't laid out.
function inView(row: HTMLElement): boolean {
  const box = row.getBoundingClientRect();
  const port = row.closest(SCROLLS)?.getBoundingClientRect();
  const middle = box.top + box.height / 2;
  return (
    box.height > 0 &&
    middle > Math.max(0, port?.top ?? 0) &&
    middle < Math.min(window.innerHeight, port?.bottom ?? window.innerHeight)
  );
}

// The headings with none of their rows left once these go. A rail's rows are in a list of their own
// under theirs; the others follow theirs in one flat list.
function headingsLeftBare(rows: readonly HTMLElement[]): HTMLElement[] {
  const going = new Set<Element>(rows);
  const bare = new Set<HTMLElement>();
  for (const row of rows) {
    let heading = row.previousElementSibling;
    while (heading && !heading.matches(HEADING)) heading = heading.previousElementSibling;
    heading ??= row.parentElement?.previousElementSibling ?? null;
    if (!(heading instanceof HTMLElement) || !heading.matches(HEADING) || bare.has(heading))
      continue;
    const under: Element[] = [];
    let next = heading.nextElementSibling;
    if (next?.matches("ul")) under.push(...next.children);
    else
      for (; next && !next.matches(HEADING); next = next.nextElementSibling)
        if (next.matches(ROWS)) under.push(next);
    if (under.every((each) => going.has(each))) bare.add(heading);
  }
  return [...bare];
}

// Where focus can land once these conversations have gone: the row after them, or else the one
// before, as it is then. A row can change elements as it goes, so each is found again when asked.
export function landingAfter(ids: readonly string[]): () => HTMLElement | null {
  const rows = rowsOf(ids);
  const last = rows.at(-1);
  const list = last?.closest<HTMLElement>(LIST);
  if (!last || !list) return () => null;
  const going = new Set(rows);
  const all = [...list.querySelectorAll<HTMLElement>(ROWS)];
  const at = all.indexOf(last);
  const staying = (row: HTMLElement) => !going.has(row);
  const beside = all.slice(at + 1).find(staying) ?? all.slice(0, at).reverse().find(staying);
  const id = beside?.dataset.conversation;
  return () => {
    const row = id && list.querySelector(`${ROWS}[data-conversation="${CSS.escape(id)}"]`);
    return (
      (row && row.querySelector<HTMLElement>(TAKES_FOCUS)) ||
      list.querySelector<HTMLElement>(FIRST_RESORT)
    );
  };
}

function holdFocus(land: () => HTMLElement | null) {
  const active = document.activeElement;
  if (!active || active === document.body) land()?.focus({ preventScroll: true });
}

export interface PopOptions {
  // An open layer that stays over the burst.
  under?: Element | null;
  land?: () => HTMLElement | null;
}

// The conversations the daemon has deleted: on screen each dot bursts, in a ripple from the first
// down, its row fading behind it; then `remove` takes them all from the lists in one commit, and the
// list closes. Under reduced motion they only fade. `remove` runs however few are on screen.
export function popConversations(
  ids: readonly string[],
  remove: () => void,
  { under = null, land = () => null }: PopOptions = {},
): void {
  const rows = rowsOf(ids);
  const inSight = rows.filter(inView);
  const shown = [...inSight, ...headingsLeftBare(rows)];
  const after = () => holdFocus(land);
  if (matches(REDUCED_MOTION) || typeof document.body.animate !== "function") {
    leaveRows(rows, remove, { shown, after });
    return;
  }
  const popping = inSight.slice(0, MOST_POPS).flatMap((row) => {
    const avatar = row.querySelector<HTMLElement>(":is(.dot-avatar, .dot)");
    return avatar ? [{ row, avatar }] : [];
  });
  const delays = rippleDelays(popping.length);
  const lastDelay = delays.at(-1) ?? 0;
  const dots: PoppingDot[] = popping.map(({ row, avatar }, index) => ({
    avatar,
    seed: row.dataset.conversation ?? "",
    delay: delays[index] ?? 0,
  }));
  popDots(dots, under);
  leaveRows(rows, remove, {
    shown,
    after,
    delayOf: (index) => delays[index] ?? lastDelay,
    hold: lastDelay + CLOSES_AT,
  });
  for (const { row } of popping) row.dataset.leaving = "pop";
}

// Filing that takes a conversation out of the list on show lets its row fade first; `file` then
// shows the change at once and saves it. Pinning, which only moves it, just glides.
export function fileConversations(
  ids: readonly string[],
  change: Organize,
  file: () => void,
): void {
  if (!("archived" in change)) {
    file();
    return;
  }
  const rows = rowsOf(ids);
  const land = landingAfter(ids);
  leaveRows(rows, file, {
    shown: [...rows.filter(inView), ...headingsLeftBare(rows)],
    after: () => holdFocus(land),
  });
}
