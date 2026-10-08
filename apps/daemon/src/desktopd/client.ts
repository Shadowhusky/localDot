import {
  ClockResult,
  type FindRequest,
  HitTestResult,
  type InputRequest,
  InputResult,
  KeyProgress,
  type LaunchRequest,
  LaunchResult,
  ObserveResult,
  type Point,
  ReleaseResult,
  type SettleRequest,
  SettleResult,
  TypeProgress,
  type TypeRequest,
  TypeResult,
  type ZoomRequest,
} from "@localdot/protocol";
import type { DesktopdEndpoint } from "../cells/types.ts";

export class DesktopdError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly path: string,
  ) {
    super(`desktopd ${status || "unreachable"} on ${path}: ${message}`);
    this.name = "DesktopdError";
  }
}

const TIMEOUT_MS = {
  clock: 2000,
  input: 5000,
  settle: 35_000,
  launch: 5000,
  observe: 10_000,
  hitTest: 5000,
  zoom: 5000,
} as const;
// A press of a repeated key takes about 25 ms on an idle desktop; this leaves room under load.
const REPEAT_PRESS_MS = 50;
const LINE_MAX = 64 * 1024;

export class DesktopdClient {
  constructor(
    readonly endpoint: DesktopdEndpoint,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  clock(): Promise<ClockResult> {
    return this.#json("GET", "/clock", undefined, TIMEOUT_MS.clock, ClockResult.parse);
  }

  // A repeated or held key answers as NDJSON: `onPress` hears each press of a repeat, and a hold
  // once its keys are down. Aborting `signal` (a Stop) ends a repeat after the press in progress.
  async input(
    req: InputRequest,
    signal?: AbortSignal,
    onPress?: (p: KeyProgress) => void | Promise<void>,
  ): Promise<InputResult> {
    const key = req.input.kind === "key" ? req.input : undefined;
    const timeoutMs = TIMEOUT_MS.input + (key?.holdMs ?? 0) + (key?.repeat ?? 0) * REPEAT_PRESS_MS;
    signal?.throwIfAborted();
    const res = await this.#send("POST", "/input", req, timeoutMs, signal);
    const streamed = res.headers.get("content-type")?.includes("application/x-ndjson");
    if (!res.ok || !res.body || !streamed) {
      const text = await res.text();
      if (!res.ok) throw new DesktopdError(res.status, text || res.statusText, "/input");
      return InputResult.parse(JSON.parse(text));
    }
    return InputResult.parse(
      await this.#lines(res.body, "/input", signal, async (line) => {
        await onPress?.(KeyProgress.parse(line));
      }),
    );
  }

  // Releases every key and button that is down on the desktop.
  release(): Promise<ReleaseResult> {
    return this.#json("POST", "/release", {}, TIMEOUT_MS.input, ReleaseResult.parse);
  }

  settle(req: Partial<SettleRequest> = {}): Promise<SettleResult> {
    return this.#json("POST", "/settle", req, TIMEOUT_MS.settle, SettleResult.parse);
  }

  arm(): Promise<{ mono: number }> {
    return this.#json("POST", "/arm", {}, TIMEOUT_MS.clock, ClockResult.parse);
  }

  launch(req: LaunchRequest, signal?: AbortSignal): Promise<LaunchResult> {
    return this.#json("POST", "/launch", req, TIMEOUT_MS.launch, LaunchResult.parse, signal);
  }

  observe(signal?: AbortSignal): Promise<ObserveResult> {
    return this.#json("POST", "/observe", {}, TIMEOUT_MS.observe, ObserveResult.parse, signal);
  }

  // A region of the frame desktopd observed last, as PNG at the screen's device resolution;
  // undefined once a newer observe replaced that frame.
  async zoom(req: ZoomRequest, signal?: AbortSignal): Promise<Buffer | undefined> {
    signal?.throwIfAborted();
    const res = await this.#send("POST", "/zoom", req, TIMEOUT_MS.zoom, signal);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new DesktopdError(res.status, (await res.text()) || res.statusText, "/zoom");
    return Buffer.from(await res.arrayBuffer());
  }

  focused(): Promise<HitTestResult> {
    return this.#json("POST", "/focused", {}, TIMEOUT_MS.hitTest, HitTestResult.parse);
  }

  hitTest(point: Point): Promise<HitTestResult> {
    return this.#json("POST", "/hitTest", { point }, TIMEOUT_MS.hitTest, HitTestResult.parse);
  }

  find(req: FindRequest): Promise<HitTestResult> {
    return this.#json("POST", "/find", req, TIMEOUT_MS.hitTest, HitTestResult.parse);
  }

  // NDJSON: one TypeProgress per line, then the TypeResult; an {error, status} line fails the call.
  // Aborting `signal` (a Stop) closes the request, and desktopd stops typing at the next key.
  async type(
    req: TypeRequest,
    onProgress: (p: TypeProgress) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<TypeResult> {
    const res = await this.#send("POST", "/type", req, 60_000 + req.text.length * 50, signal);
    if (!res.ok || !res.body) throw new DesktopdError(res.status, await res.text(), "/type");
    return TypeResult.parse(
      await this.#lines(res.body, "/type", signal, async (line) => {
        await onProgress(TypeProgress.parse(line));
      }),
    );
  }

  // Progress lines until the one with `done: true`, which it returns.
  async #lines(
    body: ReadableStream<Uint8Array>,
    path: string,
    signal: AbortSignal | undefined,
    onLine: (line: Record<string, unknown>) => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const abort = () => {
      void reader.cancel(signal?.reason).catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      for (;;) {
        const { value, done } = await reader.read();
        buffered += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        let nl = buffered.indexOf("\n");
        while (nl >= 0) {
          const line = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          nl = buffered.indexOf("\n");
          if (!line) continue;
          if (line.length > LINE_MAX)
            throw new DesktopdError(502, "a progress line exceeds its limit", path);
          const msg = JSON.parse(line) as Record<string, unknown>;
          if ("error" in msg)
            throw new DesktopdError(Number(msg.status) || 500, String(msg.error), path);
          if (msg.done === true) return msg;
          await onLine(msg);
        }
        if (buffered.length > LINE_MAX)
          throw new DesktopdError(502, "a progress line exceeds its limit", path);
        if (done) break;
      }
      throw new DesktopdError(502, "the reply ended without a result line", path);
    } finally {
      signal?.removeEventListener("abort", abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async #send(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await this.fetchImpl(`${this.endpoint.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.endpoint.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch (err) {
      throw new DesktopdError(0, err instanceof Error ? err.message : String(err), path);
    }
  }

  async #json<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    timeoutMs: number,
    parse: (v: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const res = await this.#send(method, path, body, timeoutMs, signal);
    const text = await res.text();
    if (!res.ok) throw new DesktopdError(res.status, text || res.statusText, path);
    return parse(JSON.parse(text));
  }
}
