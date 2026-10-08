import {
  ClockResult,
  type FindRequest,
  HitTestResult,
  type InputRequest,
  InputResult,
  type LaunchRequest,
  LaunchResult,
  ObserveResult,
  type Point,
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

export class DesktopdClient {
  constructor(
    readonly endpoint: DesktopdEndpoint,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  clock(): Promise<ClockResult> {
    return this.#json("GET", "/clock", undefined, TIMEOUT_MS.clock, ClockResult.parse);
  }

  input(req: InputRequest, signal?: AbortSignal): Promise<InputResult> {
    return this.#json("POST", "/input", req, TIMEOUT_MS.input, InputResult.parse, signal);
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
    const reader = res.body.getReader();
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
          if (line.length > 64 * 1024)
            throw new DesktopdError(502, "typing line exceeds its limit", "/type");
          const msg = JSON.parse(line) as Record<string, unknown>;
          if ("error" in msg)
            throw new DesktopdError(Number(msg.status) || 500, String(msg.error), "/type");
          if (msg.done === true) return TypeResult.parse(msg);
          else await onProgress(TypeProgress.parse(msg));
        }
        if (buffered.length > 64 * 1024)
          throw new DesktopdError(502, "typing line exceeds its limit", "/type");
        if (done) break;
      }
      throw new DesktopdError(502, "typing ended without a result line", "/type");
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
