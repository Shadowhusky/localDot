import { describe, expect, it } from "vitest";
import { runComputer } from "./computer.ts";
import { LocalApiError } from "./local-dot.ts";
import { fakeLocalDot, type Route } from "./testing/fake-local-dot.ts";

const CELL = "01JXYZ00000000000000000001";
const OTHER = "01JXYZ00000000000000000002";
const SESSION = "01JXYZ00000000000000000009";

// One computer whose state follows the start and stop requests, a poll at a time.
function computer(initial: string, extra: Record<string, Route> = {}) {
  let state = initial;
  let pending: string | undefined;
  const row = () => ({ id: CELL, state });
  const f = fakeLocalDot({
    routes: {
      "GET /api/cells": () => [row()],
      [`GET /api/cells/${CELL}`]: () => {
        if (pending) [state, pending] = [pending, undefined];
        return row();
      },
      [`POST /api/cells/${CELL}/start`]: () => {
        state = "starting";
        pending = "ready";
      },
      [`POST /api/cells/${CELL}/stop`]: () => {
        state = "stopped";
      },
      ...extra,
    },
  });
  return f;
}

describe("localdot computer", () => {
  it("lists computers with the task running on each", async () => {
    const f = fakeLocalDot({
      routes: {
        "GET /api/cells": [
          { id: CELL, state: "ready", paused: true },
          { id: OTHER, state: "failed", error: "Docker isn't running" },
          { id: "01JXYZ00000000000000000003", state: "removed" },
        ],
        [`GET /api/cells/${CELL}/live`]: { sessionId: SESSION },
      },
    });
    expect(await runComputer(f.l, f.io, { operation: "list", json: false })).toBe(0);
    expect(f.out).toEqual([
      `${CELL}  frozen (localdot computer resume), a task is running`,
      `${OTHER}  failed, Docker isn't running`,
    ]);
  });

  it("starts a stopped computer and waits until it is running", async () => {
    const f = computer("stopped");
    expect(await runComputer(f.l, f.io, { operation: "start", json: false })).toBe(0);
    expect(f.calls).toContain(`POST /api/cells/${CELL}/start`);
    expect(f.out.at(-1)).toBe(`Computer ${CELL} is running.`);
  });

  it("creates the first computer when there is none", async () => {
    let made = false;
    const f = fakeLocalDot({
      routes: {
        "GET /api/cells": () => (made ? [{ id: CELL, state: "ready" }] : []),
        "POST /api/cells": (body: unknown) => {
          expect(body).toEqual({ scale: 2 });
          made = true;
          return { id: CELL, state: "starting" };
        },
        [`GET /api/cells/${CELL}`]: { id: CELL, state: "ready" },
      },
    });
    expect(await runComputer(f.l, f.io, { operation: "start", json: false })).toBe(0);
    expect(f.out).toEqual(["Creating a computer…", `Computer ${CELL} is running.`]);
  });

  it("won't stop or restart a computer under a running task", async () => {
    for (const operation of ["stop", "restart"] as const) {
      const f = computer("ready", { [`GET /api/cells/${CELL}/live`]: { sessionId: SESSION } });
      await expect(runComputer(f.l, f.io, { operation, json: false })).rejects.toThrow(
        `A task is running on computer ${CELL}. Stop the task first with localdot stop --cell ${CELL}`,
      );
      expect(f.calls).not.toContain(`POST /api/cells/${CELL}/stop`);
    }
  });

  it("restarts a computer: stopped, then started again", async () => {
    const f = computer("ready");
    expect(await runComputer(f.l, f.io, { operation: "restart", json: false })).toBe(0);
    expect(f.calls.filter((call) => call.startsWith("POST"))).toEqual([
      `POST /api/cells/${CELL}/stop`,
      `POST /api/cells/${CELL}/start`,
    ]);
  });

  it("shows the app's refusal, such as too little memory", async () => {
    const f = computer("stopped", {
      [`POST /api/cells/${CELL}/start`]: new LocalApiError(409, "Docker needs more memory."),
    });
    await expect(runComputer(f.l, f.io, { operation: "start", json: false })).rejects.toThrow(
      `Computer ${CELL} couldn't start: Docker needs more memory.`,
    );
  });

  it("resumes a frozen computer, and asks which computer when there are several", async () => {
    const f = fakeLocalDot({
      routes: {
        "GET /api/cells": [
          { id: CELL, state: "ready", paused: true },
          { id: OTHER, state: "stopped" },
        ],
        [`POST /api/cells/${CELL}/resume`]: undefined,
      },
    });
    f.m.routes[`POST /api/cells/${CELL}/resume`] = () => undefined;
    await expect(runComputer(f.l, f.io, { operation: "resume", json: false })).rejects.toThrow(
      /There are 2 computers\. Choose one with --cell <id>:\n {2}01JXYZ00000000000000000001 {2}frozen/,
    );
    expect(await runComputer(f.l, f.io, { operation: "resume", cellId: CELL, json: false })).toBe(
      0,
    );
    expect(f.out.at(-1)).toContain("resumed with fresh key stand-ins");
    await expect(
      runComputer(f.l, f.io, {
        operation: "stop",
        cellId: "01JXYZ00000000000000000004",
        json: false,
      }),
    ).rejects.toThrow("There's no computer 01JXYZ00000000000000000004 here.");
  });

  it("reports a computer that fails to start", async () => {
    const f = computer("stopped", {
      [`GET /api/cells/${CELL}`]: { id: CELL, state: "failed", error: "Images are missing." },
    });
    await expect(runComputer(f.l, f.io, { operation: "start", json: false })).rejects.toThrow(
      `Computer ${CELL} couldn't start: Images are missing.`,
    );
  });
});
