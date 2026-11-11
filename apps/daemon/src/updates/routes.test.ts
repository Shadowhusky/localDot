import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { DEFAULT_APP_UPDATES } from "../../../../packages/protocol/src/app-update.ts";
import { AppUpdater } from "./app-updater.ts";
import { appUpdateRoutes } from "./routes.ts";

it("validates preferences and requires explicit shutdown confirmation", async () => {
  const updater = new AppUpdater(null);
  const install = vi.spyOn(updater, "install").mockResolvedValue();
  const app = new Hono();
  appUpdateRoutes(app, updater);
  expect((await app.request("/api/app-update")).status).toBe(200);
  expect((await app.request("/api/app-update/check", { method: "POST" })).status).toBe(409);
  expect(
    (
      await app.request("/api/app-update/preferences", {
        method: "PUT",
        body: JSON.stringify({ bogus: true }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await app.request("/api/app-update/preferences", {
        method: "PUT",
        body: JSON.stringify(DEFAULT_APP_UPDATES),
      })
    ).status,
  ).toBe(409);
  expect(
    (await app.request("/api/app-update/install", { method: "POST", body: "{}" })).status,
  ).toBe(400);
  expect(install).not.toHaveBeenCalled();
  expect(
    (
      await app.request("/api/app-update/install", {
        method: "POST",
        body: JSON.stringify({ confirmShutdown: true }),
      })
    ).status,
  ).toBe(202);
  expect(install).toHaveBeenCalledTimes(1);
});
it("sends progress and notes only to pages that ask, as older pages refuse unknown fields", async () => {
  const app = new Hono();
  appUpdateRoutes(app, new AppUpdater(null));
  const legacy = await (await app.request("/api/app-update")).json();
  expect(legacy).not.toHaveProperty("progress");
  expect(legacy).not.toHaveProperty("holders");
  expect(legacy).not.toHaveProperty("notes");
  expect(await (await app.request("/api/app-update?v=2")).json()).toMatchObject({
    progress: null,
    notes: [],
  });
});
it("hands Update now to the updater, and answers a held-back one with its reason", async () => {
  const updater = new AppUpdater(null);
  const update = vi.spyOn(updater, "update").mockResolvedValue();
  const app = new Hono();
  appUpdateRoutes(app, updater);
  const post = (body: unknown) =>
    app.request("/api/app-update/update", { method: "POST", body: JSON.stringify(body) });
  expect((await post({})).status).toBe(400);
  expect(update).not.toHaveBeenCalled();
  expect((await post({ confirmShutdown: true })).status).toBe(202);
  update.mockRejectedValue(new Error("Finish or stop the task before updating localDot."));
  const refused = await post({ confirmShutdown: true });
  expect(refused.status).toBe(409);
  expect(await refused.text()).toBe("Finish or stop the task before updating localDot.");
});
it("leaves notes out of the fast polls a page keeps its copy through", async () => {
  const app = new Hono();
  appUpdateRoutes(app, new AppUpdater(null));
  expect(await (await app.request("/api/app-update?v=2")).json()).toHaveProperty("notes");
  expect(await (await app.request("/api/app-update?v=2&notes=0")).json()).not.toHaveProperty(
    "notes",
  );
  const legacy = await (await app.request("/api/app-update")).json();
  expect(legacy).not.toHaveProperty("updating");
  expect(legacy).not.toHaveProperty("unsupported");
});

it("stops what holds the update back only with the shutdown confirmed, and calls a waiting update off", async () => {
  const updater = new AppUpdater(null);
  const stopAndUpdate = vi.spyOn(updater, "stopAndUpdate").mockResolvedValue();
  const cancel = vi.spyOn(updater, "cancel").mockResolvedValue();
  const app = new Hono();
  appUpdateRoutes(app, updater);
  const post = (path: string, body?: unknown) =>
    app.request(path, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  expect((await post("/api/app-update/stop-and-update", {})).status).toBe(400);
  expect(stopAndUpdate).not.toHaveBeenCalled();
  expect((await post("/api/app-update/stop-and-update", { confirmShutdown: true })).status).toBe(
    202,
  );
  expect(stopAndUpdate).toHaveBeenCalledOnce();
  expect((await post("/api/app-update/cancel")).status).toBe(200);
  expect(cancel).toHaveBeenCalledOnce();
});
