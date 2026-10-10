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
