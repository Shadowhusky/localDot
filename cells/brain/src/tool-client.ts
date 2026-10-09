import {
  APPROVAL_TIMEOUT_MS,
  BootConfig,
  type BrainEvent,
  BrainEvents,
  ComputerAction,
  computerWorkMs,
  InboxReply,
  MODEL_SCREEN,
  PauseSnapshot,
  ShellInput,
  ToolCallRequest,
  ToolResult,
  TranscriptAppend,
  TranscriptMessage,
  ULID_PATTERN,
} from "@localdot/protocol";
import { Agent, fetch as undiciFetch } from "undici";
import { z } from "zod";

// Frames and tool results are bounded even if a broken peer streams forever. These are transport
// ceilings; the daemon applies the narrower per-operation limits before doing any work.
export const MAX_REPLY_BYTES = 16 * 1024 * 1024;
// TranscriptStore accepts a 128 MiB append-only journal. Removing journal envelopes/acks only
// shrinks it; reserve an additional 64 KiB for the HTTP JSON envelope without raising tool limits.
export const MAX_TRANSCRIPT_REPLY_BYTES = 128 * 1024 * 1024 + 64 * 1024;
const BASE_TIMEOUT_MS = 30_000;
const TOOL_WORK_MS = 120_000;
// An approval card or a hand-off can hold these calls; the daemon bounds their own work.
const WAITS_ON_USER = new Set([
  "computer",
  "shell",
  "files",
  "browser_read",
  "browser_navigate",
  "browser_upload",
  "browser_act",
  "web_search",
  "web_fetch",
  "remember",
  "done",
  "routine",
  "follow_up_at",
]);
const transcriptReply = z.object({ messages: z.array(TranscriptMessage) });
const regionSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
  })
  .refine((r) => r.x + r.w <= MODEL_SCREEN.width && r.y + r.h <= MODEL_SCREEN.height);

export class ToolApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`tool API ${status || "unreachable"}: ${message}`);
    this.name = "ToolApiError";
  }
}

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ToolApiError(0, "request cancelled");
}

// A dependency that ignores abort cannot publish a late response or keep the caller pending.
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new ToolApiError(0, "request cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

async function bytes(res: Response, signal: AbortSignal, limit: number): Promise<Uint8Array> {
  cancelled(signal);
  const declared = res.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    void res.body?.cancel().catch(() => {});
    throw new ToolApiError(res.status, "response exceeds size limit");
  }
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      const part = await untilAbort(reader.read(), signal);
      cancelled(signal);
      if (part.done) {
        complete = true;
        break;
      }
      size += part.value.byteLength;
      if (size > limit) throw new ToolApiError(res.status, "response exceeds size limit");
      chunks.push(part.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// One dispatcher per brain, only for its authenticated daemon gate. The LLM transport is separate.
export class ToolClient {
  readonly #dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  readonly #closed = new AbortController();
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  #closing?: Promise<void>;
  #runWindowMs = 0;

  constructor(
    baseUrl: string,
    private readonly token: string,
    fetchImpl?: typeof fetch,
  ) {
    const url = new URL(baseUrl);
    if (
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error("Invalid tool API base URL");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid tool API token");
    this.#baseUrl = url.origin;
    this.#fetch =
      fetchImpl ??
      ((input, init) =>
        undiciFetch(input as Parameters<typeof undiciFetch>[0], {
          ...(init as Parameters<typeof undiciFetch>[1]),
          dispatcher: this.#dispatcher,
        }) as unknown as Promise<Response>);
  }

  // Only boot may retry: the relay can still be binding immediately after container start.
  boot(signal?: AbortSignal): Promise<BootConfig> {
    return this.#request(
      "GET",
      "/v1/boot",
      undefined,
      (b) => {
        const boot = BootConfig.parse(JSON.parse(b));
        this.#runWindowMs = boot.run ? boot.run.approvalWindowMinutes * 60_000 : 0;
        return boot;
      },
      BASE_TIMEOUT_MS,
      signal,
      [],
      true,
    );
  }

  transcript(signal?: AbortSignal): Promise<TranscriptMessage[]> {
    return this.#json(
      "GET",
      "/v1/transcript",
      undefined,
      (v) => transcriptReply.parse(v).messages,
      BASE_TIMEOUT_MS,
      signal,
      [],
      MAX_TRANSCRIPT_REPLY_BYTES,
    );
  }

  async appendTranscript(
    messages: TranscriptMessage[],
    inboxAfter?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = TranscriptAppend.parse({
      messages,
      ...(inboxAfter === undefined ? {} : { inboxAfter }),
    });
    await this.#request("POST", "/v1/transcript", body, () => undefined, BASE_TIMEOUT_MS, signal);
  }

  control(
    after: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<{ revision: number; pause?: import("@localdot/protocol").PauseSnapshot }> {
    z.number().int().nonnegative().safe().parse(after);
    z.number().int().min(0).max(25000).parse(waitMs);
    return this.#json(
      "GET",
      `/v1/control?after=${after}&waitMs=${waitMs}`,
      undefined,
      (value) =>
        z
          .object({
            revision: z.number().int().nonnegative().safe(),
            pause: PauseSnapshot.optional(),
          })
          .strict()
          .parse(value),
      waitMs + 10000,
      signal,
    );
  }
  inbox(after: number, waitMs: number, signal?: AbortSignal): Promise<InboxReply> {
    z.number().int().nonnegative().parse(after);
    z.number().int().min(0).max(30_000).parse(waitMs);
    return this.#json(
      "GET",
      `/v1/inbox?after=${after}&waitMs=${waitMs}`,
      undefined,
      (v) => InboxReply.parse(v),
      waitMs + 10_000,
      signal,
    );
  }

  async events(events: BrainEvent[], signal?: AbortSignal): Promise<void> {
    if (!events.length) return;
    await this.#request(
      "POST",
      "/v1/events",
      BrainEvents.parse({ events }),
      () => undefined,
      BASE_TIMEOUT_MS,
      signal,
    );
  }

  tool(name: string, callId: string, input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    let timeoutMs: number | undefined = TOOL_WORK_MS;
    if (name === "shell") timeoutMs = ((ShellInput.parse(input).timeout_sec ?? 120) + 10) * 1000;
    else if (name === "computer") {
      const action = ComputerAction.safeParse(input);
      if (action.success) timeoutMs = computerWorkMs(action.data);
    }
    // The user has thirty minutes, or a routine's own window; a secret answer is then typed into
    // its field.
    else if (name === "ask_user") timeoutMs = Math.max(30 * 60_000, this.#runWindowMs) + 60_000;
    else if (name === "request_takeover") timeoutMs = undefined;
    if (timeoutMs !== undefined && WAITS_ON_USER.has(name))
      timeoutMs += Math.max(APPROVAL_TIMEOUT_MS, this.#runWindowMs);
    return this.#json(
      "POST",
      `/v1/tools/${encodeURIComponent(name)}`,
      ToolCallRequest.parse({ callId, input }),
      (v) => ToolResult.parse(v),
      timeoutMs,
      signal,
      [400, 404],
    );
  }

  frame(
    frameId: string,
    region?: { x: number; y: number; w: number; h: number },
    signal?: AbortSignal,
  ): Promise<string> {
    z.string().regex(ULID_PATTERN).parse(frameId);
    if (region) regionSchema.parse(region);
    const query = region ? `?region=${region.x},${region.y},${region.w},${region.h}` : "";
    return this.#request(
      "GET",
      `/v1/frames/${frameId}${query}`,
      undefined,
      (_, data) => Buffer.from(data).toString("base64"),
      BASE_TIMEOUT_MS,
      signal,
    );
  }

  close(): Promise<void> {
    this.#closed.abort();
    this.#closing ??= this.#dispatcher.destroy();
    return this.#closing;
  }

  #json<T>(
    method: string,
    path: string,
    body: unknown,
    parse: (value: unknown) => T,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
    accept: number[] = [],
    maxReplyBytes = MAX_REPLY_BYTES,
  ): Promise<T> {
    return this.#request(
      method,
      path,
      body,
      (text) => parse(JSON.parse(text)),
      timeoutMs,
      signal,
      accept,
      false,
      maxReplyBytes,
    );
  }

  async #request<T>(
    method: string,
    path: string,
    body: unknown,
    parse: (text: string, data: Uint8Array) => T,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
    accept: number[] = [],
    retryBoot = false,
    maxReplyBytes = MAX_REPLY_BYTES,
  ): Promise<T> {
    const deadline = new AbortController();
    const active = AbortSignal.any([
      deadline.signal,
      this.#closed.signal,
      ...(signal ? [signal] : []),
    ]);
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const timer =
      timeoutMs === undefined ? undefined : setTimeout(() => deadline.abort(), timeoutMs);
    try {
      cancelled(active);
      let res: Response;
      for (;;) {
        try {
          const pending = this.#fetch(`${this.#baseUrl}${path}`, {
            method,
            redirect: "error",
            headers: {
              authorization: `Bearer ${this.token}`,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: serialized,
            signal: active,
          });
          // A custom transport may return after cancellation; never leak that late response body.
          void pending.then(
            (late) => {
              if (active.aborted) void late.body?.cancel().catch(() => {});
            },
            () => {},
          );
          res = await untilAbort(pending, active);
          cancelled(active);
          break;
        } catch (error) {
          cancelled(active);
          const code =
            error instanceof Error &&
            error.cause &&
            typeof error.cause === "object" &&
            "code" in error.cause
              ? error.cause.code
              : undefined;
          if (!retryBoot || code !== "ECONNREFUSED") throw new ToolApiError(0, "connection failed");
          // Cancel the delay as well as the fetch; the whole retry window shares one deadline.
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearTimeout(delay);
              reject(new ToolApiError(0, "request cancelled"));
            };
            const delay = setTimeout(() => {
              active.removeEventListener("abort", abort);
              resolve();
            }, 100);
            active.addEventListener("abort", abort, { once: true });
          });
        }
      }
      if (!res.ok && !accept.includes(res.status)) {
        // Never reflect peer error text: it may contain a token or a provider credential.
        void res.body?.cancel().catch(() => {});
        throw new ToolApiError(res.status, "request refused");
      }
      const data = await bytes(res, active, maxReplyBytes);
      cancelled(active);
      try {
        return parse(Buffer.from(data).toString("utf8"), data);
      } catch {
        throw new ToolApiError(res.status, "invalid response");
      }
    } catch (error) {
      if (error instanceof ToolApiError) throw error;
      throw new ToolApiError(0, active.aborted ? "request cancelled" : "request failed");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
