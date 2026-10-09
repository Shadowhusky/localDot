import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeydEvent } from "@localdot/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../event-log.ts";
import { LiveSessions } from "../gateway/live.ts";
import { KeydClient } from "./client.ts";
import { KeydEventRouter } from "./event-router.ts";
import { type FakeKeyd, startFakeKeyd } from "./testing/fake-keyd.ts";

const CELL = "01JXYZ0000000000000000ABCD";
const use = (
  over: Partial<Extract<KeydEvent, { type: "key.use" }>["data"]> = {},
  cell = CELL,
): KeydEvent => ({
  type: "key.use",
  cell,
  time: "2026-10-01T12:00:00Z",
  data: {
    secretId: "weather",
    host: "api.weather.example",
    method: "GET",
    path: "/v1/now",
    decision: "allow",
    ...over,
  },
});

let home: string;
let keyd: FakeKeyd;
let eventLog: EventLog;
let live: LiveSessions;
let sessionId: string;
let router: KeydEventRouter | undefined;
beforeEach(async () => {
  keyd = await startFakeKeyd();
  home = mkdtempSync(join(tmpdir(), "local dot's router-"));
  eventLog = new EventLog(home);
  live = new LiveSessions();
  sessionId = eventLog.createSession("t");
  live.start(CELL, sessionId, (signal) => new Promise((r) => signal.addEventListener("abort", r)));
});
afterEach(async () => {
  router?.stop();
  live.stop(sessionId);
  await live.settled(sessionId);
  await keyd.close();
  eventLog.close();
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const keyEvents = () =>
  eventLog.read(sessionId).filter((e) => e.type === "key.use" || e.type === "budget.exceeded");
const until = async (pred: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("KeydEventRouter", () => {
  it("gives the live task what each of its model calls cost, and only its own", () => {
    router = new KeydEventRouter({ keyd: new KeydClient(keyd.socketPath), live, eventLog });
    const spend = (taskId: string, billed: boolean, taskLimitUSD = 0): KeydEvent => ({
      type: "model.spend",
      cell: CELL,
      time: "2026-10-01T12:00:00Z",
      data: {
        taskId,
        route: "openrouter",
        model: "glm-5.3",
        costUSD: 0.0042,
        billed,
        taskSpentUSD: 0.2,
        taskLimitUSD,
        daySpentUSD: 1.5,
        dayLimitUSD: 0,
      },
    });
    router.route(spend(sessionId, true));
    router.route(spend(sessionId, false, 5));
    router.route(spend("01JXYZ0000000000000000OTHR", true));
    const spent = eventLog
      .read(sessionId)
      .filter((e) => e.type === "model.spend")
      .map((e) => e.data);
    expect(spent).toEqual([
      {
        route: "openrouter",
        model: "glm-5.3",
        costUSD: 0.0042,
        basis: "billed",
        taskSpentUSD: 0.2,
        daySpentUSD: 1.5,
      },
      {
        route: "openrouter",
        model: "glm-5.3",
        costUSD: 0.0042,
        basis: "estimated",
        taskSpentUSD: 0.2,
        daySpentUSD: 1.5,
        taskLimitUSD: 5,
      },
    ]);
  });
  it("appends key use to the cell's live session as keyd, cutting what a cell chose", () => {
    router = new KeydEventRouter({ keyd: new KeydClient(keyd.socketPath), live, eventLog });
    router.route(
      use({
        host: `evil\u0000${"x".repeat(400)}`,
        path: `/a\nb${"/c".repeat(400)}`,
        decision: "deny",
      }),
    );
    const [event] = keyEvents();
    expect(event).toMatchObject({
      type: "key.use",
      agent: "keyd",
      data: { secretId: "weather", method: "GET", decision: "deny" },
    });
    const data = event?.type === "key.use" ? event.data : undefined;
    expect([...(data?.host ?? "")]).toHaveLength(255);
    expect(data?.host.startsWith("evil x")).toBe(true);
    expect([...(data?.path ?? "")]).toHaveLength(512);
    expect([...(data?.path ?? "")].some((c) => c < " ")).toBe(false);
  });

  it("drops events for cells with no live session", () => {
    router = new KeydEventRouter({ keyd: new KeydClient(keyd.socketPath), live, eventLog });
    router.route(use({}, "01JXYZ0000000000000000ZZZZ"));
    expect(keyEvents()).toEqual([]);
  });

  it("logs at most the per-second limit for one cell and counts the rest", () => {
    let now = 1_000_000;
    router = new KeydEventRouter({
      keyd: new KeydClient(keyd.socketPath),
      live,
      eventLog,
      perCellPerSecond: 5,
      now: () => now,
    });
    for (let i = 0; i < 12; i++) router.route(use({ path: `/v1/${i}` }));
    expect(keyEvents()).toHaveLength(5);
    now += 1000;
    router.route(use({ path: "/v1/later" }));
    expect(keyEvents()).toHaveLength(6);
  });

  it("appends budget refusals for the agent loop and the budget UI", () => {
    router = new KeydEventRouter({ keyd: new KeydClient(keyd.socketPath), live, eventLog });
    router.route({
      type: "budget.exceeded",
      cell: CELL,
      time: "t",
      data: { scope: "task", taskId: "t1", limitUSD: 5, spentUSD: 5, needUSD: 0.2 },
    });
    expect(keyEvents()).toMatchObject([
      { type: "budget.exceeded", agent: "keyd", data: { scope: "task", needUSD: 0.2 } },
    ]);
  });

  it("defaults to twenty events per second for each cell independently", () => {
    router = new KeydEventRouter({
      keyd: new KeydClient(keyd.socketPath),
      live: { get: () => sessionId },
      eventLog,
      now: () => 0,
    });
    for (let i = 0; i < 40; i++) router.route(use());
    router.route(use({ path: "/other-cell" }, "01JXYZ0000000000000000ZZZZ"));
    expect(keyEvents()).toHaveLength(21);
    expect(keyEvents().at(-1)).toMatchObject({ data: { path: "/other-cell" } });
  });

  it("follows keyd's stream and picks it up again after keyd restarts", async () => {
    router = new KeydEventRouter({
      keyd: new KeydClient(keyd.socketPath),
      live,
      eventLog,
      retryMs: { min: 10, max: 50 },
    });
    router.start();
    await until(() => keyd.subscribers === 1);
    keyd.publish(use({ path: "/before" }));
    await until(() => keyEvents().length === 1);
    keyd.restart();
    await until(() => keyd.subscribers === 1);
    keyd.publish(use({ path: "/after" }));
    await until(() => keyEvents().length === 2);
    expect(keyEvents().map((e) => (e.type === "key.use" ? e.data.path : ""))).toEqual([
      "/before",
      "/after",
    ]);
    router.stop();
    await until(() => keyd.subscribers === 0);
  });
});

it("keeps whole emoji within the session schema's UTF-16 limits", () => {
  router = new KeydEventRouter({ keyd: new KeydClient(keyd.socketPath), live, eventLog });
  router.route(
    use({
      secretId: "😀".repeat(65),
      host: "😀".repeat(300),
      path: "😀".repeat(600),
      method: "😀".repeat(20),
    }),
  );
  const event = keyEvents()[0];
  expect(event?.type).toBe("key.use");
  if (event?.type !== "key.use") throw new Error("event missing");
  for (const [field, max] of [
    ["secretId", 64],
    ["host", 255],
    ["method", 16],
    ["path", 512],
  ] as const) {
    expect(event.data[field].length).toBeLessThanOrEqual(max);
    expect(event.data[field].isWellFormed()).toBe(true);
  }
});

it("bounds and cleans task ids in budget events", () => {
  router = new KeydEventRouter({ keyd: new KeydClient(keyd.socketPath), live, eventLog });
  router.route({
    type: "budget.exceeded",
    cell: CELL,
    time: "t",
    data: { scope: "task", taskId: `task\n${"😀".repeat(150)}`, limitUSD: 2, spentUSD: 2 },
  });
  const event = keyEvents()[0];
  expect(event?.type).toBe("budget.exceeded");
  if (event?.type !== "budget.exceeded") throw new Error("event missing");
  expect(event.data.taskId?.length).toBeLessThanOrEqual(128);
  expect(event.data.taskId).not.toContain("\n");
});

it("does not expose appender exceptions or incoming values in diagnostics", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  router = new KeydEventRouter({
    keyd: new KeydClient(keyd.socketPath),
    live,
    eventLog: {
      append: () => {
        throw new Error("private-secret-value");
      },
    },
  });
  router.route(use());
  expect(log).toHaveBeenCalledOnce();
  expect(log.mock.calls.flat().map(String).join("\n")).not.toContain("private-secret");
});

it("reports the final dropped-event count even when there is no later event", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  router = new KeydEventRouter({
    keyd: new KeydClient(keyd.socketPath),
    live,
    eventLog,
    now: () => 0,
    perCellPerSecond: 2,
  });
  for (let i = 0; i < 7; i++) router.route(use());
  expect(keyEvents()).toHaveLength(2);
  expect(log).not.toHaveBeenCalled();
  router.stop();
  router.stop();
  expect(log).toHaveBeenCalledOnce();
  expect(log.mock.calls[0]?.[0]).toContain("5 events");
});

it("aggregates keyd's own drop notices instead of flooding the console", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  router = new KeydEventRouter({
    keyd: new KeydClient(keyd.socketPath),
    live,
    eventLog,
    now: () => 0,
  });
  for (let i = 0; i < 100; i++)
    router.route({ type: "events.dropped", time: "t", data: { count: 1 } });
  expect(log).toHaveBeenCalledOnce();
  router.stop();
  expect(log).toHaveBeenCalledTimes(2);
  expect(log.mock.calls[1]?.[0]).toContain("99 events");
});

it("ignores stale stream callbacks after stop and restart", async () => {
  const handlers: ((event: KeydEvent) => void)[] = [];
  router = new KeydEventRouter({
    keyd: {
      events: (handler, signal) => {
        handlers.push(handler);
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
      },
    },
    live,
    eventLog,
  });
  router.start();
  router.start();
  expect(handlers).toHaveLength(1);
  router.stop();
  router.start();
  expect(handlers).toHaveLength(2);
  handlers[0]?.(use({ path: "/stale" }));
  handlers[1]?.(use({ path: "/current" }));
  expect(keyEvents()).toMatchObject([{ data: { path: "/current" } }]);
});
