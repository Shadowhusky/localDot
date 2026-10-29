import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { BrowserStatus } from "../../../../packages/protocol/src/browser-control.ts";
import type { ReadyBrowser } from "../cells/browser-orchestrator.ts";
import type { CellSummary } from "../cells/types.ts";
import { type BrowserStatusDeps, browserStatusRoutes } from "./status-routes.ts";

const parent = "01JXYZ0000000000000000000A";

function fixture(status: BrowserStatus) {
  const restarted = Promise.withResolvers<ReadyBrowser>();
  const deps = {
    cells: { get: (id: string) => (id === parent ? ({ id } as CellSummary) : undefined) },
    browser: {
      status: vi.fn(async () => status),
      restart: vi.fn(() => restarted.promise),
    },
    report: vi.fn(),
  } satisfies BrowserStatusDeps;
  const app = new Hono();
  browserStatusRoutes(app, deps);
  return { app, deps, restarted };
}

describe("the web browser's status and restart", () => {
  it("reports the browser's state and what last went wrong", async () => {
    const status: BrowserStatus = {
      state: "ready",
      restarts: 1,
      problem: "A tab crashed (renderer oom) and was reloaded.",
      problemAt: "2026-10-26T12:00:00.000Z",
    };
    const f = fixture(status);
    const response = await f.app.request(`/api/cells/${parent}/browser`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(status);
    expect((await f.app.request("/api/cells/not-a-computer/browser")).status).toBe(400);
    expect((await f.app.request("/api/cells/01JXYZ0000000000000000000B/browser")).status).toBe(404);
  });

  it("restarts the browser without waiting for it and keeps its sign-ins", async () => {
    const f = fixture({ state: "ready", restarts: 0 });
    const response = await f.app.request(`/api/cells/${parent}/browser/restart`, {
      method: "POST",
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ state: "restarting", restarts: 0 });
    expect(f.deps.browser.restart).toHaveBeenCalledWith(parent, "You restarted the web browser.");
    expect(f.deps.report).toHaveBeenCalledWith("the user restarted the web browser");
    f.restarted.reject(new Error("the start failed; the status says so"));
  });

  it("refuses to restart a browser whose computer is off", async () => {
    const off: BrowserStatus = { state: "off", problem: "The computer is not running." };
    const f = fixture(off);
    const response = await f.app.request(`/api/cells/${parent}/browser/restart`, {
      method: "POST",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(off);
    expect(f.deps.browser.restart).not.toHaveBeenCalled();
  });
});
