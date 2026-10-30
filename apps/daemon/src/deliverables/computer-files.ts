import { statSync } from "node:fs";
import {
  ComputerFileReply,
  computerFileName,
  fileExtension,
  isComputerPath,
  type LocalDotEvent,
  PREVIEW_LIMITS,
  type PreviewReason,
  splitAttachments,
  TableFileReply,
  TextFileReply,
  ULID_PATTERN,
  VIEWER_LIMITS,
  viewerKind,
} from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { attachment, TRANSFER_BYTES } from "../agent/download.ts";
import { DesktopdError } from "../desktopd/client.ts";
import type { DesktopdTools } from "../desktopd/tools-client.ts";
import type { EventLog } from "../event-log.ts";
import { requestOrigin } from "../guard.ts";
import { streamEventLines } from "../sessions/ndjson.ts";
import type { ComputerAccess } from "./convert.ts";
import { decodeHead, fileText, textEncoding } from "./excerpt.ts";
import { PreviewRefused, previewPng, rasterType } from "./image-preview.ts";
import type { PageQuieter } from "./page-quieter.ts";
import { BASE, byteRange, REFUSED, SECURE, servedAs } from "./preview-files.ts";
import type { PreviewLinks } from "./preview-links.ts";
import { sheetTable } from "./sheet-file.ts";
import { delimitedTable } from "./table-file.ts";

const V = VIEWER_LIMITS;
const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

type FileAccess = Pick<ComputerAccess, "signal" | "release"> & {
  tools: Pick<DesktopdTools, "readFile" | "fetchFile">;
};
export interface ComputerFiles {
  cellOf(sessionId: string): string | undefined;
  access(cellId: string, signal: AbortSignal): FileAccess | "busy" | undefined;
}
interface ComputerFile {
  size: number;
  // The bytes from start to end, inclusive.
  read(start: number, end: number): Promise<Buffer>;
  // The same as a body, which lets the computer go once it is sent, fails or is cancelled.
  send(start: number, end: number): Promise<ReadableStream<Uint8Array>>;
  release(): void;
}

// The files on dot's computer one task names, and only those: each file dot changed, and each file
// the user sent with a message, which lands in Downloads. They are read through the computer,
// admitted like a user upload, and served as the stored files are.
export function computerFileRoutes(
  app: Hono,
  deps: {
    port: number;
    eventLog: Pick<EventLog, "hasSession" | "logFile">;
    computer: ComputerFiles;
    links: Pick<PreviewLinks, "resolve">;
    quieter: PageQuieter;
  },
): void {
  const named = new NamedFiles(deps.eventLog);
  const reading = async <T>(
    id: string,
    path: string,
    signal: AbortSignal,
    read: (file: ComputerFile) => Promise<T>,
  ): Promise<{ size: number; got: T } | PreviewReason> => {
    const file = await open(deps.computer, id, path, signal);
    if (typeof file === "string") return file;
    try {
      return { size: file.size, got: await read(file) };
    } catch (error) {
      return reasonOf(error);
    } finally {
      file.release();
    }
  };
  const target = (c: Context) => {
    const id = c.req.param("id") ?? "";
    const path = c.req.query("path") ?? "";
    return { id, path, name: computerFileName(path) };
  };

  const base = "/api/agent/sessions/:id/computer-files";
  app.use(`${base}/*`, async (c, next) => {
    const { id, path } = target(c);
    if (!ULID_PATTERN.test(id)) return c.text("invalid task id", 400, NO_STORE);
    if (!isComputerPath(path)) return c.text("invalid path", 400, NO_STORE);
    if (!deps.eventLog.hasSession(id)) return c.text("unknown task", 404, NO_STORE);
    if (!(await named.has(id, path))) return c.text("not found", 404, NO_STORE);
    await next();
    for (const [header, value] of Object.entries(NO_STORE)) c.res.headers.set(header, value);
  });
  app.get(`${base}/about`, async (c) => {
    const { id, path } = target(c);
    const read = await reading(id, path, c.req.raw.signal, async () => undefined);
    return c.json(
      ComputerFileReply.parse(
        typeof read === "string"
          ? { kind: "none", reason: read }
          : { kind: "file", path, bytes: read.size },
      ),
    );
  });
  app.get(`${base}/text`, async (c) => {
    const { id, path } = target(c);
    const from = c.req.query("from") === "end" ? "end" : "start";
    const read = await reading(id, path, c.req.raw.signal, async (file) => {
      const start = from === "end" ? Math.max(0, file.size - V.textBytes) : 0;
      const body = await file.read(start, Math.min(file.size, start + V.textBytes) - 1);
      return { body, head: start === 0 ? body : await file.read(0, 3) };
    });
    return c.json(
      TextFileReply.parse(
        typeof read === "string"
          ? { kind: "none", reason: read }
          : fileText(read.got.body, read.size, from, textEncoding(read.got.head)),
      ),
    );
  });
  app.get(`${base}/table`, async (c) => {
    const { id, path, name } = target(c);
    const sheet = Number(c.req.query("sheet") ?? 0);
    if (!Number.isInteger(sheet) || sheet < 0 || sheet >= V.sheets)
      return c.text("invalid request", 400);
    const kind = viewerKind(name);
    if (kind !== "table" && kind !== "sheet") return c.text("not a table", 400);
    const cap = kind === "table" ? V.tableCountBytes : V.sheetBytes;
    const read = await reading(id, path, c.req.raw.signal, async (file) =>
      kind === "sheet" && file.size > cap ? undefined : file.read(0, Math.min(file.size, cap) - 1),
    );
    let reply: TableFileReply;
    if (typeof read === "string") reply = { kind: "none", reason: read };
    else if (!read.got) reply = { kind: "none", reason: "too_large" };
    else if (kind === "table") reply = delimitedTable(name, read.got, read.size);
    else reply = await sheetTable(name, read.got, sheet, c.req.raw.signal);
    return c.json(TableFileReply.parse(reply));
  });
  app.on(["GET", "HEAD"], `${base}/download`, async (c) => {
    const { id, path, name } = target(c);
    const file = await open(deps.computer, id, path, c.req.raw.signal);
    if (typeof file === "string") return refusal(c, file);
    try {
      if (file.size > TRANSFER_BYTES) return refusal(c, "too_large");
      const headers = {
        "content-type": "application/octet-stream",
        "content-disposition": attachment(name),
        "content-length": String(file.size),
      };
      // Hono discards a HEAD body without cancelling it: none is started.
      if (c.req.method === "HEAD" || file.size === 0)
        return new Response(null, { status: 200, headers });
      return new Response(await file.send(0, file.size - 1), { status: 200, headers });
    } catch (error) {
      return refusal(c, reasonOf(error));
    } finally {
      file.release();
    }
  });
  app.get(`${base}/thumbnail`, async (c) => {
    const { id, path, name } = target(c);
    if (viewerKind(name) !== "picture") return c.text("not a picture", 415);
    const read = await reading(id, path, c.req.raw.signal, async (file) =>
      file.size > PREVIEW_LIMITS.imageInputBytes ? undefined : file.read(0, file.size - 1),
    );
    if (typeof read === "string") return refusal(c, read);
    if (!read.got) return refusal(c, "too_large");
    try {
      const png = await previewPng(read.got);
      return c.body(new Uint8Array(png), 200, { ...SECURE, "content-type": "image/png" });
    } catch (error) {
      if (error instanceof PreviewRefused && error.reason === "too_large")
        return refusal(c, "too_large");
      return c.text("not shown", 415);
    }
  });

  // By preview link, for the full preview's pictures, frame, PDF reader and players. Opened on its
  // own, any file but a page downloads instead of showing.
  app.on(["GET", "HEAD"], "/file-previews/:ticket/computer/:name", async (c) => {
    const ticket = c.req.param("ticket");
    const id = deps.links.resolve(ticket);
    const name = c.req.param("name");
    const path = c.req.query("path") ?? "";
    if (
      !id ||
      !isComputerPath(path) ||
      computerFileName(path) !== name ||
      fileExtension(name) === "css"
    )
      return c.text("not found", 404, BASE);
    const origin = requestOrigin(c.req.header("host"), deps.port);
    if (!origin) return c.text("forbidden host", 403, BASE);
    const served = servedAs(name, origin, `/file-previews/${ticket}/`, deps.quieter);
    if (!served || !(await named.has(id, path))) return c.text("not found", 404, BASE);
    const file = await open(deps.computer, id, path, c.req.raw.signal);
    if (typeof file === "string") return linkRefusal(c, file);
    try {
      if (file.size > (served.cap ?? TRANSFER_BYTES)) return linkRefusal(c, "too_large");
      const headers: Record<string, string> = { ...BASE, "content-security-policy": served.policy };
      if (viewerKind(name) !== "html") headers["content-disposition"] = attachment(name);
      const head = c.req.method === "HEAD";
      if (served.text) {
        const bytes = await file.read(0, file.size - 1);
        file.release();
        const text = decodeHead(bytes, true);
        const shown =
          text === undefined
            ? ({ refused: "not shown" } as const)
            : await served.text(text.replace(/\r\n?/g, "\n"), c.req.raw.signal);
        if ("refused" in shown) {
          const [status, why] = REFUSED[shown.refused];
          return c.text(why, status, BASE);
        }
        headers["content-type"] = served.type;
        return new Response(head ? null : shown.body, { status: 200, headers });
      }
      let type = served.type;
      if (type === "picture") {
        const magic = rasterType(await file.read(0, Math.min(16, file.size) - 1));
        if (!magic) return c.text("not a picture", 415, BASE);
        type = `image/${magic}`;
      }
      headers["content-type"] = type;
      headers["accept-ranges"] = "bytes";
      const range = byteRange(c.req.header("range"), file.size);
      if (range === "invalid")
        return new Response(null, {
          status: 416,
          headers: { ...headers, "content-range": `bytes */${file.size}` },
        });
      const [start, end] = range ?? [0, file.size - 1];
      headers["content-length"] = String(Math.max(0, end - start + 1));
      if (range) headers["content-range"] = `bytes ${start}-${end}/${file.size}`;
      const status = range ? 206 : 200;
      if (head || end < start) return new Response(null, { status, headers });
      return new Response(await file.send(start, end), { status, headers });
    } catch (error) {
      return linkRefusal(c, reasonOf(error));
    } finally {
      file.release();
    }
  });
}

// The computer is held from here until the file's release, or its body's end; a request that goes
// away lets it go too. A path that resolves to another file, through a link, is not the one named.
async function open(
  computer: ComputerFiles,
  id: string,
  path: string,
  request: AbortSignal,
): Promise<ComputerFile | PreviewReason> {
  const cellId = computer.cellOf(id);
  if (!cellId) return "computer_off";
  let access: FileAccess | "busy" | undefined;
  try {
    access = computer.access(cellId, request);
  } catch {
    return "busy";
  }
  if (!access || access === "busy") return access ?? "computer_off";
  const { tools, release } = access;
  const signal = AbortSignal.any([request, access.signal]);
  let held = true;
  const letGo = () => {
    if (!held) return;
    held = false;
    signal.removeEventListener("abort", letGo);
    release();
  };
  signal.addEventListener("abort", letGo, { once: true });
  try {
    const found = await tools.readFile(path, 1, signal);
    if (found.path !== path) {
      letGo();
      return "missing";
    }
    let sending = false;
    return {
      size: found.bytes,
      read: async (start, end) =>
        end < start
          ? Buffer.alloc(0)
          : bytesOf(slice(await tools.fetchFile(path, signal), start, end, () => {})),
      send: async (start, end) => {
        const body = slice(await tools.fetchFile(path, signal), start, end, letGo);
        sending = true;
        return body;
      },
      release: () => {
        if (!sending) letGo();
      },
    };
  } catch (error) {
    letGo();
    return reasonOf(error);
  }
}

function reasonOf(error: unknown): PreviewReason {
  if (!(error instanceof DesktopdError)) return "failed";
  if (error.status === 413) return "too_large";
  return [400, 404, 409].includes(error.status) ? "missing" : "failed";
}
function refusal(c: Context, reason: PreviewReason): Response {
  if (reason === "missing") return c.text("not found", 404);
  if (reason === "too_large") return c.text("file too large", 413);
  if (reason === "busy") return c.text("The computer is busy. Try again in a moment.", 409);
  if (reason === "computer_off") return c.text("Turn on your computer first.", 409);
  return c.text("The computer could not send the file.", 502);
}
function linkRefusal(c: Context, reason: PreviewReason): Response {
  if (reason === "missing") return c.text("not found", 404, BASE);
  if (reason === "too_large") return c.text("too large", 413, BASE);
  return c.text("unavailable", 503, BASE);
}

// The computer streams a file from its start: bytes before start are skipped, and the stream is
// cancelled once end is passed. A file that ends early changed while it was read.
function slice(
  source: ReadableStream<Uint8Array>,
  start: number,
  end: number,
  done: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let at = 0;
  let open = true;
  const finish = () => {
    if (!open) return;
    open = false;
    void reader.cancel().catch(() => {});
    done();
  };
  return new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("the file changed while it was read");
          const from = at;
          at += chunk.value.byteLength;
          if (at <= start) continue;
          output.enqueue(chunk.value.subarray(Math.max(0, start - from), end + 1 - from));
          if (at > end) {
            finish();
            output.close();
          }
          return;
        }
      } catch (error) {
        finish();
        output.error(error);
      }
    },
    cancel: finish,
  });
}
async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
}

const NAMING = /"type":"(?:message\.user|file\.change)"/;

// The paths a task's log names, from one streaming pass cached until the log grows.
class NamedFiles {
  readonly #cache = new Map<string, { size: number; paths: Set<string> }>();
  readonly #reading = new Map<string, Promise<Set<string>>>();
  constructor(private readonly eventLog: Pick<EventLog, "hasSession" | "logFile">) {}
  async has(id: string, path: string): Promise<boolean> {
    if (!this.eventLog.hasSession(id)) return false;
    const file = this.eventLog.logFile(id);
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    const hit = this.#cache.get(id);
    if (hit && hit.size === size) return hit.paths.has(path);
    const key = `${id}:${size}`;
    let reading = this.#reading.get(key);
    if (!reading) {
      reading = namedIn(file).finally(() => this.#reading.delete(key));
      this.#reading.set(key, reading);
    }
    const paths = await reading;
    this.#cache.delete(id);
    this.#cache.set(id, { size, paths });
    if (this.#cache.size > 32) this.#cache.delete(this.#cache.keys().next().value as string);
    return paths.has(path);
  }
}
async function namedIn(file: string): Promise<Set<string>> {
  const paths = new Set<string>();
  for await (const line of streamEventLines(file)) {
    if (!NAMING.test(line)) continue;
    const e = JSON.parse(line) as LocalDotEvent;
    if (e.type === "file.change") paths.add(e.data.path);
    else if (e.type === "message.user")
      for (const path of splitAttachments(e.data.text).files)
        if (path.startsWith("~/Downloads/")) paths.add(path);
  }
  return paths;
}
