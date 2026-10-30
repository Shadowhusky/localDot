import {
  BrowserNavigateRequest,
  BrowserReadRequest,
  FileEditRequest,
  FileListRequest,
  FileReadRequest,
  FileWriteRequest,
  type ShellDone,
  type ShellFailure,
  ShellRequest,
  ShellStopRequest,
  UploadDigest,
  USER_UPLOAD,
  UserUploadId,
  UserUploadName,
  userUploadPath,
  webUrl,
} from "@localdot/protocol";
import type { Context, Hono } from "hono";
import type { z } from "zod";
import { browserFailureCode } from "../../../../../packages/protocol/src/browser-failure.ts";
import {
  DesktopUploadInspect,
  DesktopUploadRead,
} from "../../../../../packages/protocol/src/desktop-uploads.ts";
import { PlacementError, parsePlacementHeader, placeDownload } from "../place-download.ts";
import type { ShellSessions } from "../windows.ts";
import { NavigationError, NoPageError, type PageBrowser } from "./browser.ts";
import { desktopCapabilities } from "./capabilities.ts";
import {
  editFile,
  FileToolError,
  fetchFile,
  listDir,
  MAX_TRANSFER_BYTES,
  putFile,
  putUserFile,
  readFile,
  writeFile,
} from "./files.ts";
import { resolveInHome } from "./home.ts";
import { desktopMemory } from "./memory.ts";
import { runShell, ShellTerminationError, shellEnv } from "./shell.ts";
import { inspectUploadSource, readUploadSource } from "./upload-source.ts";

export interface ToolRouteDeps {
  home: string;
  env: NodeJS.ProcessEnv;
  browser: Pick<PageBrowser, "read" | "navigate"> & Partial<Pick<PageBrowser, "page">>;
  maxFetchBytes?: number;
  maxPutBytes?: number;
  runShell?: typeof runShell;
  placeDownload?: typeof placeDownload;
  // Each command's process session, by the id its caller gave it.
  shells?: ShellSessions;
}

const JSON_FILE_BYTES = 4 * 1024 * 1024 + 64 * 1024;
const SMALL_JSON_BYTES = 64 * 1024;

async function body<T extends z.ZodType>(
  c: Context,
  schema: T,
  maxBytes = SMALL_JSON_BYTES,
): Promise<z.infer<T> | Response> {
  const signal = c.req.raw.signal;
  if (signal.aborted) return c.text("request aborted", 408);
  const reader = c.req.raw.body?.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  const abort = () => {
    void reader?.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (reader) {
      const { value, done } = await reader.read();
      if (signal.aborted) return c.text("request aborted", 408);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) return c.text("request body too large", 413);
      parts.push(value);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, total));
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : c.text("invalid tool request", 400);
  } catch {
    return c.text(
      signal.aborted ? "request aborted" : "invalid JSON body",
      signal.aborted ? 408 : 400,
    );
  } finally {
    signal.removeEventListener("abort", abort);
    void reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}

function failure(c: Context, error: unknown): Response {
  if (c.req.raw.signal.aborted) return c.text("request aborted", 408);
  if ((error as NodeJS.ErrnoException)?.code === "ENOSPC")
    return c.text("not enough computer storage", 507);
  if (error instanceof PlacementError) {
    const status =
      error.code === "request"
        ? 400
        : error.code === "aborted"
          ? 408
          : error.code === "refused"
            ? 409
            : 503;
    return c.text(error.message, status);
  }
  if (error instanceof FileToolError) return c.text(error.message, error.status);
  if (error instanceof NoPageError || error instanceof NavigationError)
    return c.json(
      { error: "browser", code: browserFailureCode(error.message) },
      error instanceof NoPageError ? 409 : 502,
    );
  return c.text("desktop tool failed", 500);
}

function transferPath(c: Context): string | Response {
  const path = c.req.query("path");
  return path && path.length <= 1024 ? path : c.text("valid path is required", 400);
}

export function addToolRoutes(app: Hono, deps: ToolRouteDeps): void {
  app.get("/capabilities", async (c) => {
    try {
      return c.json(await desktopCapabilities(deps.env.PATH, c.req.raw.signal));
    } catch (error) {
      return failure(c, error);
    }
  });
  // Cancellation stops an owned command without discarding its terminal cleanup receipt.
  const commands = new Map<string, AbortController>();
  // Completion metadata only: no command, output, environment or secrets. Kept independently
  // of the response so a disconnected client can verify the result without replaying work.
  const results = new Map<string, { done: ShellDone; at: number }>();
  const pruneResults = () => {
    for (const [id, value] of results) if (Date.now() - value.at > 600_000) results.delete(id);
    while (results.size > 128) {
      const first = results.keys().next().value;
      if (first === undefined) break;
      results.delete(first);
    }
  };
  app.post("/shell/result", async (c) => {
    const req = await body(c, ShellStopRequest, 1024);
    if (req instanceof Response) return req;
    pruneResults();
    const result = results.get(req.id);
    c.header("cache-control", "no-store");
    if (result) return c.json({ id: req.id, result: result.done });
    return c.text(
      commands.has(req.id) ? "command running" : "result unavailable",
      commands.has(req.id) ? 202 : 404,
    );
  });
  app.post("/shell/stop", async (c) => {
    const req = await body(c, ShellStopRequest, 1024);
    if (req instanceof Response) return req;
    const command = commands.get(req.id);
    if (!command) return c.text("command already ended or unknown", 404);
    command.abort(new Error("command cancelled by its owner"));
    return c.body(null, 204);
  });
  app.post("/files/upload-info", async (c) => {
    const request = await body(c, DesktopUploadInspect, 8192);
    if (request instanceof Response) return request;
    try {
      return c.json(await inspectUploadSource(deps.home, request.path, c.req.raw.signal));
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/files/upload-read", async (c) => {
    const request = await body(c, DesktopUploadRead, 8192);
    if (request instanceof Response) return request;
    try {
      return c.body(await readUploadSource(deps.home, request.file, c.req.raw.signal), 200, {
        "content-type": "application/octet-stream",
        "transfer-encoding": "chunked",
        "cache-control": "no-store",
      });
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/downloads/place", async (c) => {
    try {
      const command = parsePlacementHeader(c.req.header("x-localdot-placement"));
      const size = c.req.header("content-length");
      const expected = command.reconcileOnly ? 0 : command.bytes;
      if (size !== undefined && (!/^\d+$/.test(size) || Number(size) !== expected))
        return c.text("invalid download size", 400);
      return c.json(
        await (deps.placeDownload ?? placeDownload)(
          deps.home,
          command,
          c.req.raw.body,
          c.req.raw.signal,
        ),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/shell", async (c) => {
    const req = await body(c, ShellRequest);
    if (req instanceof Response) return req;
    let cwd: string;
    try {
      cwd = resolveInHome(deps.home, req.cwd ?? "~");
    } catch {
      return c.text("working directory must be inside the home", 400);
    }
    const id = req.id;
    pruneResults();
    if (id && (commands.has(id) || results.has(id) || commands.size >= 64))
      return c.text("command unavailable", 409);
    const memory = await desktopMemory();
    if (memory?.pressure === "critical" || memory?.vm?.pressure === "critical")
      return c.text("desktop_memory_pressure", 503);
    // The memory read yields; repeat ownership admission before starting a process.
    if (id && (commands.has(id) || results.has(id) || commands.size >= 64))
      return c.text("command unavailable", 409);
    const stopped = new AbortController();
    const cancel = new AbortController();
    if (id) commands.set(id, cancel);
    const signal = AbortSignal.any([c.req.raw.signal, stopped.signal]);
    const execution = AbortSignal.any([signal, cancel.signal]);
    const encoder = new TextEncoder();
    const output = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (line: unknown) => {
          signal.throwIfAborted();
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        };
        try {
          const done = await (deps.runShell ?? runShell)(
            {
              command: req.command,
              cwd,
              timeoutMs: req.timeoutMs,
              maxOutputBytes: req.maxOutputBytes,
              env: shellEnv(deps.env, deps.home),
              signal: execution,
              ...(id && deps.shells ? { onSpawn: (pid: number) => deps.shells?.add(pid, id) } : {}),
            },
            (chunk) => {
              if (!execution.aborted) send(chunk);
            },
          );
          if (id) {
            results.set(id, { done, at: Date.now() });
            pruneResults();
          }
          send(done);
        } catch (error) {
          if (!signal.aborted) {
            if (error instanceof ShellTerminationError) {
              const terminal: ShellFailure = {
                error: "shell cleanup could not be confirmed; session Stop is required",
                status: 500,
                code: "shell_cleanup_uncertain",
              };
              send(terminal);
            } else send({ error: "shell command failed", status: 500 });
          }
        } finally {
          if (id) commands.delete(id);
          try {
            controller.close();
          } catch {
            /* The response was cancelled. */
          }
        }
      },
      cancel() {
        stopped.abort(new Error("shell response cancelled"));
      },
    });
    return c.body(output, 200, {
      "content-type": "application/x-ndjson",
      ...(id ? { "x-localdot-shell-result": "1" } : {}),
    });
  });

  app.post("/files/read", async (c) => {
    const req = await body(c, FileReadRequest);
    if (req instanceof Response) return req;
    try {
      return c.json(readFile(deps.home, req.path, req.maxBytes));
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/files/write", async (c) => {
    const req = await body(c, FileWriteRequest, JSON_FILE_BYTES);
    if (req instanceof Response) return req;
    try {
      return c.json(writeFile(deps.home, req.path, req.content));
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/files/edit", async (c) => {
    const req = await body(c, FileEditRequest, JSON_FILE_BYTES);
    if (req instanceof Response) return req;
    try {
      return c.json(editFile(deps.home, req.path, req.oldText, req.newText));
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/files/list", async (c) => {
    const req = await body(c, FileListRequest);
    if (req instanceof Response) return req;
    try {
      return c.json(listDir(deps.home, req.path));
    } catch (error) {
      return failure(c, error);
    }
  });
  app.get("/files/fetch", (c) => {
    const path = transferPath(c);
    if (path instanceof Response) return path;
    try {
      return c.body(
        fetchFile(deps.home, path, deps.maxFetchBytes ?? MAX_TRANSFER_BYTES, c.req.raw.signal),
        200,
        {
          "content-type": "application/octet-stream",
          "x-content-type-options": "nosniff",
          "content-disposition": "attachment",
        },
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/files/put", async (c) => {
    const path = transferPath(c);
    if (path instanceof Response) return path;
    const createOnly = c.req.query("createOnly");
    if (createOnly !== undefined && createOnly !== "1")
      return c.text("invalid create-only option", 400);
    const mode = c.req.query("mode");
    if (mode !== undefined && !/^0?[0-7]{3}$/.test(mode)) return c.text("mode must be octal", 400);
    const maxBytes = deps.maxPutBytes ?? MAX_TRANSFER_BYTES;
    const size = c.req.header("content-length");
    if (size !== undefined && (!/^\d+$/.test(size) || Number(size) > maxBytes))
      return c.text("file too large", 413);
    try {
      const source =
        c.req.raw.body ??
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
      return c.json(
        await putFile(
          deps.home,
          path,
          source,
          mode ? Number.parseInt(mode, 8) & 0o755 : undefined,
          maxBytes,
          c.req.raw.signal,
          createOnly === "1",
        ),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/files/user-upload", async (c) => {
    const id = UserUploadId.safeParse(c.req.query("id"));
    const name = UserUploadName.safeParse(c.req.query("name"));
    const sha256 = UploadDigest.safeParse(c.req.query("sha256"));
    const size = c.req.query("bytes") ?? "";
    if (
      !id.success ||
      !name.success ||
      !sha256.success ||
      !/^\d+$/.test(size) ||
      !Number.isSafeInteger(Number(size)) ||
      Number(size) > USER_UPLOAD.bytes
    )
      return c.text("invalid incoming upload", 400);
    const declared = c.req.header("content-length");
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) !== Number(size)))
      return c.text("upload length mismatch", 400);
    try {
      return c.json(
        await putUserFile(
          deps.home,
          userUploadPath(id.data, name.data),
          c.req.raw.body ??
            new ReadableStream({
              start(c) {
                c.close();
              },
            }),
          { bytes: Number(size), sha256: sha256.data },
          c.req.raw.signal,
        ),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.get("/browser/page", async (c) => {
    if (!deps.browser.page) return c.text("page address is unavailable", 503);
    try {
      return c.json(await deps.browser.page(c.req.raw.signal));
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/browser/read", async (c) => {
    const req = await body(c, BrowserReadRequest);
    if (req instanceof Response) return req;
    try {
      return c.json(await deps.browser.read(req.maxChars, c.req.raw.signal));
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/browser/navigate", async (c) => {
    const req = await body(c, BrowserNavigateRequest);
    if (req instanceof Response) return req;
    const url = webUrl(req.url);
    if (!url) return c.text("only http and https pages can be opened", 400);
    try {
      return c.json(await deps.browser.navigate(url.href, c.req.raw.signal));
    } catch (error) {
      return failure(c, error);
    }
  });
}
