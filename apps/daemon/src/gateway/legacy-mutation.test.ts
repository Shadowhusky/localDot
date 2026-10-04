import { mkdtempSync, rmSync } from "node:fs";
import { ulid } from "@localdot/protocol";
import { expect, it } from "vitest";
import { createDesktopdApp } from "../../../../cells/desktop/desktopd/src/app.ts";
import type { XEvent, XHelper } from "../../../../cells/desktop/desktopd/src/x/helper.ts";
import { AgentSession } from "../agent/session.ts";
import { createApp } from "../app.ts";
import { TicketRegistry } from "../cells/secrets.ts";
import { FakeOrchestrator } from "../cells/testing/fake-orchestrator.ts";
import { NO_STREAM } from "../cells/types.ts";
import { monotonicClock } from "../clock.ts";
import { DesktopdRegistry } from "../desktopd/registry.ts";
import { EventLog } from "../event-log.ts";
import { LiveSessions } from "./live.ts";

it.each([
  ["input", false, false],
  ["input", true, false],
  ["launch", false, false],
  ["input", false, true],
  ["launch", false, true],
] as const)(
  "settles admitted idle %s before a later task can own the cell (cancelled=%s, lost reply=%s)",
  async (kind, cancelled, lostReply) => {
    const gate = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    const listeners = new Set<(event: XEvent) => void>();
    const live = new LiveSessions(),
      cells = new FakeOrchestrator(),
      cellId = ulid(),
      id = ulid();
    const injected: { owner: string | undefined; held: boolean }[] = [];
    const session = new AgentSession(id, cellId, "inert task", {
      append: () => undefined as never,
    });
    const x: XHelper = {
      alive: true,
      async call(cmd) {
        if (cmd === "arm") {
          entered.resolve();
          await gate.promise;
          return { mono: 1 } as never;
        }
        if (cmd === "click") {
          injected.push({ owner: live.get(cellId), held: session.controlHeld });
          for (const notify of listeners) {
            notify({ ev: "press", kind: "button", detail: 1, mono: 2 });
            notify({ ev: "release", kind: "button", detail: 1, mono: 3 });
          }
          return { button: 1, presses: 1 } as never;
        }
        throw Error("unexpected fixture command");
      },
      onEvent(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      async close() {},
    };
    const desktop = createDesktopdApp({
      token: "d".repeat(43),
      scale: 1,
      display: ":fixture",
      readScreen: async () => null,
      readXsettings: async () => null,
      x,
      launch: () => {
        injected.push({ owner: live.get(cellId), held: session.controlHeld });
        return { pid: 1001 };
      },
    });
    cells.emit({ id: cellId, state: "ready", scale: 1, createdAt: "", stream: NO_STREAM });
    cells.endpointsById.set(cellId, {
      desktopd: { baseUrl: "http://desktop.invalid", token: "d".repeat(43) },
      stream: { baseUrl: "http://stream.invalid", authorization: "fixture" },
    });
    const connectionLost = Promise.withResolvers<Response>();
    let nativeWork: Promise<Response> | undefined;
    const clock = monotonicClock(),
      registry = new DesktopdRegistry(cells, clock, async (url, init) => {
        const work = desktop.request(String(url), init);
        if (String(url).endsWith(`/${kind}`)) {
          nativeWork = Promise.resolve(work);
          if (lostReply) return Promise.race([nativeWork, connectionLost.promise]);
        }
        return work;
      });
    const home = mkdtempSync("/tmp/localdot-task10-raw-review-");
    const log = new EventLog(home);
    const app = createApp({
      eventLog: log,
      token: "fixture",
      port: 4747,
      cells: { cells, tickets: new TicketRegistry() },
      gateway: { registry, clock, live },
    });
    const caller = new AbortController();
    const send = (signal?: AbortSignal) =>
      app.request(`http://127.0.0.1:4747/api/cells/${cellId}/${kind}`, {
        method: "POST",
        headers: { authorization: "Bearer fixture", "content-type": "application/json" },
        ...(signal ? { signal } : {}),
        body: JSON.stringify(
          kind === "input"
            ? { input: { kind: "click", at: { x: 1, y: 1 }, button: "left", count: 1 } }
            : { app: "chromium", args: [] },
        ),
      });
    const work = Promise.resolve(send(caller.signal));
    let finish: () => void = () => {};
    let takeover: Promise<unknown> | undefined;
    try {
      await Promise.race([
        entered.promise,
        work.then((response) => {
          throw new Error(`Fixture input did not enter native edge: HTTP ${response.status}`);
        }),
      ]);
      if (cancelled) caller.abort();
      expect(live.idleOperationPending(cellId)).toBe(true);
      let admissionDenied = false;
      try {
        live.start(
          cellId,
          id,
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        );
      } catch (error) {
        expect((error as Error).message).toContain("still settling");
        admissionDenied = true;
      }
      if (!admissionDenied) {
        // A bypass reaches the actual held native edge, rather than failing on an early mock.
        session.beginBrain();
        takeover = session.takeover("login", "inert manual hold").catch(() => {});
        for (let i = 0; i < 5; i++) await Promise.resolve();
        expect(session.manualControl).toBe("ready");
      }
      if (lostReply) {
        connectionLost.reject(new Error("inert transport lost reply"));
        expect((await work).status).toBe(502);
        expect(live.idleOperationPending(cellId)).toBe(true);
      }
      expect((await send()).status).toBe(409);
      gate.resolve();
      expect((await work).status).toBe(lostReply ? 502 : 200);
      await nativeWork;
      expect(
        injected.filter((call) => call.owner === id && call.held),
        "an older idle native mutation must never execute inside a replacement task's held control",
      ).toEqual([]);
      expect(admissionDenied).toBe(true);
      expect(live.get(cellId)).toBeUndefined();
      expect(injected, "the idle positive must execute under its original ownership only").toEqual([
        { owner: undefined, held: false },
      ]);
      expect(live.idleOperationPending(cellId)).toBe(lostReply);
      if (lostReply) {
        expect(() => live.start(cellId, id, async () => {})).toThrow("still settling");
        return;
      }
      session.beginBrain();
      live.start(
        cellId,
        id,
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      takeover = session.takeover("login", "inert manual hold").catch(() => {});
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(session.manualControl).toBe("ready");
      expect((await send()).status).toBe(409);
      expect(injected.filter((call) => call.owner === id && call.held)).toEqual([]);
    } finally {
      gate.resolve();
      await work;
      session.stop();
      await takeover;
      finish();
      await live.settled(id);
      registry.dispose();
      log.close();
      rmSync(home, { recursive: true, force: true });
    }
  },
);
