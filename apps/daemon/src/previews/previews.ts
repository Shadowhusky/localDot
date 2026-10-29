import type { Socket } from "node:net";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import {
  type PreviewItem,
  type PreviewListing,
  type PreviewOpened,
  type PreviewRefusal,
  type PreviewRequest,
  type PreviewServer,
  type PreviewsStatus,
  type PreviewTarget,
  previewTarget,
} from "@localdot/protocol";
import type { PortRange } from "../cells/ports.ts";
import type { CellEndpoints, CellSummary, PreviewEndpoint } from "../cells/types.ts";
import {
  frontFor,
  frontHosts,
  type PreviewFront,
  type PreviewFronts,
  previewFronts,
} from "./fronts.ts";
import type { PreviewServe } from "./serve.ts";
import { ENTRY_PATH, PreviewSite } from "./site.ts";
import { ForwarderMissing, listServers, openTunnel } from "./tunnel.ts";

const IDLE_MS = 2 * 60 * 60_000;
const SWEEP_MS = 60_000;
// A burst of status reads (several devices, a list that polls) asks the computer once.
const LISTING_MS = 2_000;
const PROBE_MS = 3_000;
const COMPUTER_OFF = "Turn on your computer to open previews.";
const NO_ANSWER = "Your computer isn't answering. Try again in a moment.";
const NEEDS_UPDATE = "Update your computer to open previews.";
const ANY = new Set(["0.0.0.0", "::", "127.0.0.1", "::1"]);

export class PreviewError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    readonly refusal: PreviewRefusal,
  ) {
    super(refusal.message);
    this.name = "PreviewError";
  }
}

export interface PreviewCells {
  get(id: string): CellSummary | undefined;
  endpoints(id: string): CellEndpoints | undefined;
  subscribe(listener: (cell: CellSummary) => void): () => void;
}

export interface PreviewsDeps {
  range: PortRange;
  cells: PreviewCells;
  // The computer a task ran on.
  cellOf(sessionId: string): string | undefined;
  fronts(): Promise<PreviewFronts>;
  serve?: Pick<PreviewServe, "add" | "remove" | "close">;
  now?: () => number;
  idleMs?: number;
  sweepEveryMs?: number;
}

interface Open {
  site: PreviewSite;
  cellId: string;
  key: string;
  openedAt: string;
  served: boolean;
}

// The previews of servers in the owner's computers, each on a loopback port of its own from the
// daemon's block. Only the owner opens them; one ends on Stop (the server keeps running), after two
// hours unused, or when its computer stops or is replaced.
export class Previews {
  readonly #open = new Map<number, Open>();
  readonly #lastKey = new Map<number, string>();
  readonly #listings = new Map<
    string,
    { at: number; port: number; listing: Promise<PreviewListing> }
  >();
  readonly #now: () => number;
  readonly #unsubscribe: () => void;
  readonly #sweep: NodeJS.Timeout;
  #fronts: PreviewFronts = previewFronts([]);
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PreviewsDeps) {
    this.#now = deps.now ?? Date.now;
    this.#unsubscribe = deps.cells.subscribe((cell) => {
      if (cell.state !== "ready" || cell.paused) this.#endCell(cell.id);
    });
    this.#sweep = setInterval(() => this.#expire(), deps.sweepEveryMs ?? SWEEP_MS);
    this.#sweep.unref();
  }

  async status(sessionId: string, requestHost?: string): Promise<PreviewsStatus> {
    const cellId = this.#cell(sessionId);
    const fronts = await this.#readFronts();
    const front = frontFor(fronts, requestHost);
    const base = { addresses: [], previews: this.#items(cellId, front), servers: [] };
    const endpoint = this.#endpoint(cellId);
    if (endpoint === "off") return { state: "computer-off", message: COMPUTER_OFF, ...base };
    if (!endpoint) return { state: "needs-update", message: NEEDS_UPDATE, ...base };
    let listing: PreviewListing;
    try {
      listing = await this.#listing(cellId, endpoint);
    } catch (error) {
      return error instanceof ForwarderMissing && error.silent
        ? { state: "needs-update", message: NEEDS_UPDATE, ...base }
        : { state: "computer-off", message: NO_ANSWER, ...base };
    }
    const found = { addresses: listing.addresses, servers: serversOf(listing) };
    return front
      ? { state: "ready", ...base, ...found }
      : { state: "needs-tailscale", message: fronts.problem, ...base, ...found };
  }

  // One preview at a time, so two taps on the same address share one.
  open(sessionId: string, request: PreviewRequest, requestHost?: string): Promise<PreviewOpened> {
    const opened = this.#queue.then(() => this.#openNow(sessionId, request, requestHost));
    this.#queue = opened.catch(() => undefined);
    return opened;
  }

  stop(sessionId: string, id: string): boolean {
    const cellId = this.#cell(sessionId);
    const open = [...this.#open.values()].find((o) => o.cellId === cellId && o.site.id === id);
    if (open) this.#end(open);
    return !!open;
  }

  async close(): Promise<void> {
    clearInterval(this.#sweep);
    this.#unsubscribe();
    for (const open of [...this.#open.values()]) this.#end(open);
    await this.deps.serve?.close();
  }

  async #openNow(
    sessionId: string,
    request: PreviewRequest,
    requestHost?: string,
  ): Promise<PreviewOpened> {
    const cellId = this.#cell(sessionId);
    const endpoint = this.#endpoint(cellId);
    if (endpoint === "off")
      throw new PreviewError(409, { state: "computer-off", message: COMPUTER_OFF });
    if (!endpoint) throw new PreviewError(409, { state: "needs-update", message: NEEDS_UPDATE });
    const listing = await this.#listing(cellId, endpoint).catch((error) => {
      throw error instanceof ForwarderMissing && error.silent
        ? new PreviewError(409, { state: "needs-update", message: NEEDS_UPDATE })
        : new PreviewError(409, { state: "computer-off", message: NO_ANSWER });
    });
    const fronts = await this.#readFronts();
    const front = frontFor(fronts, requestHost);
    if (!front) throw new PreviewError(409, { state: "needs-tailscale", message: fronts.problem });
    const target =
      "url" in request
        ? previewTarget(request.url, listing.addresses)
        : await this.#probe(endpoint, listing, request.port);
    if (!target)
      throw new PreviewError(400, {
        message: "That address isn't in your computer, so it can't open as a preview.",
      });
    const key = `${target.scheme}://${target.host} ${target.dial}`;
    const open =
      [...this.#open.values()].find((o) => o.cellId === cellId && o.key === key) ??
      (await this.#create(cellId, target, key, front));
    if (front.serve && !open.served && this.deps.serve) {
      await this.#serve(open.site.port);
      open.served = true;
    }
    const secret = open.site.mint(target.path);
    return {
      preview: this.#item(open, front),
      open: `https://${front.hostname}:${open.site.port}${ENTRY_PATH}#${secret}`,
    };
  }

  async #create(
    cellId: string,
    target: PreviewTarget,
    key: string,
    front: PreviewFront,
  ): Promise<Open> {
    for (let port = this.deps.range.from; port <= this.deps.range.to; port++) {
      if (this.#open.has(port)) continue;
      const site = new PreviewSite({
        port,
        target,
        hosts: () => frontHosts(this.#fronts, port),
        connect: () => this.#connect(cellId, target),
        reused: this.#lastKey.get(port) !== key,
        now: this.#now,
      });
      try {
        await site.listen();
      } catch (error) {
        site.close();
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") continue;
        throw error;
      }
      const open: Open = {
        site,
        cellId,
        key,
        openedAt: new Date(this.#now()).toISOString(),
        served: false,
      };
      if (front.serve && this.deps.serve) {
        try {
          await this.#serve(port);
          open.served = true;
        } catch (error) {
          site.close();
          throw error;
        }
      }
      this.#open.set(port, open);
      this.#lastKey.set(port, key);
      return open;
    }
    throw new PreviewError(503, {
      message: "Every preview address is in use. Stop a preview, then try again.",
    });
  }

  async #serve(port: number): Promise<void> {
    try {
      await this.deps.serve?.add(port);
    } catch {
      throw new PreviewError(503, {
        message: "Tailscale couldn't share this preview. Check Tailscale, then try again.",
      });
    }
  }

  async #connect(cellId: string, target: PreviewTarget): Promise<Duplex> {
    const endpoint = this.deps.cells.endpoints(cellId)?.preview;
    if (!endpoint) throw new ForwarderMissing(true);
    const socket = await openTunnel(endpoint, target.dial);
    return target.scheme === "https" ? secure(socket, target) : socket;
  }

  // A server the list found has no address of its own: it opens at whichever of http and https
  // it answers.
  async #probe(
    endpoint: PreviewEndpoint,
    listing: PreviewListing,
    port: number,
  ): Promise<PreviewTarget | undefined> {
    const server = serversOf(listing).find((entry) => entry.port === port);
    if (!server)
      throw new PreviewError(409, {
        message: `Nothing is listening on port ${port} in your computer anymore.`,
      });
    const plain = previewTarget(server.url, listing.addresses);
    if (!plain) return undefined;
    if (await speaksHttp(endpoint, plain)) return plain;
    const tls = previewTarget(server.url.replace(/^http:/, "https:"), listing.addresses);
    return tls && (await speaksTls(endpoint, tls)) ? tls : plain;
  }

  #cell(sessionId: string): string {
    const id = this.deps.cellOf(sessionId);
    if (!id)
      throw new PreviewError(404, {
        message: "localDot can't tell which computer this task used.",
      });
    return id;
  }

  #endpoint(cellId: string): PreviewEndpoint | "off" | undefined {
    const cell = this.deps.cells.get(cellId);
    const endpoints =
      cell?.state === "ready" && !cell.paused ? this.deps.cells.endpoints(cellId) : undefined;
    return endpoints ? endpoints.preview : "off";
  }

  async #readFronts(): Promise<PreviewFronts> {
    try {
      this.#fronts = await this.deps.fronts();
    } catch {
      // The last fronts stand until Tailscale answers again.
    }
    return this.#fronts;
  }

  #listing(cellId: string, endpoint: PreviewEndpoint): Promise<PreviewListing> {
    const now = this.#now();
    const cached = this.#listings.get(cellId);
    if (cached && cached.port === endpoint.port && now - cached.at < LISTING_MS)
      return cached.listing;
    const entry = { at: now, port: endpoint.port, listing: listServers(endpoint) };
    this.#listings.set(cellId, entry);
    entry.listing.catch(() => {
      if (this.#listings.get(cellId) === entry) this.#listings.delete(cellId);
    });
    return entry.listing;
  }

  #items(cellId: string, front: PreviewFront | undefined): PreviewItem[] {
    return [...this.#open.values()]
      .filter((open) => open.cellId === cellId)
      .map((open) => this.#item(open, front));
  }

  #item(open: Open, front: PreviewFront | undefined): PreviewItem {
    const { scheme, host } = open.site.target;
    return {
      id: open.site.id,
      target: `${scheme}://${host}/`,
      origin: front ? `https://${front.hostname}:${open.site.port}` : "",
      openedAt: open.openedAt,
    };
  }

  #end(open: Open): void {
    if (this.#open.get(open.site.port) !== open) return;
    this.#open.delete(open.site.port);
    open.site.close();
    if (open.served) void this.deps.serve?.remove(open.site.port).catch(() => undefined);
  }

  #endCell(cellId: string): void {
    this.#listings.delete(cellId);
    for (const open of [...this.#open.values()]) if (open.cellId === cellId) this.#end(open);
  }

  #expire(): void {
    const idleMs = this.deps.idleMs ?? IDLE_MS;
    for (const open of [...this.#open.values()]) if (open.site.idleFor() >= idleMs) this.#end(open);
  }
}

// The servers the computer listens with, one per port, at an address a preview can open: loopback
// for one that listens there or everywhere, else the computer's own address it listens on.
export function serversOf(listing: PreviewListing): PreviewServer[] {
  const ports = new Map<number, { local: boolean; address?: string; name?: string }>();
  for (const { address, port, name } of listing.listeners) {
    const local = ANY.has(address) || address.startsWith("127.");
    const own = listing.addresses.includes(address);
    if (!local && !own) continue;
    const entry = ports.get(port) ?? { local: false };
    entry.local ||= local;
    if (own) entry.address ??= address;
    entry.name ??= name;
    ports.set(port, entry);
  }
  return [...ports]
    .sort(([a], [b]) => a - b)
    .slice(0, 256)
    .map(([port, { local, address, name }]) => ({
      port,
      url: `http://${local ? "localhost" : address}:${port}/`,
      ...(name ? { name } : {}),
    }));
}

// Development servers use certificates of their own making; the connection already ends at the
// computer's loopback, so there is no other server it could reach.
function secure(socket: Socket, target: PreviewTarget): Duplex {
  const name = new URL(`https://${target.host}`).hostname;
  return tlsConnect({
    socket,
    rejectUnauthorized: false,
    ALPNProtocols: ["http/1.1"],
    ...(isIP(name) || name.startsWith("[") ? {} : { servername: name }),
  });
}

async function speaksHttp(endpoint: PreviewEndpoint, target: PreviewTarget): Promise<boolean> {
  const socket = await openTunnel(endpoint, target.dial).catch(() => undefined);
  if (!socket) return false;
  return new Promise((resolve) => {
    const done = (answer: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => done(false), PROBE_MS);
    socket.once("data", (chunk: Buffer) =>
      done(chunk.subarray(0, 5).toString("latin1") === "HTTP/"),
    );
    socket.once("close", () => done(false));
    socket.resume();
    socket.write(`HEAD / HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`);
  });
}

async function speaksTls(endpoint: PreviewEndpoint, target: PreviewTarget): Promise<boolean> {
  const socket = await openTunnel(endpoint, target.dial).catch(() => undefined);
  if (!socket) return false;
  const tls = secure(socket, target);
  return new Promise((resolve) => {
    const done = (answer: boolean) => {
      clearTimeout(timer);
      tls.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => done(false), PROBE_MS);
    tls.once("secureConnect", () => done(true));
    tls.once("error", () => done(false));
    tls.once("close", () => done(false));
  });
}
