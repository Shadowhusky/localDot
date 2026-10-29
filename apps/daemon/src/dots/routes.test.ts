import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { DotJob } from "../../../../packages/protocol/src/dots.ts";
import { DotsError, type DotsRoutesDeps, dotsRoutes } from "./routes.ts";

const job: DotJob = { id: "j".repeat(22), kind: "add", state: "running", step: "Starting" };
const sealed = { v: 1, epk: "e".repeat(87), nonce: "n".repeat(16), ct: "c".repeat(40) };

function app(overrides: Partial<DotsRoutesDeps> = {}) {
  const deps: DotsRoutesDeps = {
    list: vi.fn(async () => ({ dots: [], manage: true })),
    add: vi.fn(() => job),
    job: vi.fn((id: string) => (id === job.id ? job : undefined)),
    passphrase: vi.fn(() => job),
    cancel: vi.fn(() => ({ ...job, step: "Cancelling" })),
    start: vi.fn(() => ({ ...job, kind: "start" as const })),
    stop: vi.fn(() => {
      throw new DotsError(409, "Stop this dot from another dot.");
    }),
    remove: vi.fn(async () => ({ next: "http://127.0.0.1:4750/#code=x" })),
    signIn: vi.fn(async () => ({ url: "http://127.0.0.1:5750/#code=x" })),
    self: vi.fn(() => ({ busy: true, origins: [] })),
    ...overrides,
  };
  const routes = new Hono();
  dotsRoutes(routes, deps);
  return { routes, deps };
}
const post = (body: unknown, origin = "http://127.0.0.1:4750") => ({
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify(body),
});

describe("the dots API", () => {
  it("adds a dot only from a valid request, and reports jobs", async () => {
    const { routes, deps } = app();
    const added = await routes.request("/api/dots", post({ name: "Work", copy: ["keys"] }));
    expect(added.status).toBe(202);
    expect(await added.json()).toEqual(job);
    expect(deps.add).toHaveBeenCalledWith({ name: "Work", copy: ["keys"] });
    for (const body of [
      { name: "", copy: [] },
      { name: "Work", copy: ["tokens"] },
      { name: "Work", copy: [], extra: true },
      { name: "Work", from: "Not An Id", copy: [] },
    ])
      expect((await routes.request("/api/dots", post(body))).status, JSON.stringify(body)).toBe(
        400,
      );
    expect((await routes.request(`/api/dots/jobs/${job.id}`)).status).toBe(200);
    expect((await routes.request(`/api/dots/jobs/${"x".repeat(22)}`)).status).toBe(404);
  });

  it("relays only a sealed passphrase", async () => {
    const { routes, deps } = app();
    expect(
      (await routes.request(`/api/dots/jobs/${job.id}/passphrase`, post({ sealed }))).status,
    ).toBe(200);
    expect(deps.passphrase).toHaveBeenCalledWith(job.id, sealed);
    expect((await routes.request(`/api/dots/jobs/${job.id}/cancel`, post({}))).status).toBe(200);
    expect(deps.cancel).toHaveBeenCalledWith(job.id);
    expect(
      (await routes.request(`/api/dots/jobs/${job.id}/passphrase`, post({ passphrase: "x" })))
        .status,
    ).toBe(400);
  });

  it("starts, stops, removes and signs in by dot id, with the page's own origin", async () => {
    const { routes, deps } = app();
    expect((await routes.request("/api/dots/work/start", post({}))).status).toBe(202);
    const stop = await routes.request("/api/dots/main/stop", post({}));
    expect(stop.status).toBe(409);
    expect(await stop.text()).toBe("Stop this dot from another dot.");
    expect((await routes.request("/api/dots/Bad Id/start", post({}))).status).toBe(404);
    const removed = await routes.request(
      "/api/dots/work/remove",
      post({ deleteData: true }, "https://studio.example.ts.net:5750"),
    );
    expect(removed.status).toBe(202);
    expect(deps.remove).toHaveBeenCalledWith("work", true, "https://studio.example.ts.net:5750");
    expect((await routes.request("/api/dots/work/remove", post({}))).status).toBe(400);
    const signIn = await routes.request("/api/dots/work/sign-in", post({}));
    expect(signIn.headers.get("cache-control")).toBe("no-store");
    expect(await signIn.json()).toEqual({ url: "http://127.0.0.1:5750/#code=x" });
    expect(await (await routes.request("/api/dots/self")).json()).toEqual({
      busy: true,
      origins: [],
    });
  });
});
