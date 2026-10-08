import { ReplacementRequest, ULID_PATTERN } from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ComputerResetRequest } from "../../../../packages/protocol/src/computer-reset.ts";
import { ReplacementConflict } from "../agent/safety/replacement.ts";
import type { createReplacementController } from "../agent/safety/replacement-controller.ts";
import { DockerError } from "./docker.ts";
import {
  type CellApi,
  CellControlConflict,
  SkippedCellsError,
  UnknownCellError,
} from "./orchestrator.ts";
import type { createComputerResetController } from "./reset-controller.ts";
import type { TicketRegistry } from "./secrets.ts";

export interface CellApiDeps {
  cells: CellApi;
  tickets: TicketRegistry;
  replacement?: ReturnType<typeof createReplacementController>;
  reset?: ReturnType<typeof createComputerResetController>;
}

export function cellRoutes(app: Hono, { cells, tickets, replacement, reset }: CellApiDeps): void {
  // A stream ticket lives only while its cell is ready (P2-R2): stopping, failing or removing the
  // cell revokes it, so no stream path stays open for a computer that is off.
  cells.subscribe((cell) => {
    if (cell.state !== "ready" || cell.paused || cell.fenced || cell.replacementPending)
      tickets.revoke(cell.id);
  });

  app.get("/api/cells", (c) => c.json(cells.list()));
  app.get("/api/cells/:id/reset/:request", (c) =>
    withCell(c, (id) => {
      const request = c.req.param("request") ?? "";
      if (request.length !== 26 || !ULID_PATTERN.test(request))
        return c.text("invalid reset request id", 400);
      if (!reset) return c.text("reset unavailable", 503);
      try {
        const record = reset.status(id, request);
        return record ? c.json(record) : c.text("unknown reset request", 404);
      } catch {
        return c.text("reset status unavailable", 409);
      }
    }),
  );
  app.post("/api/cells/:id/reset", bodyLimit({ maxSize: 1024 }), (c) =>
    withCell(c, async (id) => {
      if (!reset) return c.text("reset unavailable", 503);
      const request = ComputerResetRequest.safeParse(await c.req.json().catch(() => null));
      if (!request.success) return c.text("invalid confirmed reset request", 400);
      try {
        return c.json(await reset.reset(id, request.data));
      } catch {
        return c.text("reset completion unconfirmed; retry the same request explicitly", 409);
      }
    }),
  );
  app.get("/api/cells/:id/fence", (c) =>
    withCell(c, (id) =>
      replacement?.fence(id) ? c.json(replacement.fence(id)) : c.text("no replaceable fence", 404),
    ),
  );
  app.get("/api/cells/:id/replacement/:request", (c) =>
    withCell(c, async (id) => {
      const request = c.req.param("request") ?? "";
      if (!ULID_PATTERN.test(request)) return c.text("invalid request id", 400);
      if (!replacement) return c.text("replacement unavailable", 503);
      try {
        const record = await replacement.owner.status(id, request);
        return record ? c.json(record) : c.text("unknown replacement request", 404);
      } catch {
        return c.text("replacement status unavailable", 409);
      }
    }),
  );
  app.post("/api/cells/:id/replacement", bodyLimit({ maxSize: 1024 }), (c) =>
    withCell(c, async (id) => {
      if (!replacement) return c.text("replacement unavailable", 503);
      const parsed = ReplacementRequest.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.text("invalid replacement request", 400);
      try {
        return c.json(await replacement.owner.replace(id, parsed.data));
      } catch (error) {
        return c.text(
          error instanceof ReplacementConflict
            ? error.message
            : "replacement completion could not be confirmed",
          409,
        );
      }
    }),
  );

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
      if (cell.fenced || cell.replacementPending)
        return c.text("the computer is fenced or awaiting replacement confirmation", 409);
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
