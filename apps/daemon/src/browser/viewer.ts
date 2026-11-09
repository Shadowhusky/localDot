import { ULID_PATTERN } from "@localdot/protocol";
import type { Hono } from "hono";
import type { StreamProxyDeps } from "../cells/stream-proxy.ts";
import type { CellSummary } from "../cells/types.ts";
import type { BrowserStreams } from "./streams.ts";

export interface BrowserViewerDeps extends StreamProxyDeps {
  cells: Pick<
    BrowserStreams,
    "forParent" | "forKey" | "ownerOf" | "get" | "subscribe" | "endpoints" | "updateStream"
  >;
  // The web browser a task uses, or its conversation last used: a computer's id for its main one.
  browserOf?(sessionId: string, parentCellId: string): string | undefined;
  // Whether a shared link may see a task.
  sees?(grantId: string, sessionId: string): boolean;
}

const usable = (cell: CellSummary | undefined): cell is CellSummary =>
  !!cell && cell.state === "ready" && !cell.paused && !cell.fenced && !cell.replacementPending;

// Mount only behind the daemon's install-token middleware. The physical browser ID,
// its ticket and its socket state are distinct from those of the parent desktop.
export function browserViewerApi(app: Hono, deps: BrowserViewerDeps): void {
  app.get("/api/browsers/:id", (c) => {
    const id = c.req.param("id");
    if (!ULID_PATTERN.test(id)) return c.text("invalid browser id", 400);
    const cell = deps.cells.get(id);
    return cell ? c.json(cell) : c.text("the browser is unavailable", 404);
  });
  // `browser` names the browser wanted, `task` the task whose browser it is. A computer has its
  // main browser and conversations' own; a shared link reaches a conversation's own browser only
  // through a task it may see that uses it.
  app.post("/api/cells/:id/browser-stream-ticket", (c) => {
    const parentId = c.req.param("id");
    const wanted = c.req.query("browser");
    const sessionId = c.req.query("task");
    if (
      !ULID_PATTERN.test(parentId) ||
      (wanted !== undefined && !ULID_PATTERN.test(wanted)) ||
      (sessionId !== undefined && !ULID_PATTERN.test(sessionId))
    )
      return c.text("invalid computer id", 400);
    const grant = c.get("remoteGrant") as { id: string } | undefined;
    const sessionKey = sessionId ? deps.browserOf?.(sessionId, parentId) : undefined;
    const seen = !grant || (!!sessionId && deps.sees?.(grant.id, sessionId) === true);
    let key = parentId;
    if (wanted) {
      const owner = deps.cells.ownerOf(wanted);
      if (!owner || owner.parentCellId !== parentId)
        return c.text("the browser is unavailable", 409);
      key = owner.key;
    } else if (sessionKey && seen) key = sessionKey;
    if (grant && key !== parentId && (!seen || sessionKey !== key))
      return c.text("This link does not allow that action", 403);
    const cell = deps.cells.forKey(key);
    if (!usable(cell)) return c.text("the browser is unavailable", 409);
    const ticket = deps.tickets.issue(cell.id, c.get("remoteGrant")?.id, c.get("remoteValid"));
    return c.json({ ticket, cellId: cell.id, path: `/cells/${cell.id}/browser/${ticket}/` });
  });
}
