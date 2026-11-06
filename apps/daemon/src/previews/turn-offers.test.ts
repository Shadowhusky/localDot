import { describe, expect, it } from "vitest";
import { scanEvents } from "../deliverables/task-scan.ts";
import { turnOffers } from "./turn-offers.ts";

const TASK = "01JXYZ0000000000000000TASK";
const event = (seq: number, t: number, type: string, data: unknown) =>
  ({
    v: 1,
    id: `01JXYZ00000000000000000${seq}`.slice(-26),
    seq,
    t,
    agent: "main",
    type,
    data,
  }) as never;
const result = (seq: number, t: number) =>
  event(seq, t, "task.result", { summary: "Done", files: [] });

describe("turnOffers", () => {
  it("reads only the turn since the last reply", async () => {
    const scan = scanEvents([
      event(0, 0, "session.start", { screen: { w: 1, h: 1, scale: 1 }, os: "linux" }),
      event(1, 10_000, "tool.start", { tool: "browser_navigate", title: "Opening 127.0.0.1:4181" }),
      event(2, 20_000, "file.change", { path: "~/old/a.ts", op: "create" }),
      result(3, 30_000_000),
      event(4, 31_000_000, "tool.start", { tool: "shell", title: "Opening 127.0.0.1:9" }),
      event(5, 32_000_000, "tool.start", {
        tool: "browser_navigate",
        title: "Opening shop.localhost:1355",
      }),
      event(6, 32_000_000, "tool.start", {
        tool: "browser_navigate",
        title: "Opening example.com",
      }),
      event(7, 33_000_000, "file.change", { path: "~/code/shop/src/App.tsx", op: "edit" }),
    ]);
    const asked: unknown[] = [];
    await turnOffers(
      {
        scan: async () => scan,
        offers: async (_id, turn) => {
          asked.push(turn);
          return [];
        },
      },
      TASK,
      "See it at localhost:5173",
    );
    expect(asked).toEqual([
      expect.objectContaining({
        reply: "See it at localhost:5173",
        navigated: ["shop.localhost:1355"],
        changed: ["~/code/shop/src/App.tsx"],
      }),
    ]);
    const [turn] = asked as { startedAt: number }[];
    expect(turn?.startedAt).toBeGreaterThan(0);
  });

  it("never holds a reply up, and never fails it", async () => {
    const offer = [{ port: 5173, url: "http://localhost:5173/" }];
    const slow = {
      scan: async () => undefined,
      offers: () => new Promise<never>(() => {}),
    };
    expect(await turnOffers(slow, TASK, "", 5)).toEqual([]);
    const broken = {
      scan: async () => undefined,
      offers: async () => {
        throw new Error("no computer");
      },
    };
    expect(await turnOffers(broken, TASK, "")).toEqual([]);
    const quick = { scan: async () => undefined, offers: async () => offer };
    expect(await turnOffers(quick, TASK, "")).toEqual(offer);
  });
});
