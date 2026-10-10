import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AppUpdatePreferences } from "../../../../packages/protocol/src/app-update.ts";
import type { AppUpdater } from "./app-updater.ts";

export function appUpdateRoutes(app: Hono, updater: AppUpdater) {
  app.use("/api/app-update/*", bodyLimit({ maxSize: 1024 }));
  app.get("/api/app-update", async (c) => {
    c.header("cache-control", "no-store");
    return c.json(await updater.status());
  });
  for (const operation of ["check", "download"] as const) {
    app.post(`/api/app-update/${operation}`, async (c) => {
      if (!(await updater.status()).supported)
        return c.text("Updates work in the installed app.", 409);
      // Return acceptance immediately; a download can take minutes. State is polled, not held in HTTP.
      void updater[operation]().catch(() => {});
      return c.json({ accepted: true }, 202);
    });
  }
  app.post("/api/app-update/install", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (body?.confirmShutdown !== true || Object.keys(body).length !== 1)
      return c.text("Confirm shutdown to install.", 400);
    try {
      await updater.install();
      return c.json({ accepted: true }, 202);
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Update couldn't start.", 409);
    }
  });
  app.post("/api/app-update/dismiss", async (c) => {
    await updater.dismiss();
    return c.json({ ok: true });
  });
  app.put("/api/app-update/preferences", async (c) => {
    const input = AppUpdatePreferences.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.text("Invalid update preferences.", 400);
    if (!(await updater.status()).supported)
      return c.text("Updates work in the installed app.", 409);
    await updater.preferences(input.data);
    return c.json(await updater.status());
  });
}
