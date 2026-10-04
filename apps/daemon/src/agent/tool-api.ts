import { createHash, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import {
  BrainEvents,
  TOOL_API_PORT,
  ToolCallRequest,
  TranscriptAppend,
  ULID_PATTERN,
} from "@localdot/protocol";
import { Hono } from "hono";
import type { FramePng, Region } from "./frame-png.ts";
import type { Redactor } from "./redact.ts";
import { type AgentSession, abortable, type BrainGeneration } from "./session.ts";
import { type DispatchDeps, dispatchTool } from "./tools/index.ts";
import { MAX_TRANSCRIPT_MESSAGE, type TranscriptStore } from "./transcript.ts";

export interface ToolApiDeps extends DispatchDeps {
  sessions(): Iterable<AgentSession>;
  transcripts: TranscriptStore;
  png: Pick<FramePng, "png">;
  redactorFor(session: AgentSession): Redactor;
}
type Variables = { session: AgentSession; generation: BrainGeneration };
const MAX_BODY = 2 * 1024 * 1024;
const digest = (s: string) => createHash("sha256").update(s).digest();
class BodyError extends Error {
  constructor(
    readonly status: 400 | 413,
    message: string,
  ) {
    super(message);
  }
}
async function jsonBody(request: Request, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  if (!request.body) throw new BodyError(400, "JSON body required");
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY) throw new BodyError(413, "body too large");
      parts.push(chunk.value);
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, bytes)),
      );
    } catch {
      throw new BodyError(400, "invalid JSON body");
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function redactValue(value: unknown, redact: Redactor, depth = 0): unknown {
  if (depth > 64) throw new BodyError(400, "content is too deeply nested");
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, redact, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(value))
      out[redact(key)] = redactValue(child, redact, depth + 1);
    return out;
  }
  return value;
}
function integerQuery(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new BodyError(400, "invalid query value");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > maximum) throw new BodyError(400, "invalid query value");
  return n;
}
function parseRegion(value: string | undefined): Region | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(",").map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite))
    throw new BodyError(400, "invalid frame region");
  const [x, y, w, h] = parts as [number, number, number, number];
  if (x < 0 || y < 0 || w < 8 || h < 8 || x + w > 1280 || y + h > 800)
    throw new BodyError(400, "invalid frame region");
  return { x, y, w, h };
}

// Authentication captures generation identity before body reads. Every handler checks again
// after awaits; a replacement token cannot revive an already-authenticated old request.
export function createToolApi(deps: ToolApiDeps): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();
  app.onError((error, c) => {
    if (error instanceof BodyError) return c.text(error.message, error.status);
    const session = c.get("session");
    if (
      session &&
      (!session.isCurrent(c.get("generation")) || c.req.raw.signal.aborted || session.controlHeld)
    )
      return c.text("agent access unavailable", 409);
    return c.text("tool API request failed", 500); // Never print raw dependency errors or tokens.
  });
  app.use("*", async (c, next) => {
    if (c.req.header("origin") !== undefined) return c.text("forbidden", 403);
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!token) return c.text("unauthorized", 401);
    const given = digest(token);
    let match: { session: AgentSession; generation: BrainGeneration } | undefined;
    for (const session of deps.sessions()) {
      const generation = session.generation;
      const equal = session.toolToken ? timingSafeEqual(digest(session.toolToken), given) : false;
      if (equal && generation && session.isCurrent(generation)) match = { session, generation };
    }
    if (!match) return c.text("unauthorized", 401);
    c.set("session", match.session);
    c.set("generation", match.generation);
    await next();
  });
  app.get("/v1/control", async (c) => {
    const { session, generation } = c.var;
    const after = Number(c.req.query("after") ?? "0"),
      waitMs = Number(c.req.query("waitMs") ?? "0");
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(waitMs) ||
      waitMs < 0 ||
      waitMs > 25000
    )
      return c.text("invalid control cursor", 400);
    session.check(generation, c.req.raw.signal, true);
    await session.waitSafetyControl(
      after,
      waitMs,
      AbortSignal.any([generation.signal, c.req.raw.signal]),
    );
    session.check(generation, c.req.raw.signal, true);
    return c.json({
      revision: session.safetyControlRevision,
      ...(session.safetyPause ? { pause: session.safetyPause } : {}),
    });
  });
  app.get("/v1/boot", (c) => {
    c.var.session.check(c.var.generation, c.req.raw.signal);
    return c.var.session.boot ? c.json(c.var.session.boot) : c.text("no boot config", 404);
  });
  app.get("/v1/transcript", (c) => {
    c.var.session.check(c.var.generation, c.req.raw.signal, true);
    return c.json({ messages: deps.transcripts.read(c.var.session.id) });
  });
  app.post("/v1/transcript", async (c) => {
    const { session, generation } = c.var;
    const signal = AbortSignal.any([session.abort.signal, generation.signal, c.req.raw.signal]);
    const parsed = TranscriptAppend.safeParse(await jsonBody(c.req.raw, signal));
    session.check(generation, signal, true);
    if (!parsed.success) return c.text("invalid transcript append", 400);
    const redact = deps.redactorFor(session);
    // Canonical inbox text must match exactly; it is already accepted/redacted by the user path.
    // A client cannot smuggle known credentials by pretending they came from the user.
    if (
      parsed.data.messages.some(
        (m) => m.sourceInbox && typeof m.content === "string" && redact(m.content) !== m.content,
      )
    )
      return c.text("invalid inbox text", 400);
    const request = TranscriptAppend.parse(redactValue(parsed.data, redact));
    if (
      request.messages.some(
        (message) => Buffer.byteLength(JSON.stringify(message)) > MAX_TRANSCRIPT_MESSAGE,
      )
    )
      return c.text("transcript message too large", 400);
    try {
      session.appendTranscript(deps.transcripts, generation, request, signal);
    } catch {
      return c.text("transcript append refused", 409);
    }
    return c.body(null, 204);
  });
  app.get("/v1/inbox", async (c) => {
    const after = integerQuery(c.req.query("after"), 0, Number.MAX_SAFE_INTEGER);
    const waitMs = integerQuery(c.req.query("waitMs"), 0, 25_000);
    const reply = await c.var.session.inbox(after, waitMs, c.req.raw.signal, c.var.generation);
    c.var.session.check(c.var.generation, c.req.raw.signal, true);
    return c.json(reply);
  });
  app.post("/v1/events", async (c) => {
    const { session, generation } = c.var;
    const signal = AbortSignal.any([session.abort.signal, generation.signal, c.req.raw.signal]);
    const raw = await jsonBody(c.req.raw, signal);
    session.check(generation, signal);
    const parsed = BrainEvents.safeParse(redactValue(raw, deps.redactorFor(session)));
    if (!parsed.success) return c.text("invalid brain events", 400);
    for (const event of parsed.data.events) {
      session.check(generation, signal);
      session.append(event.type, event.data as Record<string, unknown>);
      if (event.type === "agent.state") {
        if (event.data.state === "paused") session.setStatus("paused");
        else if (["thinking", "acting", "observing"].includes(event.data.state))
          session.setStatus("running");
      }
    }
    return c.body(null, 204);
  });
  app.post("/v1/tools/:name", async (c) => {
    const { session, generation } = c.var;
    const signal = AbortSignal.any([session.abort.signal, generation.signal, c.req.raw.signal]);
    session.check(generation, signal);
    const parsed = ToolCallRequest.safeParse(await jsonBody(c.req.raw, signal));
    session.check(generation, signal);
    if (!parsed.success) return c.text("invalid tool call", 400);
    try {
      const out = await dispatchTool(
        deps,
        session,
        c.req.param("name"),
        parsed.data.callId,
        parsed.data.input,
        deps.redactorFor(session),
        generation,
        signal,
      );
      // The dispatch promise creates one last continuation boundary before publication.
      if (session.stopped)
        return c.json({
          ok: false,
          final: true,
          content: [{ type: "text", text: "The task has stopped. Do not retry the operation." }],
        });
      session.check(generation, signal);
      return c.json(out.result, out.status);
    } catch {
      return c.json({
        ok: false,
        content: [{ type: "text", text: "The tool was cancelled or could not complete." }],
      });
    }
  });
  app.get("/v1/frames/:frameId", async (c) => {
    const { session, generation } = c.var;
    const lease = session.admit(generation, c.req.raw.signal);
    try {
      const frameId = c.req.param("frameId");
      if (!ULID_PATTERN.test(frameId)) return c.text("invalid frame id", 400);
      const region = parseRegion(c.req.query("region"));
      lease.check();
      let png: Buffer;
      try {
        png = await deps.png.png(session.id, frameId, region, lease.signal);
      } catch {
        lease.check();
        return c.text("no such frame", 404);
      }
      lease.check();
      session.tainted = true;
      if (!region) session.lastFrameId = frameId;
      return c.body(new Uint8Array(png), 200, {
        "content-type": "image/png",
        "cache-control": "no-store",
      });
    } finally {
      lease.finish();
    }
  });
  return app;
}
export function serveToolApi(
  app: ReturnType<typeof createToolApi>,
  port = TOOL_API_PORT,
): { close(): void } {
  return serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
}
