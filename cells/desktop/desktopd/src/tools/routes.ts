import {
  BrowserNavigateRequest,
  BrowserReadRequest,
  FileEditRequest,
  FileListRequest,
  FileReadRequest,
  FileWriteRequest,
  type ShellFailure,
  ShellRequest,
  webUrl,
} from "@localdot/protocol";
import type { Context, Hono } from "hono";
import type { z } from "zod";
import { NavigationError, NoPageError, type PageBrowser } from "./browser.ts";
import {
  editFile,
  FileToolError,
  fetchFile,
  listDir,
  MAX_TRANSFER_BYTES,
  putFile,
  readFile,
  writeFile,
} from "./files.ts";
import { resolveInHome } from "./home.ts";
import { runShell, ShellTerminationError, shellEnv } from "./shell.ts";

export interface ToolRouteDeps {
  home: string;
  env: NodeJS.ProcessEnv;
  browser: Pick<PageBrowser, "read" | "navigate">;
  maxFetchBytes?: number;
  maxPutBytes?: number;
  runShell?: typeof runShell;
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
  if (error instanceof FileToolError) return c.text(error.message, error.status);
  if (error instanceof NoPageError) return c.text(error.message, 409);
  if (error instanceof NavigationError) return c.text(error.message, 502);
  return c.text("desktop tool failed", 500);
}

function transferPath(c: Context): string | Response {
  const path = c.req.query("path");
  return path && path.length <= 1024 ? path : c.text("valid path is required", 400);
}

export function addToolRoutes(app: Hono, deps: ToolRouteDeps): void {
  app.post("/shell", async (c) => {
    const req = await body(c, ShellRequest);
    if (req instanceof Response) return req;
    let cwd: string;
    try {
      cwd = resolveInHome(deps.home, req.cwd ?? "~");
    } catch {
      return c.text("working directory must be inside the home", 400);
    }
    const stopped = new AbortController();
    const signal = AbortSignal.any([c.req.raw.signal, stopped.signal]);
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
              signal,
            },
            send,
          );
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
    return c.body(output, 200, { "content-type": "application/x-ndjson" });
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
        ),
      );
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
