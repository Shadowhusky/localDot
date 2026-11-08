import type { ConversationEntry } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { createApi } from "../lib/api.ts";
import type { ConversationRow } from "./conversation-list.ts";
import {
  choose,
  deleteConversations,
  organizeConversations,
  removalProblem,
  selectedLabel,
  underWay,
} from "./conversation-selection.ts";

const ORDER = ["a", "b", "c", "d", "e"];
const set = (...ids: string[]) => new Set(ids);

describe("choosing", () => {
  it("flips the one pressed alone", () => {
    expect(choose(set(), ORDER, "b", null)).toEqual(set("b"));
    expect(choose(set("b", "c"), ORDER, "b", null)).toEqual(set("c"));
  });

  it("gives a Shift press's run, either way, the state the one pressed takes", () => {
    expect(choose(set("a"), ORDER, "d", "b")).toEqual(set("a", "b", "c", "d"));
    expect(choose(set(), ORDER, "b", "e")).toEqual(set("b", "c", "d", "e"));
    expect(choose(set("a", "b", "c", "d"), ORDER, "c", "a")).toEqual(set("d"));
  });

  it("flips only the one pressed when the run's start is no longer listed", () => {
    expect(choose(set("x"), ORDER, "c", "x")).toEqual(set("x", "c"));
  });

  it("names how many are selected", () => {
    expect(selectedLabel(0)).toBe("None selected");
    expect(selectedLabel(3)).toBe("3 selected");
    expect(selectedLabel(1200)).toBe("1,200 selected");
  });
});

function row(id: string): ConversationRow {
  const entry: ConversationEntry = {
    sessionId: id,
    sessions: [id],
    title: id,
    said: id,
    startedAt: "2026-10-08T09:00:00.000Z",
    ended: "done",
  };
  return { entry, title: id, status: "done", active: false, since: entry.startedAt };
}

describe("the running-task guard", () => {
  const rows = ORDER.map(row);
  it("says nothing while none of the chosen is under way", () => {
    expect(underWay(rows, () => false, "deleting")).toBeUndefined();
  });

  it("says how many are under way and what to do", () => {
    expect(underWay(rows, (each) => each.entry.sessionId === "b", "deleting")).toBe(
      "One of these has a task under way. Stop it or unselect it before deleting.",
    );
    expect(underWay(rows, (each) => each.entry.sessionId < "c", "archiving")).toBe(
      "2 of these have a task under way. Stop them or unselect them before archiving.",
    );
  });
});

// A daemon that answers each conversation's own delete route by its id, and records how many
// requests were in flight at once.
function daemon(answers: Record<string, number>) {
  const asked: string[] = [];
  let inFlight = 0;
  let most = 0;
  const api = createApi("a".repeat(43), {
    origin: "http://127.0.0.1",
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      asked.push(`${init?.method} ${path}`);
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      const id = path.split("/")[3] ?? "";
      const status = answers[id] ?? 204;
      if (status === -1) throw new TypeError("network down");
      return new Response(null, { status });
    }) as typeof fetch,
  });
  return { api, asked, most: () => most };
}

describe("deleting several", () => {
  it("deletes each through its own route, a few at a time, in the order asked", async () => {
    const ids = Array.from({ length: 10 }, (_, n) => `c${n}`);
    const { api, asked, most } = daemon({});
    const result = await deleteConversations(api, ids);
    expect(result).toEqual({ deleted: ids, live: [], failed: [] });
    expect(asked.sort()).toEqual(ids.map((id) => `DELETE /api/conversations/${id}`).sort());
    expect(most()).toBe(4);
  });

  it("keeps one under way and one that failed, and counts one already gone as deleted", async () => {
    const { api } = daemon({ b: 409, c: 500, d: 404, e: -1 });
    expect(await deleteConversations(api, ["a", "b", "c", "d", "e"])).toEqual({
      deleted: ["a", "d"],
      live: ["b"],
      failed: ["c", "e"],
    });
  });

  it("says what stayed and why", () => {
    expect(removalProblem({ deleted: [], live: ["a"], failed: [] })).toBe(
      "Stop this conversation's task before deleting it.",
    );
    expect(removalProblem({ deleted: [], live: [], failed: ["a"] })).toBe(
      "The conversation couldn't be deleted. Try again.",
    );
    expect(removalProblem({ deleted: [], live: [], failed: ["a", "b"] })).toBe(
      "The conversations couldn't be deleted. Try again.",
    );
    expect(removalProblem({ deleted: ["a", "b"], live: ["c"], failed: ["d"] })).toBe(
      "2 conversations were deleted. 1 has a task under way. Stop it before deleting. 1 couldn't be deleted. Try again.",
    );
    expect(removalProblem({ deleted: ["a"], live: ["b", "c"], failed: [] })).toBe(
      "1 conversation was deleted. 2 have a task under way. Stop them before deleting.",
    );
  });
});

describe("filing several", () => {
  it("files each through its own route and counts those refused", async () => {
    const posted: string[] = [];
    const api = createApi("a".repeat(43), {
      origin: "http://127.0.0.1",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        posted.push(`${path} ${init?.body}`);
        return new Response(null, { status: path.includes("/b/") ? 409 : 204 });
      }) as typeof fetch,
    });
    expect(await organizeConversations(api, ["a", "b", "c"], { archived: true })).toBe(1);
    expect(posted.sort()).toEqual([
      '/api/conversations/a/archive {"archived":true}',
      '/api/conversations/b/archive {"archived":true}',
      '/api/conversations/c/archive {"archived":true}',
    ]);
  });
});
