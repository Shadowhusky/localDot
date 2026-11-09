import type { LocalDotEvent } from "@localdot/protocol";

const UNNAMED = "unknown";

// What a shared link's guest reads of a task's log: all of it but which of the owner's keys it
// touched. The event keeps its place, since a feed counts on its sequence.
export function forGuest(event: LocalDotEvent): LocalDotEvent {
  if (event.type === "key.use") return { ...event, data: { ...event.data, secretId: UNNAMED } };
  if (event.type === "blocker.raise" && event.data.blocker.kind === "key")
    return {
      ...event,
      data: { ...event.data, blocker: { ...event.data.blocker, id: UNNAMED } },
    };
  return event;
}
