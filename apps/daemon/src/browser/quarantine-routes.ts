import { createHash } from "node:crypto";
import { ULID_PATTERN } from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { QuarantineItem, QuarantineRelease } from "../../../../packages/protocol/src/quarantine.ts";
import { OncePermit } from "../agent/safety/approvals.ts";
import type { BrowserScope } from "./client.ts";
import { type PlaceDownload, QuarantineError, type QuarantineStore } from "./quarantine.ts";

export interface QuarantineAccess extends BrowserScope {
  release(): void;
}
export interface QuarantineRoutesDeps {
  store: Pick<QuarantineStore, "list" | "get" | "release" | "discard" | "expire">;
  exists(parent: string): boolean;
  access(parent: string, signal: AbortSignal): QuarantineAccess | undefined;
  place: PlaceDownload;
}
class Refusal extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 415 | 503,
    message: string,
  ) {
    super(message);
  }
}
const discard = z.strictObject({
  revision: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER - 2),
});

async function json<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  )
    throw new Refusal(415, "JSON is required.");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > 4096))
    throw new Refusal(413, "Download request is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new Refusal(400, "Download request is missing.");
  const cancelled = () => {
    void reader.cancel().catch(() => {});
  };
  request.signal.addEventListener("abort", cancelled, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    request.signal.throwIfAborted();
    for (;;) {
      const next = await reader.read();
      request.signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 4096) throw new Refusal(413, "Download request is too large.");
      chunks.push(next.value);
    }
    if (declared !== null && Number(declared) !== bytes)
      throw new Refusal(400, "Download request length changed.");
    try {
      return schema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))),
      );
    } catch {
      throw new Refusal(400, "Download request could not be verified.");
    }
  } finally {
    request.signal.removeEventListener("abort", cancelled);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Mount only behind createApp's host/origin/install-token guard. These routes are
// not installed on the model's tool API. The explicit release POST is the user's
// approval of one exact tuple; its permit is never cached or exposed to a model.
// Full access is the user's standing approval for the running task's own downloads.
export function quarantineRoutes(app: Hono, deps: QuarantineRoutesDeps): void {
  const route = (work: (c: Context, parent: string) => Promise<Response>) => async (c: Context) => {
    c.header("cache-control", "no-store");
    try {
      c.req.raw.signal.throwIfAborted();
      const parent = c.req.param("cellId");
      if (!parent || !ULID_PATTERN.test(parent)) throw new Refusal(400, "Invalid computer.");
      if (!deps.exists(parent)) throw new Refusal(404, "Computer is unavailable.");
      return await work(c, parent);
    } catch (error) {
      if (c.req.raw.signal.aborted)
        return new Response("Download request cancelled.", {
          status: 499,
          headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
        });
      if (error instanceof Refusal) return c.text(error.message, error.status);
      if (error instanceof QuarantineError)
        return c.text(
          `Download operation refused (${error.code}).`,
          error.code === "missing" ? 404 : 409,
        );
      return c.text(
        "Download operation could not be confirmed. Refresh its status before retrying.",
        503,
      );
    }
  };
  const itemId = (c: Context) => {
    const id = c.req.param("itemId");
    if (!id || !ULID_PATTERN.test(id)) throw new Refusal(400, "Invalid download.");
    return id;
  };
  app.get(
    "/api/cells/:cellId/quarantine",
    route(async (c, parent) => {
      await deps.store.expire({
        signal: c.req.raw.signal,
        check: () => c.req.raw.signal.throwIfAborted(),
      });
      const items = QuarantineItem.array().max(4096).parse(deps.store.list(parent));
      return c.json({ items });
    }),
  );
  app.post(
    "/api/cells/:cellId/quarantine/:itemId/discard",
    route(async (c, parent) => {
      const id = itemId(c),
        request = await json(c.req.raw, discard);
      const item = await deps.store.discard(parent, id, request.revision, {
        signal: c.req.raw.signal,
        check: () => c.req.raw.signal.throwIfAborted(),
      });
      return c.json(QuarantineItem.parse(item));
    }),
  );
  app.post(
    "/api/cells/:cellId/quarantine/:itemId/release",
    route(async (c, parent) => {
      const id = itemId(c),
        request = Object.freeze(await json(c.req.raw, QuarantineRelease));
      return c.json(await releaseDownload(deps, parent, id, request, c.req.raw.signal));
    }),
  );
}

// The user's Review and Full access's automatic release go through the same checks.
export async function releaseDownload(
  deps: QuarantineRoutesDeps,
  parent: string,
  id: string,
  request: QuarantineRelease,
  signal: AbortSignal,
): Promise<QuarantineItem> {
  if (!deps.store.get(parent, id)) throw new Refusal(404, "Download is unavailable.");
  let access: QuarantineAccess | undefined;
  try {
    access = deps.access(parent, signal);
  } catch {
    throw new Refusal(409, "The computer or task is changing control. Refresh and try again.");
  }
  if (!access) throw new Refusal(409, "The computer is not ready for a file release.");
  const digest = createHash("sha256")
    .update(JSON.stringify([parent, id, request]))
    .digest("hex");
  const approval = new OncePermit(digest);
  try {
    access.check();
    const item = await deps.store.release(
      parent,
      id,
      request,
      access,
      (placement, chunks, scope, options) => {
        scope.check();
        if (
          placement.parentCellId !== parent ||
          placement.bytes !== request.bytes ||
          placement.sha256 !== request.sha256 ||
          placement.name !== request.name ||
          !approval.consume(digest)
        )
          throw new Refusal(409, "The approved file changed.");
        // The store persists approvedRevision/transferId before this single effect.
        return deps.place(placement, chunks, scope, options);
      },
    );
    return QuarantineItem.parse(item);
  } finally {
    access.release();
  }
}
