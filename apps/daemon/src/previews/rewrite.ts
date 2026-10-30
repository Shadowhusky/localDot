import type { IncomingHttpHeaders } from "node:http";
import { Transform, type TransformCallback } from "node:stream";
import { createBrotliDecompress, createGunzip, createZstdDecompress } from "node:zlib";
import type { PreviewTarget } from "@localdot/protocol";

// A path on every preview's origin that reaches another server in the same computer: a page's link,
// redirect, request or socket to http://localhost:3000/x from the preview of :5173 goes to
// /__localdot/to/http/localhost/3000/x.
export const VIA_PATH = "/__localdot/to";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"]);
const LOCAL_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*localhost$/;
const VIA =
  /^\/__localdot\/to\/(https?)\/(\[::1\]|[a-z0-9.-]{1,253})\/(\d{1,5})(\/[^?#]*)?(\?[^#]*)?$/;

// What a server's pages may name besides the server itself: the computer's own addresses (and its
// name) and the ports something listens on there now.
export interface Computer {
  addresses: readonly string[];
  ports: ReadonlySet<number>;
}

// One answer's way back to a device: the preview's Host (the front's name and port), the server it
// previews, and, for an answer from another server reached through the via path, that path.
export interface Route {
  front: string;
  target: PreviewTarget;
  computer: Computer;
  via?: string;
}

const isComputer = (name: string, addresses: readonly string[]) =>
  LOOPBACK.has(name) || LOCAL_NAME.test(name) || addresses.includes(name);

// Where an address in the computer opens on the device: "" for the server this preview shows, the
// via path for another server listening there now, undefined for anything else.
function placeOf(scheme: string, hostname: string, port: number, route: Route): string | undefined {
  const name = hostname.toLowerCase();
  const { addresses, ports } = route.computer;
  if (!isComputer(name, addresses)) return undefined;
  const own = new URL(`${route.target.scheme}://${route.target.host}`).hostname;
  const sameServer = (n: string) => LOOPBACK.has(n) || addresses.includes(n);
  if (port === route.target.port && (name === own || (sameServer(name) && sameServer(own))))
    return "";
  if (!ports.has(port)) return undefined;
  const secure = scheme === "https" || scheme === "wss";
  const host = name === "0.0.0.0" || name === "[::]" ? "localhost" : name;
  return `${VIA_PATH}/${secure ? "https" : "http"}/${host}/${port}`;
}

// An absolute address in a header, sent to where it opens on the device.
export function previewUrl(value: string, route: Route): string {
  if (!URL.canParse(value)) return value;
  const url = new URL(value);
  const scheme = url.protocol.slice(0, -1);
  if (!["http", "https", "ws", "wss"].includes(scheme) || url.username || url.password)
    return value;
  const secure = scheme === "https" || scheme === "wss";
  const place = placeOf(scheme, url.hostname, Number(url.port || (secure ? 443 : 80)), route);
  if (place === undefined) return value;
  const wire = scheme.startsWith("ws") ? "wss" : "https";
  return `${wire}://${route.front}${place}${url.pathname}${url.search}${url.hash}`;
}

// A Location, Content-Location or Refresh address: absolute ones as previewUrl, and a server reached
// through the via path keeps its root-relative ones there.
function locationOf(value: string, route: Route): string {
  if (route.via && value.startsWith("/") && !value.startsWith("//")) return `${route.via}${value}`;
  return previewUrl(value, route);
}

// Addresses in text: a scheme (or none, as in //localhost:35729/livereload.js) and two slashes,
// plain or as JSON escapes them, then the host and its port. A loopback name without a port is left
// alone: libraries parse paths against "http://localhost", which must keep meaning nothing.
const IN_TEXT =
  /(?:\b(https?|wss?):|(?<![\w:/\\]))(\/\/|\\\/\\\/)(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::(\d{1,5}))?(?![\w-])/gi;

// `origins` keeps only where each address opens, as a page policy's sources name them.
export function rewriteText(text: string, route: Route, origins = false): string {
  return text.replace(
    IN_TEXT,
    (match, scheme: string | undefined, slashes: string, host: string, port?: string) => {
      const name = host.toLowerCase();
      if (!port && !LOCAL_NAME.test(name)) return match;
      const lower = scheme?.toLowerCase();
      const secure = lower === "https" || lower === "wss";
      const place = placeOf(lower ?? "http", name, Number(port ?? (secure ? 443 : 80)), route);
      if (place === undefined) return match;
      const wire = lower ? `${lower.startsWith("ws") ? "wss" : "https"}:` : "";
      const path = origins ? "" : slashes.length > 2 ? place.replaceAll("/", "\\/") : place;
      return `${wire}${slashes}${route.front}${path}`;
    },
  );
}

const SCHEMES = ["https:", "http:", "wss:", "ws:"];
const SLASHES = ["//", "\\/\\/"];

// Whether `rest`, the end of what has arrived so far, may be the start of an address that the next
// part of the body completes.
function mayContinue(rest: string): boolean {
  const lower = rest.toLowerCase();
  const scheme = SCHEMES.find((s) => lower.startsWith(s));
  if (!scheme && SCHEMES.some((s) => s.startsWith(lower))) return true;
  const after = scheme ? rest.slice(scheme.length) : rest;
  const slashes = SLASHES.find((s) => after.startsWith(s));
  if (!slashes) return SLASHES.some((s) => s.startsWith(after));
  const host = after.slice(slashes.length);
  return host.length < 270 && /^[\w.[\]:-]*$/.test(host);
}

// Where the part of `text` that may still grow into an address begins: held back until more arrives.
export function pendingFrom(text: string): number {
  for (let i = Math.max(0, text.length - 300); i < text.length; i++) {
    const c = text[i] as string;
    const before = text[i - 1] ?? "";
    const starts = /[hw]/i.test(c)
      ? !/\w/.test(before)
      : (c === "/" || c === "\\") && !/[\w:/\\]/.test(before);
    if (starts && mayContinue(text.slice(i))) return i;
  }
  return text.length;
}

// Rewrites addresses as the body streams: bytes pass as latin1, which keeps every byte as it was
// (addresses are ASCII), and only an unfinished address at a chunk's end waits for the next.
export class TextRewriter extends Transform {
  #held = "";

  constructor(private readonly route: Route) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    const text = this.#held + chunk.toString("latin1");
    const end = pendingFrom(text);
    this.#held = text.slice(end);
    if (end) this.push(Buffer.from(rewriteText(text.slice(0, end), this.route), "latin1"));
    done();
  }

  override _flush(done: TransformCallback): void {
    if (this.#held) this.push(Buffer.from(rewriteText(this.#held, this.route), "latin1"));
    done();
  }
}

// Types whose bodies may name addresses a page then opens, in an ASCII-compatible charset.
const TEXT_TYPE =
  /^(?:text\/(?:html|css|javascript|ecmascript|xml)|application\/(?:javascript|x-javascript|ecmascript|json|xml|xhtml\+xml|[\w.-]+\+(?:json|xml))|image\/svg\+xml)$/;
const CHARSET = /^(?:utf-?8|us-ascii|iso-8859-1|latin1|windows-1252)$/;
const DECODERS: Record<string, (() => Transform) | undefined> = {
  "": undefined,
  identity: undefined,
  gzip: createGunzip,
  "x-gzip": createGunzip,
  br: createBrotliDecompress,
  zstd: createZstdDecompress,
};

// How an answer's body is rewritten on its way to the device, if it is: its decoder, when the server
// compressed it (the device then receives gzip). Ranges, events and other types pass untouched.
export function bodyRewrite(
  method: string | undefined,
  status: number,
  headers: IncomingHttpHeaders,
): { decode?: () => Transform } | undefined {
  if (method === "HEAD" || status === 204 || status === 206 || status === 304) return undefined;
  if (headers["content-range"]) return undefined;
  const [type = "", ...params] = (headers["content-type"] ?? "").toLowerCase().split(";");
  if (!TEXT_TYPE.test(type.trim())) return undefined;
  const charset = params
    .map((param) => param.trim())
    .find((param) => param.startsWith("charset="))
    ?.slice(8)
    .replace(/"/g, "");
  if (charset && !CHARSET.test(charset)) return undefined;
  const encoding = (headers["content-encoding"] ?? "").trim().toLowerCase();
  if (!(encoding in DECODERS)) return undefined;
  const decode = DECODERS[encoding];
  return decode ? { decode } : {};
}

// The device keeps a server's cookie on the preview's own host: a Domain naming the computer
// (localhost, its address) would make the browser drop it, and a cookie for cross-site use needs
// Secure, which every preview is.
export function deviceCookie(value: string, computer: Computer): string {
  const parts = value.split(";");
  const kept = parts.filter((part, i) => {
    if (i === 0) return true;
    const [name = "", domain = ""] = part.split("=").map((s) => s.trim().toLowerCase());
    return !(name === "domain" && isComputer(domain.replace(/^\./, ""), computer.addresses));
  });
  const attributes = kept.slice(1).map((part) => part.trim().toLowerCase());
  if (attributes.includes("samesite=none") && !attributes.includes("secure")) kept.push(" Secure");
  return kept.join(";");
}

// A header that names addresses a page follows or loads.
export function deviceHeader(name: string, value: string, route: Route): string {
  switch (name) {
    case "location":
    case "content-location":
      return locationOf(value, route);
    case "refresh":
      return value.replace(
        /(url\s*=\s*)(\S+)/i,
        (_, key: string, url: string) => `${key}${locationOf(url, route)}`,
      );
    case "link":
      return value.replace(/<([^>]*)>/g, (_, url: string) => `<${locationOf(url, route)}>`);
    case "content-security-policy":
    case "content-security-policy-report-only":
      return rewriteText(value, route, true);
    default:
      return value;
  }
}

// The address a via path names (with what to ask that server for) and the path's own prefix.
export function viaOf(url: string): { address: string; prefix: string } | undefined {
  const m = VIA.exec(url);
  if (!m) return undefined;
  const [, scheme, host, port, path = "/", query = ""] = m;
  const prefix = `${VIA_PATH}/${scheme}/${host}/${port}`;
  return Number(port) <= 65535
    ? { address: `${scheme}://${host}:${port}${path}${query}`, prefix }
    : undefined;
}
