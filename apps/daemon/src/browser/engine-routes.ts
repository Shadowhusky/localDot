import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  BrowserEngineRequest,
  BrowserEngineStatus,
} from "../../../../packages/protocol/src/browser-engine.ts";
import { BrowserEngineRefusal } from "../cells/browser-engine.ts";
import type { BrowserOrchestrator } from "../cells/browser-orchestrator.ts";

export type BrowserEngineDeps = Pick<
  BrowserOrchestrator,
  "engineStatus" | "chooseEngine" | "restoreEngineBackup" | "dropEngineBackup"
>;

// Which browser dot's web browser runs: Chromium from the release, or Google Chrome installed here
// once the user accepts Google's terms. Mount behind the daemon's install-token middleware.
export function browserEngineRoutes(app: Hono, deps: BrowserEngineDeps): void {
  const status = async () => BrowserEngineStatus.parse(await deps.engineStatus());

  app.get("/api/browser/engine", async (c) => c.json(await status()));

  app.put("/api/browser/engine", bodyLimit({ maxSize: 1024 }), async (c) => {
    const request = BrowserEngineRequest.safeParse(await c.req.json().catch(() => null));
    if (!request.success)
      return c.text("choose a browser, accepting Google's terms for Chrome", 400);
    try {
      await deps.chooseEngine(request.data);
    } catch (error) {
      if (error instanceof BrowserEngineRefusal) return c.text(error.message, 409);
      throw error;
    }
    return c.json(await status());
  });

  app.post("/api/browser/engine/restore", async (c) => {
    try {
      await deps.restoreEngineBackup();
    } catch (error) {
      return c.text(
        error instanceof Error && error.message
          ? error.message
          : "the backup could not be restored; try again",
        409,
      );
    }
    return c.json(await status());
  });

  app.delete("/api/browser/engine/backup", async (c) => {
    await deps.dropEngineBackup();
    return c.json(await status());
  });
}
