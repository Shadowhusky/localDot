import { randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";
import {
  BrowserNavigateResult,
  BrowserPageResult,
  BrowserReadResult,
  DesktopCapabilities,
  ElementsRequest,
  ElementsResult,
  FileChangeResult,
  FileListResult,
  FileReadResult,
  ShellChunk,
  ShellDone,
  ShellFailure,
  ShellRequest,
  UserUploadId,
  UserUploadName,
  UserUploadReceipt,
} from "@localdot/protocol";
import { Agent, fetch as transportFetch } from "undici";
import { z } from "zod";
import { browserFailureDetail } from "../../../../packages/protocol/src/browser-failure.ts";
import {
  DesktopBrowserReady,
  DesktopBrowserTask,
} from "../../../../packages/protocol/src/desktop-browser.ts";
import type { DesktopUploadFile } from "../../../../packages/protocol/src/desktop-uploads.ts";
import type { DesktopdEndpoint } from "../cells/types.ts";
import { DesktopdError } from "./client.ts";
import { inspectDesktopUpload, readDesktopUpload } from "./upload-client.ts";

export const MAX_TRANSFER_BYTES = 100 * 1024 * 1024;
const JSON_BYTES = 32 * 1024 * 1024;
// A loaded computer can take seconds to answer. After Stop, the command's own reply gets this long
// to bring its receipt, and a lost reply's receipt is looked up for as long; each request in
// between gets ATTEMPT_MS and is retried until then.
const CONFIRM_MS = 30_000;
const ATTEMPT_MS = 5000;
const RETRY_MS = 250;
const transient = (status: number) => status >= 500 || status === 408 || status === 429;
type ShellChecks = Omit<ShellDiagnosis, "failed" | "lookup" | "ms">;
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
const PutResult = z.strictObject({
  path: z.string().max(1024),
  bytes: z.number().int().nonnegative(),
});
type Scope = { signal: AbortSignal; finish(): void; abort(): void };

export class ShellCleanupUncertainError extends DesktopdError {
  readonly code = "shell_cleanup_uncertain";
  constructor() {
    super(500, "could not confirm command cleanup", "/shell");
    this.name = "ShellCleanupUncertainError";
  }
}

// A reply's status, or why there was none.
export type ShellReply = number | "timeout" | "unreachable" | "malformed";
// Why a command's end could not be confirmed: the check that failed first, what the receipt lookup
// heard, and when, in ms since the request. Only names and numbers: never the command, its output
// or the computer's words.
export interface ShellDiagnosis {
  failed:
    | "request"
    | "stream"
    | "deadline"
    | "stop"
    | "stop_refused"
    | "reply"
    | "output"
    | "closed";
  lookup: "unsupported" | "skipped" | "tried";
  ms: number;
  stoppedAtMs?: number;
  stops: number;
  stopReply?: ShellReply;
  lookups: number;
  lookupReply?: ShellReply;
}

// A request may have reached the cell even when its response was lost. The runner must contain
// this uncertainty through Stop; it must not automatically replay an arbitrary command.
export class ShellExecutionUncertainError extends DesktopdError {
  readonly code = "shell_execution_uncertain";
  constructor(readonly diagnosis?: ShellDiagnosis) {
    super(502, "could not confirm the command result", "/shell");
    this.name = "ShellExecutionUncertainError";
  }
}

const FAILED: Record<ShellDiagnosis["failed"], string> = {
  request: "the command request got no reply",
  stream: "the command's reply broke off",
  deadline: "the command's deadline passed",
  stop: "no receipt came in the wait after Stop",
  stop_refused: "the stop request was refused",
  reply: "the command's reply was malformed",
  output: "its output could not be taken in",
  closed: "the connection to the computer closed",
};
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const answer = (r: ShellReply | undefined) =>
  r === 202 ? "still running" : r === 404 ? "unknown command" : String(r ?? "none");
// One line for the log and the task's step: which check failed, and when.
export function describeShellDiagnosis(d: ShellDiagnosis): string {
  return [
    FAILED[d.failed],
    ...(d.stoppedAtMs === undefined ? [] : [`stopped ${seconds(d.stoppedAtMs)} in`]),
    ...(d.stops ? [`${d.stops} stop requests, last ${answer(d.stopReply)}`] : []),
    d.lookup === "unsupported"
      ? "the computer keeps no receipts"
      : d.lookup === "skipped"
        ? "no receipt lookup"
        : `${d.lookups} receipt checks, last ${answer(d.lookupReply)}`,
    `gave up ${seconds(d.ms)} in`,
  ].join("; ");
}

async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  signal.throwIfAborted();
  return await new Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>>(
    (resolve, reject) => {
      const abort = () => {
        void reader.cancel(signal.reason).catch(() => {});
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      reader
        .read()
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    },
  );
}

async function textBody(res: Response, signal: AbortSignal, limit: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await readChunk(reader, signal);
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error("tool response exceeds its byte limit");
      parts.push(chunk.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, bytes));
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// This client owns one dispatcher for its cell endpoint. Explicit deadlines remain active until
// body completion; undici's implicit five-minute header/body limit cannot truncate a long shell.
export class DesktopdTools {
  readonly #dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  readonly #lifetime = new AbortController();
  readonly #uploads = new Set<Promise<unknown>>();
  readonly #fetch: typeof fetch;

  constructor(
    readonly endpoint: DesktopdEndpoint,
    fetchImpl?: typeof fetch,
    private readonly transferLimit = MAX_TRANSFER_BYTES,
  ) {
    if (
      !Number.isSafeInteger(transferLimit) ||
      transferLimit < 1 ||
      transferLimit > MAX_TRANSFER_BYTES
    )
      throw new RangeError("invalid transfer limit");
    this.#fetch =
      fetchImpl ??
      ((input, init) =>
        transportFetch(
          input as string,
          {
            ...init,
            dispatcher: this.#dispatcher,
          } as Parameters<typeof transportFetch>[1],
        ) as unknown as Promise<Response>);
  }

  async close(): Promise<void> {
    this.#lifetime.abort(new Error("desktop tools closed"));
    await Promise.all([this.#dispatcher.destroy(), Promise.allSettled([...this.#uploads])]);
  }

  #scope(timeoutMs: number, signal?: AbortSignal): Scope {
    const local = new AbortController();
    const timer = setTimeout(
      () => local.abort(new Error("desktop tool deadline exceeded")),
      timeoutMs,
    );
    timer.unref();
    return {
      signal: AbortSignal.any([local.signal, this.#lifetime.signal, ...(signal ? [signal] : [])]),
      finish: () => clearTimeout(timer),
      abort: () => {
        clearTimeout(timer);
        local.abort(new Error("desktop tool cancelled"));
      },
    };
  }

  async #send(
    path: string,
    scope: Scope,
    body?: NonNullable<Parameters<typeof fetch>[1]>["body"],
    contentType?: string,
  ): Promise<Response> {
    scope.signal.throwIfAborted();
    const response = await untilAborted(
      this.#fetch(`${this.endpoint.baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.endpoint.token}`,
          ...(contentType ? { "content-type": contentType } : {}),
        },
        body,
        signal: scope.signal,
        redirect: "error",
        ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
      }).then((response) => {
        if (scope.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          scope.signal.throwIfAborted();
        }
        return response;
      }),
      scope.signal,
    );
    if (scope.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      scope.signal.throwIfAborted();
    }
    return response;
  }

  async #json<T>(
    path: string,
    body: unknown,
    parse: (v: unknown) => T,
    signal?: AbortSignal,
    timeout = 30_000,
  ): Promise<T> {
    const scope = this.#scope(timeout, signal);
    try {
      const res =
        body === undefined
          ? await this.#send(path, scope)
          : await this.#send(path, scope, JSON.stringify(body), "application/json");
      const text = await textBody(res, scope.signal, res.ok ? JSON_BYTES : 4096);
      if (!res.ok) {
        const browserFailure =
          ["/browser/navigate", "/browser/read", "/browser/page"].includes(path) &&
          [409, 502].includes(res.status);
        throw new DesktopdError(
          res.status,
          browserFailure ? browserFailureDetail(text) : "tool request refused",
          path,
        );
      }
      const result = parse(JSON.parse(text));
      scope.signal.throwIfAborted();
      return result;
    } finally {
      scope.abort();
    }
  }

  capabilities(signal?: AbortSignal): Promise<DesktopCapabilities> {
    return this.#json("/capabilities", undefined, DesktopCapabilities.parse, signal, 5000);
  }

  async shell(
    req: ShellRequest,
    onChunk: (c: ShellChunk) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<ShellDone> {
    const id = req.id ?? randomUUID();
    const input = ShellRequest.parse({ ...req, id });
    signal?.throwIfAborted();
    this.#lifetime.signal.throwIfAborted();
    const started = performance.now();
    const since = () => Math.round(performance.now() - started);
    // Do not abort this response on a user handoff: it carries proof of command cleanup.
    const scope = this.#scope(input.timeoutMs + 10_000);
    const checks: ShellChecks = { stops: 0, lookups: 0 };
    let failed: ShellDiagnosis["failed"] | undefined;
    const giveUp = (why: ShellDiagnosis["failed"]) => {
      failed ??= why;
      scope.abort();
    };
    let answered = false;
    let stopping = false;
    let confirmation: ReturnType<typeof setTimeout> | undefined;
    const confirmWithin = (ms: number) => {
      clearTimeout(confirmation);
      confirmation = setTimeout(() => giveUp("stop"), ms);
    };
    const stop = () => {
      if (!answered || stopping) return;
      stopping = true;
      // 404 may race with an already-ended command. Only the original stream's valid terminal
      // result below is proof; this acknowledgement never is. A command the computer no longer
      // runs leaves its reply a moment to bring the receipt before it is looked up.
      void this.#stop(id, scope.signal, checks).then(
        (status) => {
          if (scope.signal.aborted) return;
          if (status === undefined) giveUp("stop_refused");
          else if (status === 404) confirmWithin(ATTEMPT_MS);
        },
        () => {},
      );
    };
    const abort = () => {
      if (checks.stoppedAtMs === undefined) {
        checks.stoppedAtMs = since();
        confirmWithin(CONFIRM_MS);
      }
      stop();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let protocolFailure: DesktopdError | undefined;
    let resultLookup = false;
    let consumerFailed = false;
    let receiving = false;
    try {
      const res = await this.#send("/shell", scope, JSON.stringify(input), "application/json");
      resultLookup = res.headers.get("x-localdot-shell-result") === "1";
      answered = true;
      if (signal?.aborted) stop();
      if (!res.ok) {
        const detail = await textBody(res, scope.signal, 4096);
        protocolFailure = new DesktopdError(
          res.status,
          res.status === 503 && detail === "desktop_memory_pressure"
            ? "Desktop or Docker VM memory is under critical pressure; command was not started. Stop unused previews or build jobs before retrying."
            : "command request refused",
          "/shell",
        );
        throw protocolFailure;
      }
      if (!res.body) throw new ShellExecutionUncertainError();
      reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let pending = "";
      let wireBytes = 0;
      let outputBytes = 0;
      let result: ShellDone | undefined;
      for (;;) {
        receiving = true;
        const chunk = await readChunk(reader, scope.signal);
        receiving = false;
        scope.signal.throwIfAborted();
        wireBytes += chunk.value?.byteLength ?? 0;
        if (wireBytes > JSON_BYTES) throw new ShellExecutionUncertainError();
        pending += decoder.decode(chunk.value, { stream: !chunk.done });
        if (pending.length > 6 * input.maxOutputBytes + 65536)
          throw new ShellExecutionUncertainError();
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
          if (!line.trim()) continue;
          if (result) throw new ShellExecutionUncertainError();
          const value: unknown = JSON.parse(line);
          if (ShellFailure.safeParse(value).success) {
            protocolFailure = new ShellCleanupUncertainError();
            throw protocolFailure;
          }
          if (typeof value !== "object" || value === null) throw new ShellExecutionUncertainError();
          if ("error" in value) throw new ShellExecutionUncertainError();
          if ("done" in value) result = ShellDone.strict().parse(value);
          else {
            const output = ShellChunk.strict().parse(value);
            outputBytes += Buffer.byteLength(output.chunk);
            if (outputBytes > input.maxOutputBytes) throw new ShellExecutionUncertainError();
            if (!signal?.aborted) {
              try {
                await untilAborted(Promise.resolve(onChunk(output)), scope.signal);
              } catch (error) {
                if (!signal?.aborted) {
                  consumerFailed = true;
                  throw error;
                }
                // An in-flight callback may observe the retired generation. Still drain
                // the command's cleanup result, without delivering any further output.
              }
            }
            scope.signal.throwIfAborted();
          }
        }
        if (chunk.done) break;
      }
      if (pending.trim() || !result) throw new ShellExecutionUncertainError();
      return result;
    } catch (error) {
      // Only failures created from this response are trusted. An output consumer can throw
      // an arbitrary DesktopdError after the command has already run.
      if (protocolFailure !== undefined && error === protocolFailure) throw error;
      failed ??= consumerFailed
        ? "output"
        : this.#lifetime.signal.aborted
          ? "closed"
          : scope.signal.aborted
            ? "deadline"
            : !answered
              ? "request"
              : receiving
                ? "stream"
                : "reply";
      // Close the failed transport (which cancels a still-running command), then ask only
      // for this request's terminal receipt. Never replay a side-effecting command.
      scope.abort();
      // A reply that never came cannot say whether the computer keeps receipts; asking is safe.
      const lookup: ShellDiagnosis["lookup"] =
        answered && !resultLookup
          ? "unsupported"
          : consumerFailed || this.#lifetime.signal.aborted
            ? "skipped"
            : "tried";
      if (lookup === "tried") {
        const recovered = await this.#shellResult(id, checks);
        if (recovered) return { ...recovered, outputIncomplete: true };
      }
      throw new ShellExecutionUncertainError({ failed, lookup, ms: since(), ...checks });
    } finally {
      signal?.removeEventListener("abort", abort);
      clearTimeout(confirmation);
      scope.abort();
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }

  // Retries what got no answer while the wait lasts. A command the computer does not know, a reply
  // that makes no sense, or one still running when the wait ends has no receipt: still uncertain.
  async #shellResult(id: string, checks: ShellChecks): Promise<ShellDone | undefined> {
    const scope = this.#scope(CONFIRM_MS);
    try {
      // Explicit cancellation also covers a response transport that ignored abort.
      if (!(await this.#stop(id, scope.signal, checks))) return undefined;
      for (;;) {
        checks.lookups++;
        const reply = await this.#ask("/shell/result", id, scope.signal, 16384);
        checks.lookupReply = typeof reply === "string" ? reply : reply.status;
        if (typeof reply !== "string") {
          // A receipt whose body broke off is kept by the computer; ask again.
          if (reply.status === 200 && reply.body !== undefined) {
            const receipt = z
              .strictObject({ id: z.literal(id), result: ShellDone.strict() })
              .safeParse(parseJson(reply.body));
            if (!receipt.success) checks.lookupReply = "malformed";
            return receipt.data?.result;
          }
          if (![200, 202].includes(reply.status) && !transient(reply.status)) return undefined;
        }
        await untilAborted(new Promise((resolve) => setTimeout(resolve, RETRY_MS)), scope.signal);
      }
    } catch {
      return undefined;
    } finally {
      scope.abort();
    }
  }

  // Asks the computer to stop a command until it answers: 204 stopping, 404 already ended or
  // unknown, undefined when it refuses. The answer only says the request arrived: the command's
  // receipt is what proves it ended.
  async #stop(id: string, until: AbortSignal, checks: ShellChecks): Promise<204 | 404 | undefined> {
    for (;;) {
      checks.stops++;
      const reply = await this.#ask("/shell/stop", id, until, 4096);
      checks.stopReply = typeof reply === "string" ? reply : reply.status;
      if (typeof reply !== "string") {
        if (reply.status === 204 || reply.status === 404) return reply.status;
        if (!transient(reply.status)) return undefined;
      }
      await untilAborted(new Promise((resolve) => setTimeout(resolve, RETRY_MS)), until);
    }
  }

  // One small request about a command, with its own deadline: its status, and its body unless that
  // broke off. Throws only when `until` ends.
  async #ask(
    path: "/shell/stop" | "/shell/result",
    id: string,
    until: AbortSignal,
    limit: number,
  ): Promise<{ status: number; body?: string } | "timeout" | "unreachable"> {
    const attempt = this.#scope(ATTEMPT_MS, until);
    let status: number | undefined;
    try {
      const reply = await this.#send(path, attempt, JSON.stringify({ id }), "application/json");
      status = reply.status;
      return { status, body: await textBody(reply, attempt.signal, limit) };
    } catch {
      until.throwIfAborted();
      this.#lifetime.signal.throwIfAborted();
      if (status !== undefined) return { status };
      return attempt.signal.aborted ? "timeout" : "unreachable";
    } finally {
      attempt.abort();
    }
  }

  readFile(path: string, maxBytes?: number, signal?: AbortSignal): Promise<FileReadResult> {
    return this.#json("/files/read", { path, maxBytes }, FileReadResult.parse, signal);
  }
  writeFile(path: string, content: string, signal?: AbortSignal): Promise<FileChangeResult> {
    return this.#json("/files/write", { path, content }, FileChangeResult.parse, signal);
  }
  editFile(
    path: string,
    oldText: string,
    newText: string,
    signal?: AbortSignal,
  ): Promise<FileChangeResult> {
    return this.#json("/files/edit", { path, oldText, newText }, FileChangeResult.parse, signal);
  }
  listDir(path: string, signal?: AbortSignal): Promise<FileListResult> {
    return this.#json("/files/list", { path }, FileListResult.parse, signal);
  }
  browserRead(maxChars?: number, signal?: AbortSignal): Promise<BrowserReadResult> {
    return this.#json("/browser/read", { maxChars }, BrowserReadResult.parse, signal, 20_000);
  }
  async browserPage(signal?: AbortSignal): Promise<string> {
    return (await this.#json("/browser/page", undefined, BrowserPageResult.parse, signal, 5000))
      .url;
  }
  async prepareBrowser(taskId: string, signal?: AbortSignal): Promise<void> {
    const request = DesktopBrowserTask.parse({ taskId });
    const receipt = await this.#json(
      "/browser/task",
      request,
      DesktopBrowserReady.parse,
      signal,
      20_000,
    );
    if (receipt.taskId !== request.taskId)
      throw new DesktopdError(502, "browser task changed", "/browser/task");
  }
  // Controls by name across the desktop's windows, or the front Chromium page's elements.
  elements(request: ElementsRequest, signal?: AbortSignal): Promise<ElementsResult> {
    return this.#json(
      "/elements",
      ElementsRequest.parse(request),
      ElementsResult.parse,
      signal,
      10_000,
    );
  }
  browserNavigate(url: string, signal?: AbortSignal): Promise<BrowserNavigateResult> {
    return this.#json("/browser/navigate", { url }, BrowserNavigateResult.parse, signal, 20_000);
  }

  async fetchFile(path: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const scope = this.#scope(120_000, signal);
    try {
      const res = await this.#send(`/files/fetch?path=${encodeURIComponent(path)}`, scope);
      if (!res.ok || !res.body)
        throw new DesktopdError(res.status, "file request refused", "/files/fetch");
      return this.#boundedStream(res.body, scope, this.transferLimit);
    } catch (error) {
      scope.abort();
      throw error;
    }
  }

  inspectUpload(path: string, signal?: AbortSignal): Promise<DesktopUploadFile> {
    const pending = inspectDesktopUpload(this.endpoint, path, {
      signal: AbortSignal.any([this.#lifetime.signal, ...(signal ? [signal] : [])]),
      check: () => this.#lifetime.signal.throwIfAborted(),
    });
    this.#trackUpload(pending);
    return pending;
  }

  readUpload(file: DesktopUploadFile, signal?: AbortSignal) {
    this.#lifetime.signal.throwIfAborted();
    const source = readDesktopUpload(this.endpoint, file, {
      signal: AbortSignal.any([this.#lifetime.signal, ...(signal ? [signal] : [])]),
      check: () => this.#lifetime.signal.throwIfAborted(),
    });
    this.#trackUpload(finished(source, { cleanup: true }).catch(() => {}));
    return source;
  }

  #trackUpload(pending: Promise<unknown>): void {
    this.#uploads.add(pending);
    void pending.then(
      () => this.#uploads.delete(pending),
      () => this.#uploads.delete(pending),
    );
  }

  async putFile(
    path: string,
    source: ReadableStream<Uint8Array>,
    mode?: number,
    signal?: AbortSignal,
    createOnly = false,
  ): Promise<string> {
    const scope = this.#scope(120_000, signal);
    let body: ReadableStream<Uint8Array> | undefined;
    const uploaded = { bytes: 0, complete: false };
    try {
      body = this.#boundedStream(source, scope, this.transferLimit, false, uploaded);
      const query = `path=${encodeURIComponent(path)}${mode === undefined ? "" : `&mode=${mode.toString(8)}`}${createOnly ? "&createOnly=1" : ""}`;
      const res = await this.#send(`/files/put?${query}`, scope, body, "application/octet-stream");
      const text = await textBody(res, scope.signal, 4096);
      if (!res.ok) throw new DesktopdError(res.status, "file upload refused", "/files/put");
      const result = PutResult.parse(JSON.parse(text));
      if (!uploaded.complete || result.bytes !== uploaded.bytes)
        throw new Error("file upload was not acknowledged completely");
      scope.signal.throwIfAborted();
      return result.path;
    } finally {
      scope.abort();
      if (body && !body.locked) void body.cancel().catch(() => {});
    }
  }

  async putUserFile(
    file: { path: string; bytes: number; sha256: string },
    source: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<UserUploadReceipt> {
    const parts = file.path.split("/");
    if (
      parts.length !== 4 ||
      parts[0] !== "Downloads" ||
      parts[1] !== "Uploads" ||
      !UserUploadId.safeParse(parts[2]).success ||
      !UserUploadName.safeParse(parts[3]).success
    )
      throw new Error("invalid user upload destination");
    const expected = UserUploadReceipt.parse({ ...file, path: `~/${file.path}` });
    const scope = this.#scope(30 * 60_000, signal);
    let body: ReadableStream<Uint8Array> | undefined;
    try {
      body = this.#boundedStream(source, scope, file.bytes, false);
      const query = new URLSearchParams({
        id: parts[2] as string,
        name: parts[3] as string,
        bytes: String(file.bytes),
        sha256: file.sha256,
      });
      const res = await this.#send(
        `/files/user-upload?${query}`,
        scope,
        body,
        "application/octet-stream",
      );
      const text = await textBody(res, scope.signal, 4096);
      if (!res.ok)
        throw new DesktopdError(
          res.status,
          "incoming file placement unavailable",
          "/files/user-upload",
        );
      const receipt = UserUploadReceipt.parse(JSON.parse(text));
      if (
        receipt.path !== expected.path ||
        receipt.bytes !== expected.bytes ||
        receipt.sha256 !== expected.sha256
      )
        throw new Error("incoming file receipt mismatch");
      scope.signal.throwIfAborted();
      return receipt;
    } finally {
      scope.abort();
      if (body && !body.locked) void body.cancel().catch(() => {});
    }
  }

  #boundedStream(
    source: ReadableStream<Uint8Array>,
    scope: Scope,
    limit: number,
    finishOnEnd = true,
    progress?: { bytes: number; complete: boolean },
  ): ReadableStream<Uint8Array> {
    const reader = source.getReader();
    let total = 0;
    let ended = false;
    const cleanup = () => {
      scope.signal.removeEventListener("abort", abort);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    };
    let output: ReadableStreamDefaultController<Uint8Array>;
    const abort = () => {
      if (ended) return;
      ended = true;
      output.error(scope.signal.reason);
      cleanup();
    };
    return new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
        scope.signal.addEventListener("abort", abort, { once: true });
        if (scope.signal.aborted) abort();
      },
      async pull(controller) {
        try {
          const chunk = await readChunk(reader, scope.signal);
          scope.signal.throwIfAborted();
          if (ended) return;
          if (chunk.done) {
            if (progress) progress.complete = true;
            ended = true;
            controller.close();
            cleanup();
            if (finishOnEnd) scope.finish();
            return;
          }
          total += chunk.value.byteLength;
          if (total > limit) throw new Error("file transfer exceeds its byte limit");
          if (progress) progress.bytes = total;
          controller.enqueue(chunk.value);
        } catch (error) {
          if (!ended) {
            ended = true;
            controller.error(error);
            cleanup();
          }
          scope.abort();
        }
      },
      cancel() {
        if (!ended) {
          ended = true;
          cleanup();
        }
        // A peer can cancel an unused upload body before returning a refusal. Keep its
        // bounded response owner alive; external abort and the deadline still apply.
        if (finishOnEnd) scope.abort();
      },
    });
  }
}
