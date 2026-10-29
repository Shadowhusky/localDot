import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DeleteSessionsRequest,
  type DeleteSessionsResult,
  emptyManifest,
  recordingDirectory,
  type ScreenName,
  ULID_PATTERN,
} from "@localdot/protocol";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Conversations } from "../agent/conversation.ts";
import { errorCode } from "../error-code.ts";
import { type EventLog, UnknownSessionError } from "../event-log.ts";
import type { LiveSessions } from "../gateway/live.ts";
import type { Recorder } from "../recorder/recorder.ts";
import { NoFragmentsError, openRecordingView, type RecordingView } from "../recorder/view.ts";
import type { SessionIndex } from "./index-store.ts";
import { NDJSON_TYPE, streamEventLines } from "./ndjson.ts";
import type { Thumbnails } from "./thumbs.ts";
export interface ReplayRoutesDeps {
  home: string;
  eventLog: EventLog;
  recorder: Pick<Recorder, "info" | "isLive"> & { browser?: Pick<Recorder, "info"> };
  index: SessionIndex;
  thumbs: Thumbnails;
  live?: Pick<LiveSessions, "cellOf">;
}
function requestedScreen(request: Request): ScreenName | null {
  const values = new URL(request.url).searchParams.getAll("screen");
  if (values.length === 0) return "desktop";
  return values.length === 1 && (values[0] === "desktop" || values[0] === "browser")
    ? values[0]
    : null;
}
export function eventStreamResponse(
  file: string,
  fromSeq: number,
  signal: AbortSignal,
  options?: { shown?: boolean },
): Response {
  const lines = streamEventLines(file, fromSeq, options);
  const encoder = new TextEncoder();
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  async function close() {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", abort);
    await lines.return(undefined);
  }
  function abort() {
    controller?.error(new Error("request aborted"));
    void close();
  }
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    },
    async pull(c) {
      if (closed) return;
      try {
        const next = await lines.next();
        if (closed) return;
        if (next.done) {
          await close();
          c.close();
        } else c.enqueue(encoder.encode(next.value));
      } catch (error) {
        await close();
        c.error(error);
      }
    },
    cancel() {
      return close();
    },
  });
  return new Response(body, {
    headers: { "content-type": NDJSON_TYPE, "cache-control": "no-store" },
  });
}
function rangeFor(raw: string, size: number): [number, number] | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!m || (!m[1] && !m[2])) return undefined;
  const a = m[1] ? Number(m[1]) : undefined,
    b = m[2] ? Number(m[2]) : undefined;
  if (
    (a !== undefined && !Number.isSafeInteger(a)) ||
    (b !== undefined && !Number.isSafeInteger(b))
  )
    return undefined;
  if (a === undefined) {
    if (b === undefined || b < 1) return undefined;
    return [Math.max(0, size - b), size];
  }
  if (a >= size || (b !== undefined && a > b)) return undefined;
  return [a, b === undefined ? size : Math.min(size, b + 1)];
}
function videoResponse(view: RecordingView, request: Request): Response {
  const headers = new Headers({
    "content-type": "video/mp4",
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  });
  let start = 0,
    end = view.size,
    status = 200;
  const raw = request.headers.get("range");
  if (raw !== null) {
    const range = rangeFor(raw, view.size);
    if (!range) {
      view.close();
      headers.set("content-range", `bytes */${view.size}`);
      return new Response(null, { status: 416, headers });
    }
    [start, end] = range;
    status = 206;
    headers.set("content-range", `bytes ${start}-${end - 1}/${view.size}`);
  }
  headers.set("content-length", String(end - start));
  if (request.method === "HEAD") {
    view.close();
    return new Response(null, { status, headers });
  }
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  function close() {
    if (closed) return;
    closed = true;
    request.signal.removeEventListener("abort", abort);
    view.close();
  }
  function abort() {
    controller?.error(new Error("request aborted"));
    close();
  }
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
    },
    pull(c) {
      if (closed) return;
      try {
        if (start === end) {
          close();
          c.close();
          return;
        }
        const next = Math.min(end, start + 256 * 1024);
        c.enqueue(view.read(start, next));
        start = next;
      } catch (error) {
        close();
        c.error(error);
      }
    },
    cancel() {
      close();
    },
  });
  return new Response(body, { status, headers });
}
export function replayRoutes(app: Hono, deps: ReplayRoutesDeps): void {
  const validate = async (
    c: Parameters<Parameters<Hono["use"]>[1]>[0],
    next: () => Promise<void>,
  ) => {
    const id = c.req.param("id");
    if (!id || !ULID_PATTERN.test(id)) return c.text("invalid session id", 400);
    if (
      !deps.eventLog.hasSession(id) &&
      !(c.req.raw.method === "DELETE" && deps.eventLog.hasPendingDeletion(id))
    )
      return c.text("unknown session", 404);
    await next();
  };
  app.use("/api/sessions/:id", validate);
  app.use("/api/sessions/:id/*", validate);
  app.get("/api/session-index", async (c) => {
    try {
      const raw = c.req.query("limit");
      return c.json(
        await deps.index.page({
          before: c.req.query("before"),
          ...(raw === undefined ? {} : { limit: Number(raw) }),
        }),
      );
    } catch (error) {
      if (error instanceof RangeError) return c.text("invalid paging parameters", 400);
      throw error;
    }
  });
  app.get("/api/sessions/:id/card", async (c) => {
    try {
      return c.json(await deps.index.card(c.req.param("id")));
    } catch (error) {
      if (error instanceof UnknownSessionError) return c.text("unknown session", 404);
      throw error;
    }
  });
  app.get("/api/sessions/:id/recording", (c) => {
    const screen = requestedScreen(c.req.raw);
    if (!screen) return c.text("invalid recording screen", 400);
    const id = c.req.param("id"),
      info = screen === "browser" ? deps.recorder.browser?.info(id) : deps.recorder.info(id);
    let servedBytes = 0;
    if (info && !["none", "expired", "failed"].includes(info.manifest.state))
      try {
        const view = openRecordingView(
          join(deps.home, "sessions", id, recordingDirectory(screen)),
          {
            complete: !info.live && info.manifest.finalized,
            entries: info.entries,
          },
        );
        try {
          servedBytes = view.size;
        } finally {
          view.close();
        }
      } catch (error) {
        if (!(error instanceof NoFragmentsError)) throw error;
      }
    return c.json({
      manifest: info?.manifest ?? emptyManifest("none"),
      live: info?.live ?? false,
      upto: info?.entries.length ?? 0,
      servedBytes,
    });
  });
  app.on(["GET", "HEAD"], "/api/sessions/:id/recording/video.mp4", (c) => {
    const screen = requestedScreen(c.req.raw);
    if (!screen) return c.text("invalid recording screen", 400);
    const id = c.req.param("id"),
      info = screen === "browser" ? deps.recorder.browser?.info(id) : deps.recorder.info(id);
    if (!info || ["none", "failed", "expired"].includes(info.manifest.state))
      return c.text("no video", 404);
    let upto: number | undefined;
    const raw = c.req.query("upto");
    if (raw !== undefined && (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))))
      return c.text("invalid snapshot", 400);
    if (info.live) {
      if (raw === undefined || !/^\d+$/.test(raw))
        return c.text("live snapshot requires upto", 400);
      upto = Number(raw);
      if (!Number.isSafeInteger(upto) || upto > info.entries.length)
        return c.text("invalid snapshot", 400);
    }
    try {
      return videoResponse(
        openRecordingView(join(deps.home, "sessions", id, recordingDirectory(screen)), {
          complete: !info.live && info.manifest.finalized,
          entries: info.entries,
          upto,
        }),
        c.req.raw,
      );
    } catch (error) {
      if (error instanceof NoFragmentsError) return c.text("no video", 404);
      throw error;
    }
  });
  app.get("/api/sessions/:id/thumbs/:frameId", async (c) => {
    const frameId = c.req.param("frameId");
    if (!ULID_PATTERN.test(frameId)) return c.text("invalid frame id", 400);
    const file = await deps.thumbs.path(c.req.param("id"), frameId);
    if (!file) return c.text("unknown frame", 404);
    return new Response(readFileSync(file), {
      headers: {
        "content-type": "image/webp",
        "cache-control": "no-store",
      },
    });
  });
  app.delete("/api/conversations/:id", (c) => {
    const id = c.req.param("id");
    const conversations = new Conversations(deps.home, deps.eventLog);
    if (!ULID_PATTERN.test(id) || !conversations.has(id))
      return c.text("conversation not found", 404);
    const { sessions } = conversations.chain(id, Number.MAX_SAFE_INTEGER);
    // Preflight the whole chain before deleting any part of it. No await separates
    // this check from deletion, so a live run cannot enter between them.
    if (sessions.some((task) => deps.recorder.isLive(task) || deps.live?.cellOf(task)))
      return c.text("conversation is live", 409);
    const current = conversations.current();
    for (const task of sessions) {
      deps.eventLog.forget(task);
      deps.index.invalidate(task);
    }
    if (current && sessions.includes(current)) conversations.begin();
    return c.body(null, 204);
  });
  // No await separates the live check from the deletion, so a run cannot start between them.
  const remove = (id: string): "deleted" | "live" => {
    if (deps.recorder.isLive(id) || deps.live?.cellOf(id)) return "live";
    if (deps.eventLog.hasSession(id) || deps.eventLog.hasPendingDeletion(id))
      deps.eventLog.forget(id);
    deps.index.invalidate(id);
    return "deleted";
  };
  app.delete("/api/sessions/:id", (c) =>
    remove(c.req.param("id")) === "live" ? c.text("session is live", 409) : c.body(null, 204),
  );
  app.post("/api/session-index/delete", bodyLimit({ maxSize: 8 * 1024 }), async (c) => {
    const parsed = DeleteSessionsRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text("invalid session ids", 400);
    const result: DeleteSessionsResult = { deleted: [], live: [], failed: [] };
    for (const id of new Set(parsed.data.ids)) {
      try {
        result[remove(id)].push(id);
      } catch (error) {
        console.error(`deleting a task failed (${errorCode(error)})`);
        result.failed.push(id);
      }
      // Each task's folder goes in a turn of its own, so streams and other requests keep moving.
      await new Promise((resolve) => setImmediate(resolve));
    }
    return c.json(result);
  });
}
