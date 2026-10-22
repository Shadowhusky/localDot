import type { Hono } from "hono";
import { type AccessLinks, accessAddresses } from "./access-links.ts";
import { isPublicOrigin } from "./guard.ts";
import { InstallCodeCapacityError, type InstallCodes } from "./install-codes.ts";

const MAX_BODY_BYTES = 128;
const BODY_TIMEOUT_MS = 5_000;
const BODY_PATTERN =
  /^[\t\n\r ]*\{[\t\n\r ]*"code"[\t\n\r ]*:[\t\n\r ]*"([A-Za-z0-9_-]{43})"[\t\n\r ]*\}[\t\n\r ]*$/;

/** Register after the existing /api bearer guard; exchange still uses the global Host guard. */
export function installCodeRoutes(
  app: Hono,
  codes: InstallCodes,
  port: number,
  access?: AccessLinks,
  exchangeGuest?: (code: string) => string | undefined,
): void {
  app.get("/api/access-links", async (c) => {
    c.header("cache-control", "no-store");
    if (access) return c.json(await access.read(c.req.query("fresh") === "1"));
    return c.json({
      links: accessAddresses(port),
      tailscale: {
        state: "unavailable",
        reason: "failed",
        message: "This localDot doesn't check Tailscale.",
      },
    });
  });
  app.post("/api/access-links/tailscale", async (c) => {
    if (!access) return c.text("Tailscale setup is unavailable", 503);
    try {
      return c.json(await access.enableTailscale());
    } catch {
      return c.text("Tailscale couldn't be turned on. Check Tailscale, then try again.", 503);
    }
  });
  app.post("/api/install-code", (c) => {
    if (new URL(c.req.url).search) return c.text("invalid request", 400);
    try {
      return c.json(codes.issue());
    } catch (error) {
      if (error instanceof InstallCodeCapacityError) {
        c.header("retry-after", "60");
        return c.text("try a new link shortly", 429);
      }
      throw error;
    }
  });

  app.post("/auth/exchange-code", async (c) => {
    const url = new URL(c.req.url);
    // The page must be this origin. Behind an HTTPS front the page is the configured public
    // origin while the daemon itself sees plain http, so that one name also matches.
    const origin = c.req.header("origin");
    if (origin !== url.origin && !isPublicOrigin(origin)) return c.text("forbidden origin", 403);
    if (url.search) return c.text("invalid request", 400);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(c.req.header("content-type") ?? "")) {
      return c.text("JSON required", 415);
    }
    if (c.req.header("content-encoding") && c.req.header("content-encoding") !== "identity") {
      return c.text("unsupported encoding", 415);
    }
    const length = c.req.header("content-length");
    if (length !== undefined && !/^\d+$/.test(length)) return c.text("invalid request", 400);
    if (length !== undefined && Number(length) > MAX_BODY_BYTES)
      return c.text("body too large", 413);
    const body = await readBody(c.req.raw);
    if (typeof body !== "string") return c.text("invalid request", body);
    const match = BODY_PATTERN.exec(body);
    if (!match?.[1]) return c.text("invalid request", 400);
    const token = exchangeGuest?.(match[1]) ?? codes.consume(match[1]);
    return token === undefined ? c.text("invalid or expired link", 401) : c.json({ token });
  });
}

async function readBody(request: Request): Promise<string | 400 | 408 | 413> {
  if (request.signal.aborted) return 408;
  const reader = request.body?.getReader();
  if (!reader) return 400;
  let expired = false;
  let cancel!: () => void;
  const cancelled = new Promise<undefined>((resolve) => {
    cancel = () => {
      expired = true;
      resolve(undefined);
    };
  });
  const timer = setTimeout(cancel, BODY_TIMEOUT_MS);
  timer.unref();
  request.signal.addEventListener("abort", cancel, { once: true });
  const bytes = new Uint8Array(MAX_BODY_BYTES);
  let offset = 0;
  let complete = false;
  try {
    while (true) {
      const part = await Promise.race([reader.read(), cancelled]);
      if (!part || expired) return 408;
      if (part.done) {
        complete = true;
        break;
      }
      if (offset + part.value.byteLength > MAX_BODY_BYTES) return 413;
      bytes.set(part.value, offset);
      offset += part.value.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } catch {
    return 400;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
    // A hostile stream's cancel promise must not keep the HTTP handler alive.
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
