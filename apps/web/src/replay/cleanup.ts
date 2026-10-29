import { DeleteSessionsResult, type SessionCard } from "@localdot/protocol";
import { bytes, count } from "../copy/format.ts";
import type { ApiClient } from "../lib/api.ts";
import { cardBytes, inFilter } from "./replay-view.ts";

const DAY_MS = 86_400_000;
// Each request deletes this many, so it ends well inside the client's timeout.
const DELETE_BATCH = 25;

// A running task keeps its recording until it stops.
export const deletable = (card: Pick<SessionCard, "verdict">) => card.verdict !== "live";

const recordings = (n: number) => count(n, "recording", "recordings");

// One of Free up space's quick choices: which recordings it picks from the whole library, newest
// first, and how its confirmation asks.
export interface Cleanup {
  label: string;
  // In the choice's place when it picks nothing.
  none: string;
  picks(cards: readonly SessionCard[], now: Date): SessionCard[];
  title(n: number): string;
}

const olderThan = (days: number): Cleanup => ({
  label: `Older than ${days} days`,
  none: `Nothing older than ${days} days`,
  picks: (cards, now) =>
    cards.filter(
      (card) => deletable(card) && now.getTime() - Date.parse(card.startedAt) > days * DAY_MS,
    ),
  title: (n) => `Delete ${recordings(n)} older than ${days} days?`,
});

const NEWEST = 10;

export const CLEANUPS: readonly Cleanup[] = [
  olderThan(7),
  olderThan(30),
  olderThan(90),
  {
    label: "Stopped or failed",
    none: "None stopped or failed",
    picks: (cards) => cards.filter((card) => deletable(card) && inFilter(card, "stopped")),
    title: (n) =>
      `Delete ${n.toLocaleString()} stopped or failed ${n === 1 ? "recording" : "recordings"}?`,
  },
  {
    label: `All but the newest ${NEWEST}`,
    none: `${NEWEST} recordings or fewer`,
    picks: (cards) => cards.slice(NEWEST).filter(deletable),
    title: (n) => `Delete ${recordings(n)} and keep the newest ${NEWEST}?`,
  },
];

export const deleteTitle = (n: number) => `Delete ${n === 1 ? "this recording" : recordings(n)}?`;

// What deleting removes, as the code does it: the task's whole folder and its history.
export const deleteBody = (n: number) =>
  `${n === 1 ? "Its video" : "Their videos"}, screenshots, steps, messages and saved files are removed from this Mac. You can't undo this.`;

export const totalBytes = (cards: readonly SessionCard[]) =>
  cards.reduce((sum, card) => sum + cardBytes(card), 0);

// "12 recordings · 3.4 GB"
export const amount = (cards: readonly SessionCard[]) =>
  `${recordings(cards.length)} · ${bytes(totalBytes(cards))}`;

// A press on `id` in select mode. With Shift (`from` set to the one pressed before), every
// recording from there to `id` takes the state `id` takes; a running one is never picked.
export function pick(
  chosen: ReadonlySet<string>,
  shown: readonly SessionCard[],
  id: string,
  from: string | null,
): Set<string> {
  const on = !chosen.has(id);
  const at = shown.findIndex((card) => card.id === id);
  const start = from === null ? -1 : shown.findIndex((card) => card.id === from);
  const range =
    at < 0 || start < 0
      ? shown.filter((card) => card.id === id && deletable(card))
      : shown.slice(Math.min(start, at), Math.max(start, at) + 1).filter(deletable);
  const next = new Set(chosen);
  for (const card of range) {
    if (on) next.add(card.id);
    else next.delete(card.id);
  }
  return next;
}

// Deletes in batches. A batch whose request fails stops the rest, and all of them count as failed:
// the daemon may have deleted some, which a retry then finds already gone.
export async function deleteRecordings(
  api: ApiClient,
  ids: readonly string[],
): Promise<DeleteSessionsResult> {
  const result: DeleteSessionsResult = { deleted: [], live: [], failed: [] };
  for (let at = 0; at < ids.length; at += DELETE_BATCH) {
    try {
      const reply = DeleteSessionsResult.parse(
        await api.post("/api/session-index/delete", { ids: ids.slice(at, at + DELETE_BATCH) }),
      );
      result.deleted.push(...reply.deleted);
      result.live.push(...reply.live);
      result.failed.push(...reply.failed);
    } catch {
      result.failed.push(...ids.slice(at));
      break;
    }
  }
  return result;
}

// What the confirmation says when some recordings stayed.
export function deleteProblem({ deleted, live, failed }: DeleteSessionsResult): string {
  if (deleted.length === 0 && live.length === 0)
    return "The recordings couldn't be deleted. Try again.";
  return [
    deleted.length > 0 && `${count(deleted.length, "recording was", "recordings were")} deleted.`,
    live.length > 0 &&
      `${count(live.length, "is", "are")} still running. Stop ${live.length === 1 ? "it" : "them"} before deleting.`,
    failed.length > 0 && `${failed.length.toLocaleString()} couldn't be deleted. Try again.`,
  ]
    .filter(Boolean)
    .join(" ");
}
