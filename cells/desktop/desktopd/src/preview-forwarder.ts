import type { LookupAddress } from "node:dns";
import { connect, createServer, type LookupFunction, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import {
  PREVIEW_PREFACE_BYTES,
  type PreviewListing,
  type PreviewNo,
  parsePreviewPreface,
} from "@localdot/protocol";
import { tokenMatches } from "./auth.ts";
import { listeningSockets } from "./connection-owner.ts";

// localDot's own services in the computer, which are never previews: the stream (nginx on 3000 and
// 3001, Selkies on 8082), desktopd (7700) and this forwarder (7701), the proxy forwarder that adds
// the computer's key-layer token (3129) and the desktop browser's DevTools (9222).
export const OWN_PORTS: ReadonlySet<number> = new Set([3000, 3001, 3129, 7700, 7701, 8082, 9222]);
const PREFACE_MS = 5_000;
const CONNECT_MS = 10_000;
const MAX_LISTENERS = 512;

export interface PreviewForwarderOptions {
  token: string;
  ownPorts?: ReadonlySet<number>;
  addresses?(): string[];
  listening?(): Promise<{ address: string; port: number; name?: string }[]>;
  prefaceMs?: number;
  connectMs?: number;
}

// The daemon's way to the servers dot starts here, through the gate's preview relay: one line names
// what it wants (parsePreviewPreface), then the connection carries that server's bytes both ways.
// The token is desktopd's own, so only the daemon that started this computer gets through.
export function createPreviewForwarder(opts: PreviewForwarderOptions): Server {
  const own = opts.ownPorts ?? OWN_PORTS;
  const addresses = opts.addresses ?? ownAddresses;
  const names = new Map<string, string>();
  const listening =
    opts.listening ??
    (() => listeningSockets(undefined, undefined, (port) => !own.has(port), names));
  return createServer((client) => {
    client.on("error", () => client.destroy());
    client.setNoDelay(true);
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => refuse(client, "bad-request"), opts.prefaceMs ?? PREFACE_MS);
    client.once("close", () => clearTimeout(timer));
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(0x0a);
      if (end < 0 && buffered.length <= PREVIEW_PREFACE_BYTES) return;
      client.off("data", onData);
      client.pause();
      clearTimeout(timer);
      const preface =
        end >= 0 && end <= PREVIEW_PREFACE_BYTES
          ? parsePreviewPreface(buffered.subarray(0, end).toString("latin1"))
          : undefined;
      if (!preface) return refuse(client, "bad-request");
      if (!tokenMatches(opts.token, preface.token)) return refuse(client, "unauthorized");
      if ("list" in preface.command) {
        void list(client, listening, own, addresses);
        return;
      }
      open(client, preface.command.open, buffered.subarray(end + 1), own, addresses(), opts);
    };
    client.on("data", onData);
  });
}

export function ownAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .flatMap((entry) =>
      entry && entry.family === "IPv4" && !entry.internal ? [entry.address] : [],
    )
    .slice(0, 8);
}

// Where to dial for a host the daemon named: every *.localhost name is loopback, as in a browser.
export function dialTarget(
  dial: string,
  addresses: readonly string[],
): { host: string; port: number; lookup?: LookupFunction } | undefined {
  const at = dial.lastIndexOf(":");
  const name = dial.slice(0, at);
  const port = Number(dial.slice(at + 1));
  if (name === "localhost" || name.endsWith(".localhost"))
    return { host: "localhost", port, lookup: bothLoopbacks };
  if (name === "127.0.0.1") return { host: name, port };
  if (name === "[::1]") return { host: "::1", port };
  return addresses.includes(name) ? { host: name, port } : undefined;
}

// A computer with no IPv6 network resolves localhost to 127.0.0.1 alone (Node asks for the
// families it has addresses in), yet Vite and other servers bind localhost as ::1: both are tried.
const bothLoopbacks: LookupFunction = (_name, options, callback) => {
  const all = [
    { address: "127.0.0.1", family: 4 },
    { address: "::1", family: 6 },
  ];
  if (options.all) (callback as (error: null, all: LookupAddress[]) => void)(null, all);
  else callback(null, "127.0.0.1", 4);
};

async function list(
  client: Socket,
  listening: NonNullable<PreviewForwarderOptions["listening"]>,
  own: ReadonlySet<number>,
  addresses: () => string[],
) {
  try {
    const all = await listening();
    const listing: PreviewListing = {
      listeners: all.filter((entry) => !own.has(entry.port)).slice(0, MAX_LISTENERS),
      addresses: addresses(),
    };
    if (!client.destroyed) client.end(`OK ${JSON.stringify(listing)}\n`);
  } catch {
    refuse(client, "unreachable");
  }
}

function open(
  client: Socket,
  dial: string,
  rest: Buffer,
  own: ReadonlySet<number>,
  addresses: readonly string[],
  opts: PreviewForwarderOptions,
) {
  const target = dialTarget(dial, addresses);
  if (!target) return refuse(client, "bad-request");
  if (own.has(target.port)) return refuse(client, "refused-port");
  let piped = false;
  const upstream = connect({ ...target, autoSelectFamily: true });
  const timer = setTimeout(() => {
    upstream.destroy();
    refuse(client, "unreachable");
  }, opts.connectMs ?? CONNECT_MS);
  upstream.on("error", () => {
    clearTimeout(timer);
    if (piped) client.destroy();
    else refuse(client, "unreachable");
  });
  client.once("close", () => {
    clearTimeout(timer);
    upstream.destroy();
  });
  upstream.once("connect", () => {
    clearTimeout(timer);
    if (client.destroyed) return void upstream.destroy();
    piped = true;
    upstream.setNoDelay(true);
    upstream.setKeepAlive(true, 30_000);
    client.setKeepAlive(true, 30_000);
    client.write("OK\n");
    if (rest.length) upstream.write(rest);
    upstream.once("close", () => client.end());
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  });
}

function refuse(client: Socket, reason: PreviewNo) {
  if (!client.destroyed && !client.writableEnded) client.end(`NO ${reason}\n`);
}
