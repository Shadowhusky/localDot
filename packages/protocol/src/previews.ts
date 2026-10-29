import { z } from "zod";

// Opening the servers dot starts inside its computer from the owner's devices. The daemon reaches a
// server through desktopd's preview forwarder, which the gate relays like desktopd's own API.
export const PREVIEW_FORWARDER_PORT = 7701;

// What the owner can do with previews right now, and why not when they can't.
export const PreviewsState = z.enum(["ready", "needs-tailscale", "needs-update", "computer-off"]);
export type PreviewsState = z.infer<typeof PreviewsState>;

export const PreviewItem = z.strictObject({
  id: z.string().max(64),
  // The address as dot's computer knows it, such as http://localhost:5173/.
  target: z.string().max(2048),
  // Where the preview opens, without the one-use secret that signs a device in to it.
  origin: z.string().max(256),
  openedAt: z.string(),
});
export type PreviewItem = z.infer<typeof PreviewItem>;

// A server listening in the computer, whether or not it ever printed an address.
export const PreviewServer = z.strictObject({
  port: z.number().int().min(1).max(65535),
  url: z.string().max(256),
  // The program that listens, when the computer can tell.
  name: z.string().max(64).optional(),
});
export type PreviewServer = z.infer<typeof PreviewServer>;

// GET /api/sessions/:id/previews
export const PreviewsStatus = z.strictObject({
  state: PreviewsState,
  // Why previews can't open, with the step that fixes it.
  message: z.string().max(400).optional(),
  // The computer's own network addresses: its servers print them beside localhost.
  addresses: z.array(z.string().max(64)).max(8),
  previews: z.array(PreviewItem).max(256),
  servers: z.array(PreviewServer).max(256),
});
export type PreviewsStatus = z.infer<typeof PreviewsStatus>;

// POST /api/sessions/:id/previews: an address dot printed, or a listening server by its port.
export const PreviewRequest = z.union([
  z.strictObject({ url: z.string().min(1).max(2048) }),
  z.strictObject({ port: z.number().int().min(1).max(65535) }),
]);
export type PreviewRequest = z.infer<typeof PreviewRequest>;

export const PreviewOpened = z.strictObject({
  preview: PreviewItem,
  // Opens the preview once, on any of the owner's devices: its secret is after the #.
  open: z.string().max(512),
});
export type PreviewOpened = z.infer<typeof PreviewOpened>;

// The body of a refused POST (400, 404, 409 or 503).
export const PreviewRefusal = z.strictObject({
  state: PreviewsState.optional(),
  message: z.string().max(400),
});
export type PreviewRefusal = z.infer<typeof PreviewRefusal>;

export interface PreviewTarget {
  scheme: "http" | "https";
  // The server's own name for itself: the Host the preview sends it.
  host: string;
  // What the forwarder dials, as host:port: a loopback name, a *.localhost name or the address.
  dial: string;
  port: number;
  // The path and query the address opens at.
  path: string;
}

const LOCAL_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*localhost$/;
const ANY = new Set(["0.0.0.0", "[::]"]);

// An address that names a server inside the computer: localhost and its subdomains, the loopback
// and any-addresses, or one of the computer's own network addresses. Anything else (a LAN address,
// a public name, credentials in the URL) is not dot's computer.
export function previewTarget(
  address: string,
  computer: readonly string[] = [],
): PreviewTarget | undefined {
  if (address.length > 2048 || !URL.canParse(address)) return undefined;
  const url = new URL(address);
  const scheme = url.protocol === "http:" ? "http" : url.protocol === "https:" ? "https" : null;
  if (!scheme || url.username || url.password) return undefined;
  const port = Number(url.port || (scheme === "https" ? 443 : 80));
  const name = url.hostname;
  const local =
    LOCAL_NAME.test(name) ||
    name === "127.0.0.1" ||
    name === "[::1]" ||
    ANY.has(name) ||
    computer.includes(name);
  if (!local) return undefined;
  // Servers listening on every address answer on loopback, and many accept only loopback names.
  const host = ANY.has(name) ? (url.port ? `localhost:${url.port}` : "localhost") : url.host;
  const dial = `${ANY.has(name) ? "localhost" : name}:${port}`;
  return { scheme, host, dial, port, path: `${url.pathname}${url.search}` };
}

// The daemon's first line to the forwarder: desktopd's token, then what it wants. The forwarder
// answers one line, "OK" (with the listing as JSON for LIST) or "NO <reason>", and an opened
// connection then carries the server's bytes both ways.
export const PREVIEW_PREFACE = "LOCALDOT-PREVIEW/1";
export const PREVIEW_PREFACE_BYTES = 512;
export const PreviewNo = z.enum(["unauthorized", "bad-request", "refused-port", "unreachable"]);
export type PreviewNo = z.infer<typeof PreviewNo>;
export type PreviewCommand = { open: string } | { list: true };

export function previewPreface(token: string, command: PreviewCommand): string {
  return `${PREVIEW_PREFACE} ${token} ${"open" in command ? `OPEN ${command.open}` : "LIST"}\n`;
}

const DIAL = /^(\[::1\]|[a-z0-9.-]{1,253}):(\d{1,5})$/;

export function parsePreviewPreface(
  line: string,
): { token: string; command: PreviewCommand } | undefined {
  const [version, token, verb, dial, ...rest] = line.split(" ");
  if (version !== PREVIEW_PREFACE || !token || rest.length) return undefined;
  if (verb === "LIST" && dial === undefined) return { token, command: { list: true } };
  const m = verb === "OPEN" && dial ? DIAL.exec(dial) : null;
  const port = Number(m?.[2]);
  if (!m || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { token, command: { open: dial as string } };
}

// LIST: the listening sockets, one per port and address.
export const PreviewListener = z.strictObject({
  port: z.number().int().min(1).max(65535),
  // The address it listens on: 0.0.0.0, ::, a loopback address or the computer's own.
  address: z.string().max(64),
  name: z.string().max(64).optional(),
});
export type PreviewListener = z.infer<typeof PreviewListener>;
export const PreviewListing = z.strictObject({
  listeners: z.array(PreviewListener).max(512),
  // The computer's own network addresses.
  addresses: z.array(z.string().max(64)).max(8),
});
export type PreviewListing = z.infer<typeof PreviewListing>;
