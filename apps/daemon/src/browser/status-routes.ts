import { ULID_PATTERN } from "@localdot/protocol";
import type { Hono } from "hono";
import { BrowserStatus } from "../../../../packages/protocol/src/browser-control.ts";
import type { BrowserOrchestrator } from "../cells/browser-orchestrator.ts";
import type { CellApi } from "../cells/orchestrator.ts";

export interface BrowserStatusDeps {
  cells: Pick<CellApi, "get">;
  browser: Pick<BrowserOrchestrator, "status" | "restart">;
  report?(message: string): void;
}

// The web browser's state, what last went wrong with it, and a restart that keeps its sign-ins:
// for the app and `localdot browser`. Mount behind the daemon's install-token middleware.
export function browserStatusRoutes(app: Hono, deps: BrowserStatusDeps): void {
  app.get("/api/cells/:id/browser", async (c) => {
    const id = c.req.param("id");
    if (!ULID_PATTERN.test(id)) return c.text("invalid computer id", 400);
    if (!deps.cells.get(id)) return c.text("no such computer", 404);
    return c.json(BrowserStatus.parse(await deps.browser.status(id)));
  });

  app.post("/api/cells/:id/browser/restart", async (c) => {
    const id = c.req.param("id");
    if (!ULID_PATTERN.test(id)) return c.text("invalid computer id", 400);
    if (!deps.cells.get(id)) return c.text("no such computer", 404);
    const status = BrowserStatus.parse(await deps.browser.status(id));
    if (status.state === "off") return c.json(status, 409);
    deps.report?.("the user restarted the web browser");
    // The restart outlives the request; its outcome shows in the status.
    void deps.browser.restart(id, "You restarted the web browser.").catch(() => {});
    return c.json(BrowserStatus.parse({ ...status, state: "restarting" }), 202);
  });
}
