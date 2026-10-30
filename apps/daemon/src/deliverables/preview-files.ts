import { closeSync, readSync } from "node:fs";
import { fileExtension, VIEWER_LIMITS, viewerKind } from "@localdot/protocol";
import type { Hono } from "hono";
import { outputNameProblem, outputPath } from "../agent/output-store.ts";
import { requestOrigin } from "../guard.ts";
import { decodeHead, maskText } from "./excerpt.ts";
import { rasterType } from "./image-preview.ts";
import { PageQuieter, type Quieted } from "./page-quieter.ts";
import type { PreviewLinks } from "./preview-links.ts";
import { StoredFiles } from "./stored.ts";

const V = VIEWER_LIMITS;
const MEDIA: Readonly<Record<string, string>> = Object.freeze({
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
});
export const BASE = {
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-dns-prefetch-control": "off",
};
// Opened on its own, any of these files is an inert, script-less document of no origin.
export const INERT_POLICY = "default-src 'none'; sandbox";
// An SVG draws its own styles and embedded pictures, and nothing else, even opened on its own.
export const SVG_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";
export const SECURE = {
  "x-content-type-options": "nosniff",
  "content-security-policy": INERT_POLICY,
  "cache-control": "no-store",
};

// A page dot made: no script, form, plugin, frame, font or connection; pictures only embedded or
// from the same task's files, stylesheets inline or from them; framed only by localDot; sandboxed.
// WebKit acts on connection hints, a frame's srcdoc and new-window links before this applies:
// quietPage takes those out of the page itself.
export function htmlPolicy(origin: string, base: string): string {
  const own = `${origin}${base}`;
  return [
    "default-src 'none'",
    `img-src data: ${own}`,
    `style-src 'unsafe-inline' ${own}`,
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${origin}`,
    "sandbox",
  ].join("; ");
}

interface Served {
  type: string;
  policy: string;
  cap?: number;
  // Text is read whole and served as this makes it, or not at all; anything else streams as stored.
  text?: (text: string, signal: AbortSignal) => Quieted | Promise<Quieted>;
}

export const REFUSED = {
  "not shown": [415, "not shown"],
  "too complex": [415, "too complex to preview"],
  busy: [503, "busy"],
  stopped: [503, "stopped"],
} as const;
const masked = (text: string): Quieted => ({ body: maskText(text) });

// One task's files by preview link, for the full preview's frame, pictures and players. Only the
// kinds it shows are served, each with its own type and policy; a picture's type comes from its
// bytes. Media and PDFs answer byte ranges.
export function previewFileRoutes(
  app: Hono,
  deps: {
    home: string;
    port: number;
    links: Pick<PreviewLinks, "resolve">;
    quieter?: PageQuieter;
  },
): void {
  const stored = new StoredFiles(deps.home);
  const quieter = deps.quieter ?? new PageQuieter();
  app.on(["GET", "HEAD"], "/file-previews/:ticket/:name", async (c) => {
    const ticket = c.req.param("ticket");
    const sessionId = deps.links.resolve(ticket);
    const name = c.req.param("name");
    if (!sessionId || outputNameProblem(name) || name.startsWith("."))
      return c.text("not found", 404, BASE);
    const v = c.req.query("v");
    const version = v === undefined ? null : /^[1-9]\d{0,4}$/.test(v) ? Number(v) : undefined;
    if (version === undefined) return c.text("invalid version", 400, BASE);
    const origin = requestOrigin(c.req.header("host"), deps.port);
    if (!origin) return c.text("forbidden host", 403, BASE);
    const served = servedAs(name, origin, `/file-previews/${ticket}/`, quieter);
    const rel = served && outputPath(sessionId, name, version);
    const opened = rel ? stored.open(rel) : undefined;
    if (!served || !opened) return c.text("not found", 404, BASE);
    const { fd, size } = opened;
    let owned = true;
    try {
      if (served.cap !== undefined && size > served.cap) return c.text("too large", 413, BASE);
      const headers: Record<string, string> = { ...BASE, "content-security-policy": served.policy };
      const head = c.req.method === "HEAD";
      if (served.text) {
        const text = decodeHead(read(fd, 0, size), true);
        closeSync(fd);
        owned = false;
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
        const magic = rasterType(read(fd, 0, Math.min(16, size)));
        if (!magic) return c.text("not a picture", 415, BASE);
        type = `image/${magic}`;
      }
      headers["content-type"] = type;
      headers["accept-ranges"] = "bytes";
      const range = byteRange(c.req.header("range"), size);
      if (range === "invalid")
        return new Response(null, {
          status: 416,
          headers: { ...headers, "content-range": `bytes */${size}` },
        });
      const [start, end] = range ?? [0, size - 1];
      headers["content-length"] = String(Math.max(0, end - start + 1));
      if (range) headers["content-range"] = `bytes ${start}-${end}/${size}`;
      const status = range ? 206 : 200;
      if (head || end < start) return new Response(null, { status, headers });
      owned = false;
      return new Response(fileStream(fd, start, end, c.req.raw.signal), { status, headers });
    } finally {
      if (owned) closeSync(fd);
    }
  });
}

export function servedAs(
  name: string,
  origin: string,
  base: string,
  quieter: PageQuieter,
): Served | undefined {
  const kind = viewerKind(name);
  const ext = fileExtension(name);
  if (kind === "picture") return { type: "picture", policy: INERT_POLICY, cap: V.pictureBytes };
  if (kind === "svg")
    return { type: "image/svg+xml", policy: SVG_POLICY, cap: V.svgBytes, text: masked };
  if (kind === "pdf") return { type: "application/pdf", policy: INERT_POLICY, cap: V.pdfBytes };
  if (kind === "html")
    return {
      type: "text/html; charset=utf-8",
      policy: htmlPolicy(origin, base),
      cap: V.htmlBytes,
      text: (text, signal) => quieter.page(text, signal),
    };
  // A page's own stylesheet.
  if (ext === "css")
    return {
      type: "text/css; charset=utf-8",
      policy: INERT_POLICY,
      cap: V.htmlBytes,
      text: masked,
    };
  const media = MEDIA[ext];
  return media ? { type: media, policy: INERT_POLICY } : undefined;
}

function read(fd: number, at: number, length: number): Buffer {
  const out = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, out, done, length - done, at + done);
    if (n === 0) break;
    done += n;
  }
  return out.subarray(0, done);
}

// One byte range ("bytes=0-99", "bytes=100-", "bytes=-100"); anything else is served whole.
export function byteRange(
  header: string | undefined,
  size: number,
): [number, number] | "invalid" | undefined {
  const m = header && /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (!m) return undefined;
  const [, from = "", to = ""] = m;
  if (from === "" && to === "") return "invalid";
  if (from === "") {
    const suffix = Number(to);
    return suffix === 0 || size === 0 ? "invalid" : [Math.max(0, size - suffix), size - 1];
  }
  const start = Number(from);
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  return start >= size || start > end ? "invalid" : [start, end];
}

function fileStream(
  fd: number,
  start: number,
  end: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let at = start;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", close);
    closeSync(fd);
  };
  signal.addEventListener("abort", close, { once: true });
  return new ReadableStream<Uint8Array>({
    pull(output) {
      if (closed) return;
      try {
        const chunk = read(fd, at, Math.min(64 * 1024, end + 1 - at));
        at += chunk.length;
        if (chunk.length > 0) output.enqueue(chunk);
        if (chunk.length === 0 || at > end) {
          close();
          output.close();
        }
      } catch {
        close();
        output.error(new Error("preview interrupted"));
      }
    },
    cancel: close,
  });
}
