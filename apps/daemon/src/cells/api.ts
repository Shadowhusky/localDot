import { ULID_PATTERN } from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { DockerError } from "./docker.ts";
import {
  type CellApi,
  CellControlConflict,
  SkippedCellsError,
  UnknownCellError,
} from "./orchestrator.ts";
import type { TicketRegistry } from "./secrets.ts";

export interface CellApiDeps {
  cells: CellApi;
  tickets: TicketRegistry;
}

export function cellRoutes(app: Hono, { cells, tickets }: CellApiDeps): void {
  // A stream ticket lives only while its cell is ready (P2-R2): stopping, failing or removing the
  // cell revokes it, so no stream path stays open for a computer that is off.
  cells.subscribe((cell) => {
    if (cell.state !== "ready" || cell.paused) tickets.revoke(cell.id);
  });

  app.get("/api/cells", (c) => c.json(cells.list()));

  // The only option is the scale, so anything near a kilobyte is not a create request.
  app.post("/api/cells", bodyLimit({ maxSize: 1024 }), async (c) => {
    const body = ((await c.req.json().catch(() => null)) ?? {}) as { scale?: unknown };
    const scale =
      body.scale === undefined || body.scale === 2 ? 2 : body.scale === 1 ? 1 : undefined;
    if (scale === undefined) return c.text("scale must be 1 or 2", 400);
    return withDocker(c, async () => c.json(await cells.create({ scale }), 202));
  });

  app.get("/api/cells/:id", (c) =>
    withCell(c, (id) => {
      const cell = cells.get(id);
      return cell ? c.json(cell) : c.text("unknown cell", 404);
    }),
  );

  app.post("/api/cells/:id/start", (c) =>
    withCell(c, (id) =>
      withDocker(c, async () => {
        await cells.start(id);
        return c.body(null, 202);
      }),
    ),
  );

  app.post("/api/cells/:id/stop", (c) =>
    withCell(c, (id) =>
      withDocker(c, async () => {
        await cells.stop(id);
        return c.body(null, 202);
      }),
    ),
  );

  app.delete("/api/cells/:id", (c) =>
    withCell(c, (id) =>
      withDocker(c, async () => {
        // Even a removal that fails part-way leaves no stream path open to the cell.
        try {
          await cells.remove(id, { purgeHome: c.req.query("purge") === "1" });
        } finally {
          tickets.revoke(id);
        }
        return c.body(null, 204);
      }),
    ),
  );

  app.post("/api/cells/:id/stream-ticket", (c) =>
    withCell(c, (id) => {
      const cell = cells.get(id);
      if (!cell) return c.text("unknown cell", 404);
      if (cell.state !== "ready") return c.text(`cell is ${cell.state}`, 409);
      if (cell.paused) return c.text("the computer is paused: resume it first", 409);
      // The registry hands back the cell's live ticket, so a second viewer shares the same path.
      const ticket = tickets.issue(id);
      return c.json({ ticket, path: `/cells/${id}/desktop/${ticket}/` });
    }),
  );
}

function withCell(
  c: Context,
  fn: (id: string) => Response | Promise<Response>,
): Response | Promise<Response> {
  const id = c.req.param("id") ?? "";
  if (!ULID_PATTERN.test(id)) return c.text("invalid cell id", 400);
  return fn(id);
}

async function withDocker(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CellControlConflict) return c.text(err.message, 409);
    if (err instanceof UnknownCellError) return c.text("unknown cell", 404);
    if (err instanceof SkippedCellsError) return c.text(err.message, 409);
    if (err instanceof DockerError) return c.text(err.message, 502);
    throw err;
  }
}
