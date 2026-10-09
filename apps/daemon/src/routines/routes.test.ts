import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Routine, RoutineListReply, type StartAtLoginState, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toolHarness } from "../agent/testing/harness.ts";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { StartAtLoginError } from "./start-at-login.ts";
import { RoutineStore } from "./store.ts";

const TOKEN = "i".repeat(43);
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});
const draft = {
  name: "Morning bills",
  instruction: "Check statements.",
  when: { kind: "weekdays" as const, time: "08:30" },
};
const stopped = {
  sessions: [],
  cells: [],
  routinesPaused: 1,
  launchesCancelled: 0,
  confirmed: true,
};
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ld-routes-"));
  const log = new EventLog(home);
  const store = new RoutineStore(home, {
    now: () => Date.parse("2026-10-12T09:00:00Z"),
    zone: () => "Europe/London",
  });
  cleanup.push(() => {
    store.close();
    log.close();
    rmSync(home, { recursive: true, force: true });
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deps = {
    store,
    scheduler: { replan: vi.fn() },
    launcher: { runNow: vi.fn(() => ulid()) },
    publish: vi.fn(),
    redact: (text: string) => text.replaceAll("ld_web_0123456789abcdefghijkl_abcdef", "[key]"),
    zone: () => "Europe/London",
    now: () => Date.parse("2026-10-12T09:00:00Z"),
    startAtLogin: {
      status: vi.fn(async (): Promise<StartAtLoginState> => "off"),
      set: vi.fn(async (on: boolean): Promise<StartAtLoginState> => (on ? "on" : "off")),
    },
    stopAll: vi.fn(async () => {
      await gate;
      return stopped;
    }),
  };
  const app = createApp({ token: TOKEN, port: 4750, eventLog: log, routines: deps });
  const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
    app.request(`http://127.0.0.1:4750${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T = Routine>(res: Response | Promise<Response>) =>
    (await (await res).json()) as T;
  return { store, deps, call, json, release };
}

describe("routine routes", () => {
  it("need the install token, every one of them", async () => {
    const f = fixture();
    const id = ulid();
    for (const [method, path] of [
      ["GET", "/api/routines"],
      ["POST", "/api/routines"],
      ["GET", `/api/routines/${id}`],
      ["PUT", `/api/routines/${id}`],
      ["DELETE", `/api/routines/${id}?revision=1`],
      ["POST", `/api/routines/${id}/confirm`],
      ["POST", `/api/routines/${id}/run`],
      ["GET", `/api/routines/${id}/runs`],
      ["POST", `/api/routines/${id}/seen`],
      ["POST", "/api/routines/resume"],
      ["GET", "/api/start-at-login"],
      ["PUT", "/api/start-at-login"],
      ["POST", "/api/stop-all"],
    ] as const)
      expect((await f.call(method, path, undefined, null)).status, `${method} ${path}`).toBe(401);
    expect(f.deps.stopAll).not.toHaveBeenCalled();
  });

  it("are not reachable from the agent's tool API", async () => {
    const h = toolHarness();
    cleanup.push(() => h.close());
    expect(
      (await h.app.request(`/api/routines/${ulid()}/confirm`, { method: "POST", headers: h.auth }))
        .status,
    ).toBe(404);
    expect((await h.call("confirm", { revision: 1 })).status).toBe(404);
  });

  it("POST without tz uses the daemon zone and re-plans", async () => {
    const f = fixture();
    const res = await f.call("POST", "/api/routines", draft);
    expect(res.status).toBe(201);
    const routine = await f.json(res);
    expect(routine).toMatchObject({
      tz: "Europe/London",
      state: "active",
      summary: "Weekdays at 08:30 · London time",
    });
    expect(f.deps.scheduler.replan).toHaveBeenCalled();
    expect(f.deps.publish).toHaveBeenCalledWith({
      type: "routine.changed",
      routineId: routine.id,
      revision: 1,
      state: "active",
    });
  });

  it("refuses key-like text and redacts known secrets", async () => {
    const f = fixture();
    const key = await f.call("POST", "/api/routines", {
      ...draft,
      instruction: `use gsk_${"a".repeat(32)}`,
    });
    expect(key.status).toBe(400);
    expect(await key.text()).toBe("Recognised API keys belong in Keys, not routine text.");
    const ok = await f.call("POST", "/api/routines", {
      ...draft,
      instruction: "use ld_web_0123456789abcdefghijkl_abcdef",
    });
    expect((await f.json(ok)).instruction).toBe("use [key]");
  });

  it("explains a custom rule it cannot use", async () => {
    const f = fixture();
    const res = await f.call("POST", "/api/routines", {
      ...draft,
      when: { kind: "custom", rule: "FREQ=HOURLY;BYHOUR=9" },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("FREQ must be DAILY, WEEKLY or MONTHLY.");
  });

  it("refuses a stale revision and never touches a run in flight", async () => {
    const f = fixture();
    const created = await f.json(f.call("POST", "/api/routines", draft));
    const run = f.store.recordRun({
      routineId: created.id,
      dueAt: 1,
      startedAt: 2,
      endedAt: null,
      sessionId: ulid(),
      outcome: "running",
      note: "",
    });
    expect(
      (await f.call("PUT", `/api/routines/${created.id}`, { revision: 1, instruction: "New text" }))
        .status,
    ).toBe(200);
    expect(
      (await f.call("PUT", `/api/routines/${created.id}`, { revision: 1, name: "Phone edit" }))
        .status,
    ).toBe(409);
    expect(f.store.get(created.id)).toMatchObject({
      name: "Morning bills",
      instruction: "New text",
      revision: 2,
    });
    expect(f.store.runs(created.id)[0]).toEqual(run);
  });

  it("confirms a proposal once, with the user's edits", async () => {
    const f = fixture();
    const proposed = f.store.create(draft as never, {
      state: "proposed",
      createdFromSession: ulid(),
    });
    const res = await f.call("POST", `/api/routines/${proposed.id}/confirm`, {
      revision: 1,
      edits: { budgetUSD: 1 },
    });
    expect(await f.json(res)).toMatchObject({ state: "active", budgetUSD: 1, revision: 2 });
    expect(
      (await f.call("POST", `/api/routines/${proposed.id}/confirm`, { revision: 2 })).status,
    ).toBe(409);
  });

  it("runs now and answers at once, but not a proposal", async () => {
    const f = fixture();
    const created = await f.json(f.call("POST", "/api/routines", draft));
    const res = await f.call("POST", `/api/routines/${created.id}/run`);
    expect(res.status).toBe(202);
    expect((await f.json<{ runId: string }>(res)).runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(f.deps.launcher.runNow).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.id }),
    );
    const proposed = f.store.create(draft as never, { state: "proposed" });
    expect((await f.call("POST", `/api/routines/${proposed.id}/run`)).status).toBe(409);
  });

  it("lists routines with the Mac's zone and start-at-login state, without follow-ups", async () => {
    const f = fixture();
    await f.call("POST", "/api/routines", draft);
    f.store.create(
      {
        name: "Follow-up",
        instruction: "x",
        when: { kind: "once", date: "2026-10-12", time: "15:00" },
      },
      { state: "active", kind: "follow_up", followUp: { sessionId: ulid(), note: "x" } },
    );
    const reply = RoutineListReply.parse(await (await f.call("GET", "/api/routines")).json());
    expect(reply).toMatchObject({ timeZone: "Europe/London", startAtLogin: "off" });
    expect(reply.routines).toHaveLength(1);
  });

  it("still lists every routine once ignored proposals and finished one-offs pile up", async () => {
    const f = fixture();
    for (let i = 0; i < 40; i++) {
      const once = f.store.create({ ...draft, name: `Once ${i}` }, { state: "active" });
      f.store.setState(once.id, "finished", null);
    }
    for (let i = 0; i < 15; i++) {
      const session = ulid();
      for (let j = 0; j < 3; j++)
        f.store.create(draft, { state: "proposed", createdFromSession: session });
    }
    for (let i = 0; i < 50; i++) {
      const res = await f.call("POST", "/api/routines", { ...draft, name: `R${i}` });
      expect(res.status).toBe(201);
    }
    const res = await f.call("GET", "/api/routines");
    expect(res.status).toBe(200);
    const reply = RoutineListReply.parse(await res.json());
    expect(reply.routines).toHaveLength(100);
    expect(reply.routines.filter((r) => r.state === "active")).toHaveLength(50);
  });

  it("still lists routines when the start-at-login record cannot be read", async () => {
    const f = fixture();
    f.deps.startAtLogin.status.mockRejectedValue(new StartAtLoginError("unreadable"));
    const reply = RoutineListReply.parse(await (await f.call("GET", "/api/routines")).json());
    expect(reply.startAtLogin).toBe("unavailable");
  });

  it("pauses, resumes, deletes with the current revision, and resumes only what Stop everything paused", async () => {
    const f = fixture();
    const a = await f.json(f.call("POST", "/api/routines", draft));
    const b = await f.json(f.call("POST", "/api/routines", draft));
    expect(
      await (await f.call("PUT", `/api/routines/${b.id}`, { revision: 1, state: "paused" })).json(),
    ).toMatchObject({ state: "paused", pausedReason: "user" });
    f.store.pauseAllActive("stop_all");
    expect(await (await f.call("POST", "/api/routines/resume")).json()).toEqual({ resumed: 1 });
    expect(f.store.get(a.id)?.state).toBe("active");
    expect(f.store.get(b.id)?.state).toBe("paused");
    expect((await f.call("DELETE", `/api/routines/${b.id}?revision=1`)).status).toBe(409);
    expect((await f.call("DELETE", `/api/routines/${b.id}?revision=2`)).status).toBe(204);
  });

  it("serves a routine's run history newest first", async () => {
    const f = fixture();
    const created = await f.json(f.call("POST", "/api/routines", draft));
    for (const [dueAt, outcome] of [
      [1, "done"],
      [2, "missed"],
    ] as const)
      f.store.recordRun({
        routineId: created.id,
        dueAt,
        startedAt: null,
        endedAt: dueAt,
        sessionId: null,
        outcome,
        note: "",
      });
    const reply = await f.json<{ runs: { outcome: string }[] }>(
      f.call("GET", `/api/routines/${created.id}/runs`),
    );
    expect(reply.runs.map((r) => r.outcome)).toEqual(["missed", "done"]);
  });

  it("turns start at login on and off", async () => {
    const f = fixture();
    expect(await (await f.call("PUT", "/api/start-at-login", { enabled: true })).json()).toEqual({
      state: "on",
    });
    await f.call("POST", "/api/routines", draft);
    expect(await (await f.call("PUT", "/api/start-at-login", { enabled: false })).json()).toEqual({
      state: "off",
    });
    f.deps.startAtLogin.set.mockRejectedValueOnce(new StartAtLoginError("Try again in a minute."));
    const failed = await f.call("PUT", "/api/start-at-login", { enabled: true });
    expect(failed.status).toBe(503);
    expect(await failed.text()).toBe("Try again in a minute.");
  });

  it("stops everything once for two concurrent requests and says who asked", async () => {
    const f = fixture();
    const first = f.call("POST", "/api/stop-all?by=cli");
    const second = f.call("POST", "/api/stop-all");
    await vi.waitFor(() => expect(f.deps.stopAll).toHaveBeenCalledTimes(1));
    f.release();
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(await a.json()).toEqual(stopped);
    expect(await b.json()).toEqual(stopped);
    expect(f.deps.stopAll).toHaveBeenCalledTimes(1);
    expect(f.deps.stopAll).toHaveBeenCalledWith("cli");
    await f.call("POST", "/api/stop-all?by=other");
    expect(f.deps.stopAll).toHaveBeenLastCalledWith("user");
  });
});
