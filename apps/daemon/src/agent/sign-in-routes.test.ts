import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { type AgentRoutesDeps, agentRoutes } from "./routes.ts";
import { AgentError } from "./runner.ts";

const fixtures: (() => void)[] = [];
afterEach(() => {
  for (const close of fixtures.splice(0)) close();
});

function routes(page?: string | Error) {
  const home = mkdtempSync(join(tmpdir(), "localdot-sign-in-")),
    log = new EventLog(home),
    cellId = ulid(),
    sessionId = ulid(),
    requestId = ulid();
  const unused = () => {
    throw new Error("unexpected dependency access");
  };
  const signIn = vi.fn(async (_cell: string, _site: string, _url: string) => ({
    sessionId,
    requestId,
  }));
  const desktopPage = vi.fn(async () => {
    if (page instanceof Error) throw page;
    return page;
  });
  const deps: AgentRoutesDeps = {
    runner: { start: unused, get: () => undefined, raiseBudget: unused, signIn },
    settings: { get: unused, put: unused },
    catalog: { get: unused, refresh: unused },
    keyd: { secrets: unused },
    memory: {
      readBoth: unused,
      undo: unused,
      entries: unused,
      notes: unused,
      addEntry: unused,
      editEntry: unused,
      deleteEntry: unused,
    },
    skills: () => [],
    desktop: unused,
    desktopPage,
    redactUserText: (text) => text,
    appendTo: unused,
    home,
  };
  const app = createApp({ token: "inert-token", port: 4747, eventLog: log });
  agentRoutes(app, deps);
  fixtures.push(() => {
    log.close();
    rmSync(home, { force: true, recursive: true });
  });
  const request = (path: string, body?: unknown) =>
    app.request(`http://127.0.0.1:4747${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer inert-token",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { cellId, sessionId, requestId, signIn, desktopPage, request };
}

describe("signing in to a site from Settings", () => {
  it("opens the site's own sign-in page and names the control the user holds", async () => {
    const f = routes();
    const reply = await f.request(`/api/cells/${f.cellId}/accounts/sign-in`, {
      site: "www.google.com",
    });
    expect(reply.status).toBe(202);
    expect(await reply.json()).toEqual({ sessionId: f.sessionId, requestId: f.requestId });
    expect(f.signIn).toHaveBeenCalledWith(
      f.cellId,
      "google.com",
      "https://accounts.google.com/",
      expect.any(AbortSignal),
    );
  });

  it("opens any other public site's home page", async () => {
    const f = routes();
    await f.request(`/api/cells/${f.cellId}/accounts/sign-in`, { site: "jev-games.com" });
    expect(f.signIn).toHaveBeenCalledWith(
      f.cellId,
      "jev-games.com",
      "https://jev-games.com/",
      expect.any(AbortSignal),
    );
  });

  it("opens nothing but a named public site", async () => {
    const f = routes();
    for (const body of [
      { site: "localhost" },
      { site: "printer.local" },
      { site: "https://google.com" },
      { site: "google.com", url: "https://evil.example/" },
      {},
    ])
      expect(
        (await f.request(`/api/cells/${f.cellId}/accounts/sign-in`, body)).status,
        JSON.stringify(body),
      ).toBe(400);
    expect(
      (await f.request("/api/cells/not-a-computer/accounts/sign-in", { site: "google.com" }))
        .status,
    ).toBe(400);
    expect(f.signIn).not.toHaveBeenCalled();
  });

  it("refuses while dot is at work", async () => {
    const f = routes();
    f.signIn.mockRejectedValueOnce(new AgentError(409, "dot is using the computer"));
    expect(
      (await f.request(`/api/cells/${f.cellId}/accounts/sign-in`, { site: "google.com" })).status,
    ).toBe(409);
  });
});

describe("a sign-in in the desktop's own browser", () => {
  it("names the site its sign-in page belongs to", async () => {
    const f = routes("https://accounts.google.com/v3/signin/identifier");
    const reply = await f.request(`/api/cells/${f.cellId}/desktop-sign-in`);
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ site: "google.com" });
  });

  it("names nothing on an ordinary page, with the browser closed, or on a computer that is off", async () => {
    for (const page of ["https://news.example.com/", undefined, new Error("no page")]) {
      const f = routes(page);
      expect(await (await f.request(`/api/cells/${f.cellId}/desktop-sign-in`)).json()).toEqual({
        site: null,
      });
    }
  });
});
