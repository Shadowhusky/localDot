import { count } from "../copy/format.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { type ConversationRow, type Organize, organizeConversation } from "./conversation-list.ts";

// Enough requests at once to hide the round trips over a phone's link, few enough that the
// daemon's other requests keep moving.
const AT_ONCE = 4;

export const selectedLabel = (n: number) =>
  n === 0 ? "None selected" : `${n.toLocaleString()} selected`;

// A press on `id` while selecting. Alone it flips that one; with Shift (`from` the one pressed
// before) every conversation from there to `id` in `order` takes the state `id` takes.
export function choose(
  chosen: ReadonlySet<string>,
  order: readonly string[],
  id: string,
  from: string | null,
): Set<string> {
  const on = !chosen.has(id);
  const at = order.indexOf(id);
  const start = from === null ? -1 : order.indexOf(from);
  const range =
    at < 0 || start < 0 ? [id] : order.slice(Math.min(start, at), Math.max(start, at) + 1);
  const next = new Set(chosen);
  for (const each of range) {
    if (on) next.add(each);
    else next.delete(each);
  }
  return next;
}

// Why the chosen can't be deleted or archived yet, as one alone can't: a task is under way in some.
export function underWay(
  rows: readonly ConversationRow[],
  running: (row: ConversationRow) => boolean,
  doing: "deleting" | "archiving",
): string | undefined {
  const n = rows.filter(running).length;
  if (n === 0) return undefined;
  return n === 1
    ? `One of these has a task under way. Stop it or unselect it before ${doing}.`
    : `${n.toLocaleString()} of these have a task under way. Stop them or unselect them before ${doing}.`;
}

async function inTurn(ids: readonly string[], run: (id: string) => Promise<void>) {
  const queue = [...ids];
  const next = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) await run(id);
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, next));
}

// Each conversation lands in one list, in the order asked. One already gone counts as deleted, so
// a retry is harmless; the daemon refuses one with a task under way.
export interface Removal {
  deleted: string[];
  live: string[];
  failed: string[];
}

// Each goes through its own route, which checks and deletes all of its tasks or none.
export async function deleteConversations(
  api: ApiClient,
  ids: readonly string[],
): Promise<Removal> {
  const outcome = new Map<string, keyof Removal>();
  await inTurn(ids, async (id) => {
    try {
      await api.del(`/api/conversations/${id}`);
      outcome.set(id, "deleted");
    } catch (failure) {
      const status = failure instanceof ApiError ? failure.status : 0;
      outcome.set(id, status === 404 ? "deleted" : status === 409 ? "live" : "failed");
    }
  });
  const of = (kind: keyof Removal) => ids.filter((id) => outcome.get(id) === kind);
  return { deleted: of("deleted"), live: of("live"), failed: of("failed") };
}

// What the confirmation says when some stayed.
export function removalProblem({ deleted, live, failed }: Removal): string {
  if (deleted.length + live.length + failed.length === 1)
    return live.length
      ? "Stop this conversation's task before deleting it."
      : "The conversation couldn't be deleted. Try again.";
  if (deleted.length === 0 && live.length === 0)
    return "The conversations couldn't be deleted. Try again.";
  return [
    deleted.length > 0 &&
      `${count(deleted.length, "conversation was", "conversations were")} deleted.`,
    live.length > 0 &&
      `${count(live.length, "has", "have")} a task under way. Stop ${live.length === 1 ? "it" : "them"} before deleting.`,
    failed.length > 0 && `${failed.length.toLocaleString()} couldn't be deleted. Try again.`,
  ]
    .filter(Boolean)
    .join(" ");
}

// Files each the same way; resolves to how many the daemon refused.
export async function organizeConversations(
  api: ApiClient,
  ids: readonly string[],
  change: Organize,
): Promise<number> {
  let refused = 0;
  await inTurn(ids, (id) =>
    organizeConversation(api, id, change).catch(() => {
      refused++;
    }),
  );
  return refused;
}
