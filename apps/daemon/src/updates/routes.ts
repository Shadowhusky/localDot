import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  AppUpdatePreferences,
  type AppUpdateStatus,
} from "../../../../packages/protocol/src/app-update.ts";
import type { AppUpdater } from "./app-updater.ts";

// Pages from 0.1.0-rc.31 and earlier refuse a status with fields they don't know, and an open one
// must still see the new version answer to reload. Progress and notes go to pages that ask.
function reply(c: Context, { progress, notes, updating, unsupported, ...status }: AppUpdateStatus) {
  if (c.req.query("v") !== "2") return c.json(status);
  const current = { ...status, progress, updating, unsupported };
  // A page polling closely through an update keeps its copy of the notes.
  return c.json(c.req.query("notes") === "0" ? current : { ...current, notes });
}

export function appUpdateRoutes(app: Hono, updater: AppUpdater) {
  app.use("/api/app-update/*", bodyLimit({ maxSize: 1024 }));
  app.get("/api/app-update", async (c) => {
    c.header("cache-control", "no-store");
    return reply(c, await updater.status());
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
  for (const operation of ["update", "install"] as const) {
    app.post(`/api/app-update/${operation}`, async (c) => {
      const body = await c.req.json().catch(() => null);
      if (body?.confirmShutdown !== true || Object.keys(body).length !== 1)
        return c.text("Confirm shutdown to install.", 400);
      try {
        // Accepted once under way: the update goes on in the daemon, and pages read how it goes.
        await updater[operation]();
        return c.json({ accepted: true }, 202);
      } catch (error) {
        return c.text(error instanceof Error ? error.message : "Update couldn't start.", 409);
      }
    });
  }
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
    return reply(c, await updater.status());
  });
}
