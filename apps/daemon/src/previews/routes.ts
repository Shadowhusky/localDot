import { PreviewRequest, ULID_PATTERN } from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { PreviewError, type Previews } from "./previews.ts";

// The owner's previews of the servers in a task's computer. Shared links never reach these: they
// are not on a link's list of routes, and a link's grant is refused here as well.
export function previewRoutes(app: Hono, previews: Pick<Previews, "status" | "open" | "stop">) {
  app.get("/api/sessions/:id/previews", (c) =>
    owned(c, async (id) => {
      c.header("cache-control", "no-store");
      return c.json(await previews.status(id, c.req.header("host")));
    }),
  );
  app.post("/api/sessions/:id/previews", bodyLimit({ maxSize: 4096 }), (c) =>
    owned(c, async (id) => {
      const request = PreviewRequest.safeParse(await c.req.json().catch(() => null));
      if (!request.success) return c.json({ message: "That isn't a preview request." }, 400);
      c.header("cache-control", "no-store");
      return c.json(await previews.open(id, request.data, c.req.header("host")));
    }),
  );
  app.delete("/api/sessions/:id/previews/:preview", (c) =>
    owned(c, async (id) =>
      previews.stop(id, c.req.param("preview") ?? "")
        ? c.body(null, 204)
        : c.json({ message: "That preview has already ended." }, 404),
    ),
  );
}

async function owned(c: Context, run: (sessionId: string) => Promise<Response>) {
  if (c.get("remoteGrant")) return c.json({ message: "Previews open only for the owner." }, 403);
  const id = c.req.param("id") ?? "";
  if (!ULID_PATTERN.test(id)) return c.json({ message: "invalid task id" }, 400);
  try {
    return await run(id);
  } catch (error) {
    if (error instanceof PreviewError) return c.json(error.refusal, error.status);
    throw error;
  }
}
