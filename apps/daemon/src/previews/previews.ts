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
import { checkServer, titleOf } from "./check.ts";
import {
  frontFor,
  frontHosts,
  type PreviewFront,
  type PreviewFronts,
  previewFronts,
} from "./fronts.ts";
import type { Computer } from "./rewrite.ts";
import type { PreviewServe } from "./serve.ts";
import { ENTRY_PATH, PreviewSite } from "./site.ts";
import { ForwarderMissing, listServers, openTunnel } from "./tunnel.ts";

const IDLE_MS = 2 * 60 * 60_000;
const SWEEP_MS = 60_000;
// A burst of status reads (several devices, a list that polls) asks the computer once.
const LISTING_MS = 2_000;
// What a preview's pages may name is read again this often while they load.
const COMPUTER_MS = 10_000;
// A server that says nothing for this long isn't answering.
const CHECK_MS = 2_000;
// While the list is on show, each server is asked again this often.
const RECHECK_MS = 10_000;
const TITLE_MS = 8_000;
// A server that stops answering stays listed, as not answering, this long after it last did.
const FORGET_MS = 10 * 60_000;
const COMPUTER_OFF = "Turn on your computer to open previews.";
const NO_ANSWER = "Your computer isn't answering. Try again in a moment.";
const NEEDS_UPDATE = "Update your computer to open previews.";
const ANY = new Set(["0.0.0.0", "::", "127.0.0.1", "::1"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

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
  checkMs?: number;
}

interface Open {
  site: PreviewSite;
  cellId: string;
  key: string;
  openedAt: string;
  served: boolean;
}

// What localDot last heard from a listening server.
interface Health {
  // Its program and address: another program on the port is another server.
  key: string;
  checkedAt?: number;
  scheme?: "http" | "https";
  answered: boolean;
  seenAt?: number;
  title?: string;
  titled: boolean;
  // It speaks something other than HTTP, so it isn't asked again.
  other?: boolean;
  checking?: Promise<void>;
}

// The previews of servers in the owner's computers, each on a loopback port of its own from the
// daemon's block. Only the owner opens them; one ends on Stop (the server keeps running), after two
// hours unused, or when its computer stops or is replaced.
export class Previews {
  readonly #open = new Map<number, Open>();
  readonly #lastKey = new Map<number, string>();
  readonly #freedAt = new Map<number, number>();
  readonly #listings = new Map<
    string,
    { at: number; port: number; listing: Promise<PreviewListing> }
  >();
  readonly #computers = new Map<string, { at: number; computer: Computer }>();
  readonly #health = new Map<string, Map<number, Health>>();
  readonly #now: () => number;
  readonly #checkMs: number;
  readonly #unsubscribe: () => void;
  readonly #sweep: NodeJS.Timeout;
  #fronts: PreviewFronts = previewFronts([]);
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PreviewsDeps) {
    this.#now = deps.now ?? Date.now;
    this.#checkMs = deps.checkMs ?? CHECK_MS;
    this.#unsubscribe = deps.cells.subscribe((cell) => {
      if (cell.state !== "ready" || cell.paused) this.#endCell(cell.id);
    });
    this.#sweep = setInterval(() => this.#expire(), deps.sweepEveryMs ?? SWEEP_MS);
    this.#sweep.unref();
  }

  // The web servers answering in the computer now (or lately), and the previews open of them.
  async status(sessionId: string, requestHost?: string): Promise<PreviewsStatus> {
    const cellId = this.#cell(sessionId);
    const fronts = await this.#readFronts();
    const front = frontFor(fronts, requestHost);
    const base = { addresses: [], previews: [], servers: [] };
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
    const servers = await this.#servers(cellId, listing);
    const listed = new Set(servers.map((server) => server.port));
    const found = {
      addresses: listing.addresses,
      previews: this.#items(cellId, front, listed),
      servers,
    };
    return front
      ? { state: "ready", ...found }
      : { state: "needs-tailscale", message: fronts.problem, ...found };
  }

  // One preview at a time, so two taps on the same address share one.
  open(sessionId: string, request: PreviewRequest, requestHost?: string): Promise<PreviewOpened> {
    return this.#queued(() => this.#openNow(sessionId, request, requestHost));
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

  #queued<T>(run: () => Promise<T>): Promise<T> {
    const done = this.#queue.then(run);
    this.#queue = done.catch(() => undefined);
    return done;
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
        : await this.#byPort(cellId, listing, request.port);
    if (!target)
      throw new PreviewError(400, {
        message: "That address isn't in your computer, so it can't open as a preview.",
      });
    const listens = (found: PreviewListing) =>
      found.listeners.some((listener) => listener.port === target.port);
    // A server started since the last listing is in the next one.
    if (
      !listens(listing) &&
      !listens(await this.#listing(cellId, endpoint, true).catch(() => listing))
    )
      throw new PreviewError(409, {
        message: `Nothing is running at ${target.host} in your computer. Start it, then try again.`,
      });
    const open = await this.#site(cellId, target, front);
    return { preview: this.#item(open, front), open: this.#link(open, front, target.path) };
  }

  // A page in one preview going to another server in the same computer: that server's preview, and
  // the link that signs the device in to it there.
  #hop(cellId: string, target: PreviewTarget, requestHost: string): Promise<string> {
    return this.#queued(async () => {
      const front = frontFor(await this.#readFronts(), requestHost);
      if (!front || this.#endpoint(cellId) === "off")
        throw new PreviewError(409, { message: "Open it from localDot instead." });
      return this.#link(await this.#site(cellId, target, front), front, target.path);
    });
  }

  #link(open: Open, front: PreviewFront, path: string): string {
    return `https://${front.hostname}:${open.site.port}${ENTRY_PATH}#${open.site.mint(path)}`;
  }

  // The open preview of `target`'s server, or a new one. Every loopback name reaches the same
  // server; each *.localhost name is a site of its own.
  async #site(cellId: string, target: PreviewTarget, front: PreviewFront): Promise<Open> {
    const name = new URL(`${target.scheme}://${target.host}`).hostname;
    const key = `${target.scheme}://${LOOPBACK.has(name) ? "loopback" : name}:${target.port}`;
    const open =
      [...this.#open.values()].find((o) => o.cellId === cellId && o.key === key) ??
      (await this.#create(cellId, target, key, front));
    if (front.serve && !open.served && this.deps.serve) {
      await this.#serve(open.site.port);
      open.served = true;
    }
    return open;
  }

  async #create(
    cellId: string,
    target: PreviewTarget,
    key: string,
    front: PreviewFront,
  ): Promise<Open> {
    for (const port of this.#freePorts(key)) {
      const site = new PreviewSite({
        port,
        target,
        hosts: () => frontHosts(this.#fronts, port),
        connect: (to) => this.#connect(cellId, to),
        computer: () => this.#computer(cellId),
        hop: (to, host) => this.#hop(cellId, to, host),
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

  // The block's ports a new preview may take, best first: the one this server had before (a device
  // keeps nothing of another's there), then those unused longest, so a browser seldom meets a port
  // that served something else. With every port taken, the preview whose server has gone and that
  // was used least lately gives its port up.
  #freePorts(key: string): number[] {
    const { from, to } = this.deps.range;
    const rank = (port: number) =>
      this.#lastKey.get(port) === key ? Number.NEGATIVE_INFINITY : (this.#freedAt.get(port) ?? 0);
    const free = Array.from({ length: to - from + 1 }, (_, i) => from + i)
      .filter((port) => !this.#open.has(port))
      .sort((a, b) => rank(a) - rank(b) || a - b);
    if (free.length) return free;
    const gone = [...this.#open.values()]
      .filter((open) => {
        const ports = this.#computers.get(open.cellId)?.computer.ports;
        return open.site.idleFor() > 0 && ports !== undefined && !ports.has(open.site.target.port);
      })
      .sort((a, b) => b.site.idleFor() - a.site.idleFor())[0];
    if (!gone) return [];
    this.#end(gone);
    return [gone.site.port];
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

  // A server the list found has no address of its own: it opens at the scheme it answered in.
  async #byPort(
    cellId: string,
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
    const scheme =
      this.#health.get(cellId)?.get(port)?.scheme ??
      (await checkServer((to) => this.#connect(cellId, to), plain, this.#checkMs)).scheme;
    return scheme === "https"
      ? previewTarget(server.url.replace(/^http:/, "https:"), listing.addresses)
      : plain;
  }

  // The listening servers that answer HTTP, each asked again when its answer is old. A server seen
  // for the first time is waited for (a check is short); one asked again shows its answer next time.
  async #servers(cellId: string, listing: PreviewListing): Promise<PreviewServer[]> {
    const listening = serversOf(listing);
    const table = this.#health.get(cellId) ?? new Map<number, Health>();
    this.#health.set(cellId, table);
    for (const port of table.keys())
      if (!listening.some((server) => server.port === port)) table.delete(port);
    const now = this.#now();
    const first: Promise<void>[] = [];
    for (const server of listening) {
      const key = `${server.name ?? ""} ${server.url}`;
      let health = table.get(server.port);
      if (health?.key !== key) {
        health = { key, answered: false, titled: false };
        table.set(server.port, health);
      }
      const due = health.checkedAt === undefined || now - health.checkedAt >= RECHECK_MS;
      if (!health.checking && !health.other && due)
        health.checking = this.#check(cellId, server, health, listing.addresses);
      if (health.checking && health.checkedAt === undefined) first.push(health.checking);
    }
    await Promise.all(first);
    return listening.flatMap((server) => {
      const health = table.get(server.port);
      if (!health?.scheme || health.seenAt === undefined) return [];
      if (!health.answered && this.#now() - health.seenAt > FORGET_MS) return [];
      return [
        {
          ...server,
          url: health.scheme === "https" ? server.url.replace(/^http:/, "https:") : server.url,
          ...(health.title ? { title: health.title } : {}),
          state: health.answered ? "answering" : "not-answering",
          seenAt: new Date(health.seenAt).toISOString(),
        },
      ];
    });
  }

  async #check(
    cellId: string,
    server: Listening,
    health: Health,
    addresses: readonly string[],
  ): Promise<void> {
    const connect = (to: PreviewTarget) => this.#connect(cellId, to);
    try {
      const target = previewTarget(server.url, addresses);
      if (!target) return;
      const check = await checkServer(connect, target, this.#checkMs, health.scheme);
      health.answered = check.answered;
      health.scheme = check.scheme ?? health.scheme;
      health.other = check.other;
      if (check.answered) health.seenAt = this.#now();
      if (check.answered && health.scheme && !health.titled) {
        health.titled = true;
        void titleOf(connect, { ...target, scheme: health.scheme }, TITLE_MS).then((title) => {
          if (title) health.title = title;
        });
      }
    } finally {
      health.checkedAt = this.#now();
      health.checking = undefined;
    }
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

  #listing(cellId: string, endpoint: PreviewEndpoint, fresh = false): Promise<PreviewListing> {
    const now = this.#now();
    const cached = this.#listings.get(cellId);
    if (!fresh && cached && cached.port === endpoint.port && now - cached.at < LISTING_MS)
      return cached.listing;
    const entry = { at: now, port: endpoint.port, listing: listServers(endpoint) };
    this.#listings.set(cellId, entry);
    entry.listing.then(
      ({ addresses, listeners }) =>
        this.#computers.set(cellId, {
          at: now,
          computer: { addresses, ports: new Set(listeners.map((listener) => listener.port)) },
        }),
      () => {
        if (this.#listings.get(cellId) === entry) this.#listings.delete(cellId);
      },
    );
    return entry.listing;
  }

  // What a preview's pages may name in the computer, as last listed, read again in the background
  // once it is old.
  #computer(cellId: string): Computer {
    const known = this.#computers.get(cellId);
    const endpoint = this.#endpoint(cellId);
    if (endpoint && endpoint !== "off" && (!known || this.#now() - known.at >= COMPUTER_MS))
      void this.#listing(cellId, endpoint).catch(() => undefined);
    return known?.computer ?? { addresses: [], ports: new Set() };
  }

  #items(
    cellId: string,
    front: PreviewFront | undefined,
    ports: ReadonlySet<number>,
  ): PreviewItem[] {
    return [...this.#open.values()]
      .filter((open) => open.cellId === cellId && ports.has(open.site.target.port))
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
    this.#freedAt.set(open.site.port, this.#now());
    open.site.close();
    if (open.served) void this.deps.serve?.remove(open.site.port).catch(() => undefined);
  }

  #endCell(cellId: string): void {
    this.#listings.delete(cellId);
    this.#computers.delete(cellId);
    this.#health.delete(cellId);
    for (const open of [...this.#open.values()]) if (open.cellId === cellId) this.#end(open);
  }

  #expire(): void {
    const idleMs = this.deps.idleMs ?? IDLE_MS;
    for (const open of [...this.#open.values()]) if (open.site.idleFor() >= idleMs) this.#end(open);
  }
}

type Listening = Pick<PreviewServer, "port" | "url" | "name">;

// The servers the computer listens with, one per port, at an address a preview can open: loopback
// for one that listens there or everywhere, else the computer's own address it listens on.
export function serversOf(listing: PreviewListing): Listening[] {
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
