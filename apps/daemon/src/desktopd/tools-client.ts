import { finished } from "node:stream/promises";
import {
  BrowserNavigateResult,
  BrowserReadResult,
  ElementsRequest,
  ElementsResult,
  FileChangeResult,
  FileListResult,
  FileReadResult,
  ShellChunk,
  ShellDone,
  ShellFailure,
  ShellRequest,
} from "@localdot/protocol";
import { Agent, fetch as transportFetch } from "undici";
import { z } from "zod";
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

// A request may have reached the cell even when its response was lost. The runner must contain
// this uncertainty through Stop; it must not automatically replay an arbitrary command.
export class ShellExecutionUncertainError extends DesktopdError {
  readonly code = "shell_execution_uncertain";
  constructor() {
    super(502, "could not confirm the command result", "/shell");
    this.name = "ShellExecutionUncertainError";
  }
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
      const res = await this.#send(path, scope, JSON.stringify(body), "application/json");
      const text = await textBody(res, scope.signal, res.ok ? JSON_BYTES : 4096);
      if (!res.ok) throw new DesktopdError(res.status, "tool request refused", path);
      const result = parse(JSON.parse(text));
      scope.signal.throwIfAborted();
      return result;
    } finally {
      scope.abort();
    }
  }

  async shell(
    req: ShellRequest,
    onChunk: (c: ShellChunk) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<ShellDone> {
    const input = ShellRequest.parse(req);
    signal?.throwIfAborted();
    this.#lifetime.signal.throwIfAborted();
    const scope = this.#scope(input.timeoutMs + 10_000, signal);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let protocolFailure: DesktopdError | undefined;
    try {
      const res = await this.#send("/shell", scope, JSON.stringify(input), "application/json");
      if (!res.ok) {
        await textBody(res, scope.signal, 4096);
        protocolFailure = new DesktopdError(res.status, "command request refused", "/shell");
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
        const chunk = await readChunk(reader, scope.signal);
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
            await untilAborted(Promise.resolve(onChunk(output)), scope.signal);
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
      throw new ShellExecutionUncertainError();
    } finally {
      scope.abort();
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
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
