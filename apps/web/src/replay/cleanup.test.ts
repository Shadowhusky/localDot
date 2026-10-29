import type { SessionCard } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { createApi } from "../lib/api.ts";
import {
  amount,
  CLEANUPS,
  deleteBody,
  deleteProblem,
  deleteRecordings,
  deleteTitle,
  pick,
} from "./cleanup.ts";

const NOW = new Date("2026-10-08T09:00:00.000Z");
const DAY = 86_400_000;
let next = 0;
function card(
  daysAgo: number,
  verdict: SessionCard["verdict"] = "done",
  diskBytes = 1024 ** 2,
): SessionCard {
  next++;
  return {
    id: `01M4ECBR5X0R92SYA389FM3Q${String(next).padStart(2, "0")}`,
    title: `Task ${next}`,
    startedAt: new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
    durationMs: verdict === "live" ? null : 1000,
    verdict,
    steps: 1,
    failedSteps: 0,
    coverFrameId: null,
    screen: null,
    recording: { state: "complete", bytes: 10 },
    diskBytes,
  };
}
const ids = (cards: readonly SessionCard[]) => cards.map((entry) => entry.id);
const choice = (label: string) => {
  const found = CLEANUPS.find((cleanup) => cleanup.label === label);
  if (!found) throw new Error(`No ${label}`);
  return found;
};

describe("Free up space", () => {
  it("picks by age, by ending and by keeping the newest ten, never a running task", () => {
    const live = card(0, "live");
    const library = [
      live,
      card(1),
      card(8, "stopped"),
      card(31, "error"),
      card(45, "interrupted"),
      card(120),
      ...Array.from({ length: 8 }, () => card(150)),
    ];
    expect(ids(choice("Older than 7 days").picks(library, NOW))).toEqual(ids(library.slice(2)));
    expect(ids(choice("Older than 30 days").picks(library, NOW))).toEqual(ids(library.slice(3)));
    expect(ids(choice("Older than 90 days").picks(library, NOW))).toEqual(ids(library.slice(5)));
    expect(ids(choice("Stopped or failed").picks(library, NOW))).toEqual(ids(library.slice(2, 5)));
    expect(ids(choice("All but the newest 10").picks(library, NOW))).toEqual(
      ids(library.slice(10)),
    );
    expect(choice("Older than 7 days").picks([live, card(0, "live", 5)], NOW)).toEqual([]);
  });

  it("says how many it picks and what they free, and asks in words that match", () => {
    expect(amount([card(1, "done", 1.5 * 1024 ** 3), card(2, "done", 512 * 1024 ** 2)])).toBe(
      "2 recordings · 2.0 GB",
    );
    expect(choice("Older than 30 days").title(1)).toBe("Delete 1 recording older than 30 days?");
    expect(choice("Stopped or failed").title(3)).toBe("Delete 3 stopped or failed recordings?");
    expect(choice("All but the newest 10").title(12)).toBe(
      "Delete 12 recordings and keep the newest 10?",
    );
    expect(deleteTitle(1)).toBe("Delete this recording?");
    expect(deleteTitle(4)).toBe("Delete 4 recordings?");
    expect(deleteBody(4)).toBe(
      "Their videos, screenshots, steps, messages and saved files are removed from this Mac. You can't undo this.",
    );
  });
});

describe("select mode", () => {
  const shown = [card(0), card(0, "live"), card(1), card(2), card(3)];
  const [a, live, b, c, d] = ids(shown) as [string, string, string, string, string];

  it("toggles one row, and with Shift gives every row back to the last one its new state", () => {
    let chosen = pick(new Set(), shown, a, null);
    expect([...chosen]).toEqual([a]);
    chosen = pick(chosen, shown, c, a);
    expect([...chosen].sort()).toEqual([a, b, c].sort());
    chosen = pick(chosen, shown, b, c);
    expect([...chosen]).toEqual([a]);
    chosen = pick(chosen, shown, d, "gone from the list");
    expect([...chosen].sort()).toEqual([a, d].sort());
  });

  it("never picks a running task, alone or in a range", () => {
    expect(pick(new Set(), shown, live, null).size).toBe(0);
    expect(pick(new Set(), shown, b, a).has(live)).toBe(false);
  });
});

describe("deleting", () => {
  function daemon(reply: (ids: string[], call: number) => Response) {
    const bodies: string[][] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const asked = JSON.parse(String(init?.body)).ids as string[];
      bodies.push(asked);
      return reply(asked, bodies.length);
    }) as typeof fetch;
    return { api: createApi("a".repeat(43), { fetchImpl, origin: "http://127.0.0.1" }), bodies };
  }
  const many = Array.from(
    { length: 60 },
    (_, at) => `01M4ECBR5X0R92SYA389FM${String(at).padStart(4, "0")}`,
  );

  it("sends a batch at a time and gathers every answer", async () => {
    const { api, bodies } = daemon((asked) =>
      Response.json({ deleted: asked.slice(1), live: asked.slice(0, 1), failed: [] }),
    );
    const result = await deleteRecordings(api, many);
    expect(bodies.map((body) => body.length)).toEqual([25, 25, 10]);
    expect(bodies.flat()).toEqual(many);
    expect(result.live).toEqual([many[0], many[25], many[50]]);
    expect(result.deleted).toHaveLength(57);
    expect(result.failed).toEqual([]);
  });

  it("stops at a batch whose request fails and counts the rest as not deleted", async () => {
    const { api, bodies } = daemon((asked, call) =>
      call === 2
        ? new Response("down", { status: 500 })
        : Response.json({ deleted: asked, live: [], failed: [] }),
    );
    const result = await deleteRecordings(api, many);
    expect(bodies).toHaveLength(2);
    expect(result.deleted).toEqual(many.slice(0, 25));
    expect(result.failed).toEqual(many.slice(25));
  });

  it("says what was deleted and what stayed, and why", () => {
    const [one, two, three] = many as [string, string, string];
    expect(deleteProblem({ deleted: [], live: [], failed: [one, two] })).toBe(
      "The recordings couldn't be deleted. Try again.",
    );
    expect(deleteProblem({ deleted: [one], live: [two], failed: [three] })).toBe(
      "1 recording was deleted. 1 is still running. Stop it before deleting. 1 couldn't be deleted. Try again.",
    );
    expect(deleteProblem({ deleted: [], live: [one, two], failed: [] })).toBe(
      "2 are still running. Stop them before deleting.",
    );
  });
});
