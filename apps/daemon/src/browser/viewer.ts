import { ULID_PATTERN } from "@localdot/protocol";
import type { Hono } from "hono";
import type { StreamProxyDeps } from "../cells/stream-proxy.ts";
import type { BrowserStreams } from "./streams.ts";

export interface BrowserViewerDeps extends StreamProxyDeps {
  cells: Pick<BrowserStreams, "forParent" | "get" | "subscribe" | "endpoints" | "updateStream">;
}

// Mount only behind the daemon's install-token middleware. The physical browser ID,
// its ticket and its socket state are distinct from those of the parent desktop.
export function browserViewerApi(app: Hono, deps: BrowserViewerDeps): void {
  app.get("/api/browsers/:id", (c) => {
    const id = c.req.param("id");
    if (!ULID_PATTERN.test(id)) return c.text("invalid browser id", 400);
    const cell = deps.cells.get(id);
    return cell ? c.json(cell) : c.text("the browser is unavailable", 404);
  });
  app.post("/api/cells/:id/browser-stream-ticket", (c) => {
    const parentId = c.req.param("id");
    if (!ULID_PATTERN.test(parentId)) return c.text("invalid computer id", 400);
    const cell = deps.cells.forParent(parentId);
    if (!cell || cell.state !== "ready" || cell.paused || cell.fenced || cell.replacementPending)
      return c.text("the browser is unavailable", 409);
    const ticket = deps.tickets.issue(cell.id, c.get("remoteGrant")?.id, c.get("remoteValid"));
    return c.json({ ticket, cellId: cell.id, path: `/cells/${cell.id}/browser/${ticket}/` });
  });
}
