import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { RemoteGrant } from "../remote/links.ts";
import { PreviewError } from "./previews.ts";
import { previewRoutes } from "./routes.ts";

const TASK = "01JXYZ0000000000000000TASK";

function app(guest = false) {
  const calls: unknown[][] = [];
  const hono = new Hono();
  hono.use("*", async (c, next) => {
    if (guest) c.set("remoteGrant", { id: "link" } as RemoteGrant);
    await next();
  });
  previewRoutes(hono, {
    status: async (...args) => {
      calls.push(["status", ...args]);
      return { state: "ready", addresses: [], previews: [], servers: [] };
    },
    open: async (...args) => {
      calls.push(["open", ...args]);
      if ("url" in args[1] && args[1].url.includes("example.com"))
        throw new PreviewError(400, { message: "not in your computer" });
      if ("port" in args[1])
        throw new PreviewError(409, { state: "needs-update", message: "Update" });
      return {
        preview: {
          id: "p",
          target: "http://localhost:5173/",
          origin: "https://h:4900",
          openedAt: "x",
        },
        open: "https://h:4900/__localdot/preview#s",
      };
    },
    stop: (...args) => {
      calls.push(["stop", ...args]);
      return args[1] === "p";
    },
  });
  return { hono, calls };
}

const post = (body: unknown) => ({
  method: "POST",
  headers: { host: "100.91.187.75:4744", "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("preview routes", () => {
  it("pass the asking host on and map refusals to their status", async () => {
    const { hono, calls } = app();
    const status = await hono.request(`/api/sessions/${TASK}/previews`, {
      headers: { host: "100.91.187.75:4744" },
    });
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    const opened = await hono.request(
      `/api/sessions/${TASK}/previews`,
      post({ url: "http://localhost:5173/" }),
    );
    expect(await opened.json()).toMatchObject({ open: "https://h:4900/__localdot/preview#s" });
    expect(calls[1]).toEqual([
      "open",
      TASK,
      { url: "http://localhost:5173/" },
      "100.91.187.75:4744",
    ]);
    const refused = await hono.request(
      `/api/sessions/${TASK}/previews`,
      post({ url: "https://example.com/" }),
    );
    expect(refused.status).toBe(400);
    const old = await hono.request(`/api/sessions/${TASK}/previews`, post({ port: 5173 }));
    expect(old.status).toBe(409);
    expect(await old.json()).toEqual({ state: "needs-update", message: "Update" });
    expect(
      (await hono.request(`/api/sessions/${TASK}/previews`, post({ url: 5, extra: true }))).status,
    ).toBe(400);
    expect(
      (await hono.request(`/api/sessions/${TASK}/previews/p`, { method: "DELETE" })).status,
    ).toBe(204);
    expect(
      (await hono.request(`/api/sessions/${TASK}/previews/q`, { method: "DELETE" })).status,
    ).toBe(404);
    expect((await hono.request("/api/sessions/not-a-task/previews")).status).toBe(400);
  });

  it("are for the owner only", async () => {
    const { hono, calls } = app(true);
    expect((await hono.request(`/api/sessions/${TASK}/previews`)).status).toBe(403);
    expect(
      (await hono.request(`/api/sessions/${TASK}/previews`, post({ url: "http://localhost:1/" })))
        .status,
    ).toBe(403);
    expect(
      (await hono.request(`/api/sessions/${TASK}/previews/p`, { method: "DELETE" })).status,
    ).toBe(403);
    expect(calls).toEqual([]);
  });
});
