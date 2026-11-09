import type { Socket } from "node:net";
import { isIP } from "node:net";
import { basename } from "node:path";
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
  type ResultPreview,
} from "@localdot/protocol";
import type { PortRange } from "../cells/ports.ts";
import type { CellEndpoints, CellSummary, PreviewEndpoint } from "../cells/types.ts";
import { checkServer, siteAnswers, titleOf } from "./check.ts";
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
import {
  ForwarderMissing,
  ForwarderRefused,
  listServers,
  openTunnel,
  stopServer,
} from "./tunnel.ts";

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
// A preview someone loaded this lately is in use, even with no socket left open.
const IN_USE_MS = 5 * 60_000;
// The computer's clock runs at 100 ticks a second, and a server using this share of a processor is
// working for someone (a render, a job) even with nobody connected.
const TICKS_PER_SECOND = 100;
const BUSY_SHARE = 0.05;
const MAX_OFFERS = 4;
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
  list?(): readonly CellSummary[];
  endpoints(id: string): CellEndpoints | undefined;
  subscribe(listener: (cell: CellSummary) => void): () => void;
}

export interface PreviewsDeps {
  range: PortRange;
  cells: PreviewCells;
  // The computer a task ran on.
  cellOf(sessionId: string): string | undefined;
  // The tasks of the conversation a task belongs to, itself included.
  conversation?(sessionId: string): readonly string[];
  // A task is under way on this computer, or the user holds it: nothing of dot's is stopped then.
  working?(cellId: string): boolean;
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
  // A *.localhost site's own answer, when it was last asked.
  answered: boolean;
  seenAt: number;
  checkedAt?: number;
  checking?: Promise<void>;
}

// What localDot last heard from a listening server.
interface Health {
  // Its program and address: another program on the port is another server.
  key: string;
  checkedAt?: number;
  scheme?: "http" | "https";
  answered: boolean;
  firstSeen: number;
  seenAt?: number;
  title?: string;
  titled: boolean;
  titling?: Promise<void>;
  // It speaks something other than HTTP, so it isn't asked again.
  other?: boolean;
  checking?: Promise<void>;
}

// When a server dot started was last used, and how much processor it had used then.
interface Use {
  usedAt: number;
  cpu?: number;
  at: number;
}

// What a turn did, for the previews its reply comes with.
export interface PreviewTurn {
  // When it began.
  startedAt: number;
  reply: string;
  // The addresses dot's browser went to, as host:port.
  navigated: readonly string[];
  // The files it wrote, ~/ under the computer's home.
  changed: readonly string[];
}

// The previews of servers in the owner's computers, each on a loopback port of its own from the
// daemon's block. Only the owner opens them; one ends on Stop (the server keeps running), after two
// hours unused, or when its computer stops or is replaced.
//
// Servers dot starts outlive the commands that started them, so what nobody uses is stopped: a
// server a task's shell started, once its task's servers have gone unused for the same two hours,
// or at once when the same app has been started again. Nothing is stopped while a task is under way
// or the user holds the computer, nor anything dot can't be said to have started.
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
  readonly #use = new Map<string, Map<string, Use>>();
  readonly #now: () => number;
  readonly #checkMs: number;
  readonly #unsubscribe: () => void;
  readonly #sweep: NodeJS.Timeout;
  #fronts: PreviewFronts = previewFronts([]);
  #queue: Promise<unknown> = Promise.resolve();
  #sweeping = false;

  constructor(private readonly deps: PreviewsDeps) {
    this.#now = deps.now ?? Date.now;
    this.#checkMs = deps.checkMs ?? CHECK_MS;
    this.#unsubscribe = deps.cells.subscribe((cell) => {
      if (cell.state !== "ready" || cell.paused) this.#endCell(cell.id);
    });
    this.#sweep = setInterval(() => void this.sweep(), deps.sweepEveryMs ?? SWEEP_MS);
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
    const tasks = new Set(this.deps.conversation?.(sessionId) ?? [sessionId]);
    const servers = await this.#servers(cellId, listing, tasks);
    const listed = new Set(servers.map((server) => server.port));
    await this.#sites(cellId);
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

  // Ends the server on a port in the computer, and the preview of it.
  async stopServer(sessionId: string, port: number): Promise<void> {
    const cellId = this.#cell(sessionId);
    const endpoint = this.#endpoint(cellId);
    if (endpoint === "off")
      throw new PreviewError(409, { state: "computer-off", message: COMPUTER_OFF });
    if (!endpoint) throw new PreviewError(409, { state: "needs-update", message: NEEDS_UPDATE });
    const listing = await this.#listing(cellId, endpoint, true).catch(() => {
      throw new PreviewError(409, { state: "computer-off", message: NO_ANSWER });
    });
    if (!serversOf(listing).some((server) => server.port === port))
      throw new PreviewError(409, {
        message: `Nothing is listening on port ${port} in your computer anymore.`,
      });
    try {
      await stopServer(endpoint, port);
    } catch (error) {
      throw error instanceof ForwarderRefused && error.reason === "bad-request"
        ? new PreviewError(409, { state: "needs-update", message: NEEDS_UPDATE })
        : new PreviewError(409, { message: "localDot couldn't stop it. Try again in a moment." });
    }
    this.#stopped(cellId, port);
  }

  // The web apps a turn started or changed that answer now, for its reply. One it named or went to
  // in dot's browser is plainly a page to look at; one it only started, or changed a file of, must
  // serve a page, so an API or a database beside it isn't offered. Another conversation's never is.
  async offers(sessionId: string, turn: PreviewTurn): Promise<ResultPreview[]> {
    const cellId = this.deps.cellOf(sessionId);
    const endpoint = cellId && this.#endpoint(cellId);
    if (!cellId || !endpoint || endpoint === "off") return [];
    const listing = await this.#listing(cellId, endpoint, true);
    const tasks = new Set(this.deps.conversation?.(sessionId) ?? [sessionId]);
    await this.#servers(cellId, listing, tasks);
    const table = this.#health.get(cellId);
    await Promise.all([...(table?.values() ?? [])].map((health) => health.titling));
    const servers = await this.#servers(cellId, listing, tasks);
    const facts = new Map(serversOf(listing).map((server) => [server.port, server]));
    const named = namedPorts(turn.reply, listing.addresses);
    const went = new Map(
      turn.navigated.flatMap((address) => {
        const port = Number(/:(\d{1,5})$/.exec(address)?.[1]);
        return port ? [[port, address] as const] : [];
      }),
    );
    const rank = (server: PreviewServer): number | undefined => {
      const project = facts.get(server.port)?.project;
      if (named.has(server.port)) return 0;
      if (went.has(server.port)) return 1;
      if (!server.title) return undefined;
      if ((table?.get(server.port)?.firstSeen ?? 0) >= turn.startedAt) return 2;
      return project && turn.changed.some((path) => path.startsWith(`${project}/`)) ? 3 : undefined;
    };
    return servers
      .filter((server) => server.state === "answering" && server.here !== false && !server.older)
      .flatMap((server) => {
        const order = rank(server);
        return order === undefined ? [] : [{ order, server }];
      })
      .sort((a, b) => a.order - b.order)
      .slice(0, MAX_OFFERS)
      .map(({ server }) => {
        const host = went.get(server.port)?.split(":")[0];
        const site = host?.endsWith(".localhost")
          ? `${new URL(server.url).protocol}//${went.get(server.port)}/`
          : undefined;
        return {
          port: server.port,
          url: site ?? server.url,
          ...(server.title && !site ? { title: server.title } : {}),
          ...(server.project ? { project: server.project } : {}),
          ...(server.name ? { name: server.name } : {}),
        };
      });
  }

  // Runs every minute: what has gone unused ends. Public for its tests.
  async sweep(): Promise<void> {
    if (this.#sweeping) return;
    this.#sweeping = true;
    try {
      this.#expire();
      for (const cell of this.deps.cells.list?.() ?? [])
        await this.#reap(cell.id).catch(() => undefined);
    } finally {
      this.#sweeping = false;
    }
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
    // On the Mac's own localhost a preview needs no tailnet.
    if (!front && request.local === undefined)
      throw new PreviewError(409, { state: "needs-tailscale", message: fronts.problem });
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
    const open =
      front && request.local === undefined
        ? await this.#site(cellId, target, front)
        : await this.#local(cellId, target, request.local ?? target.port);
    return { preview: this.#item(open, front), open: this.#link(open, front, target.path) };
  }

  // A page in one preview going to another server in the same computer: that server's preview, and
  // the link that signs the device in to it there. From a preview on the Mac, the other server
  // opens on the Mac too, at its own port.
  #hop(
    cellId: string,
    target: PreviewTarget,
    requestHost: string,
    local: boolean,
  ): Promise<string> {
    return this.#queued(async () => {
      const front = frontFor(await this.#readFronts(), requestHost);
      if ((!front && !local) || this.#endpoint(cellId) === "off")
        throw new PreviewError(409, { message: "Open it from localDot instead." });
      const open =
        front && !local
          ? await this.#site(cellId, target, front)
          : await this.#local(cellId, target, target.port, false);
      return this.#link(open, front, target.path);
    });
  }

  #link(open: Open, front: PreviewFront | undefined, path: string): string {
    return `${this.#origin(open, front)}${ENTRY_PATH}#${open.site.mint(path)}`;
  }

  #origin(open: Open, front: PreviewFront | undefined): string {
    if (open.site.local) return `http://localhost:${open.site.port}`;
    return front ? `https://${front.hostname}:${open.site.port}` : "";
  }

  // The open preview of `target`'s server, or a new one. Every loopback name reaches the same
  // server; each *.localhost name is a site of its own.
  async #site(cellId: string, target: PreviewTarget, front: PreviewFront): Promise<Open> {
    const key = siteKey(target);
    const open =
      [...this.#open.values()].find((o) => o.cellId === cellId && o.key === key && !o.site.local) ??
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
        hop: (to, host) => this.#hop(cellId, to, host, false),
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
        answered: true,
        seenAt: this.#now(),
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

  // A preview on the Mac's own loopback at http://localhost:<port>: the address the app's sign-in
  // provider has registered, so its redirects and callbacks land on the app. The owner chooses the
  // port; one something on the Mac already answers on, or one of the block, is refused. Another app
  // the owner had open at the same address gives it up.
  async #local(cellId: string, target: PreviewTarget, port: number, replace = true): Promise<Open> {
    const { from, to } = this.deps.range;
    if (port >= from && port <= to)
      throw new PreviewError(400, {
        message: `localDot keeps localhost:${port} for its own previews. Choose another port.`,
      });
    const key = siteKey(target);
    const there = this.#open.get(port);
    if (there?.site.local && there.cellId === cellId && there.key === key) return there;
    if (there && !replace)
      throw new PreviewError(409, {
        message: `localhost:${port} on this Mac is showing another app. Open this one from localDot.`,
      });
    if (there) {
      this.#end(there);
      await there.site.closed;
    }
    const site = new PreviewSite({
      port,
      target,
      local: true,
      hosts: () => localHosts(target, port),
      connect: (to) => this.#connect(cellId, to),
      computer: () => this.#computer(cellId),
      hop: (to, host) => this.#hop(cellId, to, host, true),
      reused: false,
      now: this.#now,
    });
    try {
      await site.listen();
    } catch (error) {
      site.close();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE")
        throw new PreviewError(409, {
          message: `Something on this Mac already uses localhost:${port}. Stop it, or choose another port.`,
        });
      if (code === "EACCES")
        throw new PreviewError(409, {
          message: `This Mac doesn't let localDot use localhost:${port}. Choose another port.`,
        });
      throw error;
    }
    const open: Open = {
      site,
      cellId,
      key,
      openedAt: new Date(this.#now()).toISOString(),
      served: false,
      answered: true,
      seenAt: this.#now(),
    };
    this.#open.set(port, open);
    return open;
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
        if (open.site.local) return false;
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
  async #servers(
    cellId: string,
    listing: PreviewListing,
    tasks?: ReadonlySet<string>,
  ): Promise<PreviewServer[]> {
    const listening = serversOf(listing);
    const table = this.#health.get(cellId) ?? new Map<number, Health>();
    this.#health.set(cellId, table);
    for (const port of table.keys())
      if (!listening.some((server) => server.port === port)) table.delete(port);
    const now = this.#now();
    const first: Promise<void>[] = [];
    for (const server of listening) {
      const key = `${server.name ?? ""} ${server.url} ${server.started ?? ""}`;
      let health = table.get(server.port);
      if (health?.key !== key) {
        health = { key, answered: false, titled: false, firstSeen: now };
        table.set(server.port, health);
      }
      const due = health.checkedAt === undefined || now - health.checkedAt >= RECHECK_MS;
      if (!health.checking && !health.other && due)
        health.checking = this.#check(cellId, server, health, listing.addresses);
      if (health.checking && health.checkedAt === undefined) first.push(health.checking);
    }
    await Promise.all(first);
    const found = listening.flatMap((server) => {
      const health = table.get(server.port);
      if (!health?.scheme || health.seenAt === undefined) return [];
      if (!health.answered && this.#now() - health.seenAt > FORGET_MS) return [];
      return [{ server, health, seenAt: health.seenAt, scheme: health.scheme }];
    });
    const older = olderCopies(found);
    return found.map(({ server, health, seenAt, scheme }) => ({
      port: server.port,
      url: scheme === "https" ? server.url.replace(/^http:/, "https:") : server.url,
      ...(server.name ? { name: server.name } : {}),
      ...(health.title ? { title: health.title } : {}),
      state: health.answered ? "answering" : "not-answering",
      seenAt: new Date(seenAt).toISOString(),
      ...(server.project ? { project: basename(server.project).slice(0, 128) } : {}),
      ...(server.task && tasks ? { here: tasks.has(server.task) } : {}),
      ...(older.has(server.port) ? { older: true as const } : {}),
    }));
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
        health.titling = titleOf(connect, { ...target, scheme: health.scheme }, TITLE_MS).then(
          (title) => {
            if (title) health.title = title;
            health.titling = undefined;
          },
        );
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
      origin: this.#origin(open, front),
      openedAt: open.openedAt,
      ...(named(open) ? { state: open.answered ? "answering" : "not-answering" } : {}),
      ...(open.site.local ? { local: true as const } : {}),
    };
  }

  // Asks each *.localhost site whether it is still there. A site seen for the first time is waited
  // for; one asked again shows its answer next time.
  async #sites(cellId: string): Promise<void> {
    const first: Promise<void>[] = [];
    const now = this.#now();
    for (const open of this.#open.values()) {
      if (open.cellId !== cellId || !named(open) || open.checking) continue;
      if (open.checkedAt !== undefined && now - open.checkedAt < RECHECK_MS) continue;
      const known = open.checkedAt !== undefined;
      open.checking = siteAnswers(
        (to) => this.#connect(cellId, to),
        open.site.target,
        this.#checkMs,
      )
        .catch(() => false)
        .then((answered) => {
          open.answered = answered;
          if (answered) open.seenAt = this.#now();
          open.checkedAt = this.#now();
          open.checking = undefined;
        });
      if (!known) first.push(open.checking);
    }
    await Promise.all(first);
  }

  // Whether what a server dot started is doing counts as use now.
  #inUse(cellId: string, server: Listening): boolean {
    return (
      (server.clients ?? 0) > 0 ||
      [...this.#open.values()].some(
        (open) =>
          open.cellId === cellId &&
          open.site.target.port === server.port &&
          open.site.idleFor() < IN_USE_MS,
      )
    );
  }

  async #reap(cellId: string): Promise<void> {
    const endpoint = this.#endpoint(cellId);
    if (!endpoint || endpoint === "off") return;
    const listing = await this.#listing(cellId, endpoint, true);
    const servers = await this.#servers(cellId, listing);
    await this.#sites(cellId);
    const now = this.#now();
    for (const open of [...this.#open.values()])
      if (
        open.cellId === cellId &&
        named(open) &&
        !open.answered &&
        now - open.seenAt > FORGET_MS &&
        open.site.idleFor() > FORGET_MS
      )
        this.#end(open);
    const working = this.deps.working?.(cellId) ?? true;
    const dots = serversOf(listing).filter((server) => server.task);
    const usedAt = this.#noteUse(cellId, dots, working, now);
    if (working) return;
    const idleMs = this.deps.idleMs ?? IDLE_MS;
    const older = new Set(servers.filter((server) => server.older).map((server) => server.port));
    for (const server of dots) {
      const unused = now - (usedAt.get(server.task ?? "") ?? now) >= idleMs;
      const replaced = older.has(server.port) && !this.#inUse(cellId, server);
      if (!unused && !replaced) continue;
      try {
        await stopServer(endpoint, server.port);
        console.info(
          `previews: stopped ${server.name ?? "a server"} on port ${server.port} (${replaced ? "started again" : "unused"})`,
        );
        this.#stopped(cellId, server.port);
      } catch {
        // A computer too old to stop one, or one that wouldn't: it stays listed for the owner.
      }
    }
  }

  // When each task's servers were last used: they work together, as a web app and its API do.
  #noteUse(
    cellId: string,
    dots: readonly Listening[],
    working: boolean,
    now: number,
  ): Map<string, number> {
    const table = this.#use.get(cellId) ?? new Map<string, Use>();
    this.#use.set(cellId, table);
    const keyOf = (server: Listening) => `${server.port} ${server.started ?? ""}`;
    const keys = new Set(dots.map(keyOf));
    for (const key of table.keys()) if (!keys.has(key)) table.delete(key);
    const usedAt = new Map<string, number>();
    for (const server of dots) {
      const key = keyOf(server);
      const use = table.get(key) ?? { usedAt: now, at: now };
      table.set(key, use);
      const seconds = (now - use.at) / 1000;
      const busy =
        seconds > 0 &&
        server.cpu !== undefined &&
        use.cpu !== undefined &&
        (server.cpu - use.cpu) / TICKS_PER_SECOND / seconds >= BUSY_SHARE;
      if (working || busy || this.#inUse(cellId, server)) use.usedAt = now;
      use.cpu = server.cpu;
      use.at = now;
      const task = server.task ?? "";
      usedAt.set(task, Math.max(usedAt.get(task) ?? 0, use.usedAt));
    }
    return usedAt;
  }

  #stopped(cellId: string, port: number): void {
    this.#listings.delete(cellId);
    this.#health.get(cellId)?.delete(port);
    for (const open of [...this.#open.values()])
      if (open.cellId === cellId && open.site.target.port === port) this.#end(open);
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
    this.#use.delete(cellId);
    for (const open of [...this.#open.values()]) if (open.cellId === cellId) this.#end(open);
  }

  #expire(): void {
    const idleMs = this.deps.idleMs ?? IDLE_MS;
    for (const open of [...this.#open.values()]) if (open.site.idleFor() >= idleMs) this.#end(open);
  }
}

type Listening = Pick<PreviewServer, "port" | "url" | "name"> &
  Pick<PreviewListing["listeners"][number], "task" | "project" | "started" | "cpu" | "clients">;

// Every loopback name reaches the same server; each *.localhost name is a site of its own.
function siteKey(target: PreviewTarget): string {
  const name = new URL(`${target.scheme}://${target.host}`).hostname;
  return `${target.scheme}://${LOOPBACK.has(name) ? "loopback" : name}:${target.port}`;
}

// The names a preview on the Mac's `port` answers to: the loopback ones, and a *.localhost site's.
function localHosts(target: PreviewTarget, port: number): Set<string> {
  const name = new URL(`${target.scheme}://${target.host}`).hostname;
  return new Set(
    [...LOOPBACK, ...(name.endsWith(".localhost") ? [name] : [])].map((host) => `${host}:${port}`),
  );
}

// A *.localhost site is one name among those its port's proxy routes.
const named = (open: Open) =>
  new URL(`${open.site.target.scheme}://${open.site.target.host}`).hostname.endsWith(".localhost");

// A web app started again on another port is the same folder, program and first page's title. An API
// beside it has no title of its own, so it never reads as an older copy of it.
function olderCopies(found: readonly { server: Listening; health: Health }[]): ReadonlySet<number> {
  const newest = new Map<string, { port: number; at: number }>();
  const older = new Set<number>();
  for (const { server, health } of found) {
    if (!health.title || !health.answered) continue;
    const app = `${server.project ?? ""}\n${server.name ?? ""}\n${health.title}`;
    const at = server.started ?? health.firstSeen;
    const best = newest.get(app);
    if (best && best.at >= at) older.add(server.port);
    else {
      if (best) older.add(best.port);
      newest.set(app, { port: server.port, at });
    }
  }
  return older;
}

const ADDRESS = /(\[::1\]|[a-z0-9.-]+):(\d{1,5})\b/gi;

// The ports of the computer's servers a reply names.
function namedPorts(reply: string, addresses: readonly string[]): ReadonlySet<number> {
  const ports = new Set<number>();
  for (const [, host = "", port] of reply.matchAll(ADDRESS)) {
    const name = host.toLowerCase();
    if (
      LOOPBACK.has(name) ||
      ANY.has(name) ||
      name.endsWith(".localhost") ||
      addresses.includes(name)
    )
      ports.add(Number(port));
  }
  return ports;
}

// The servers the computer listens with, one per port, at an address a preview can open: loopback
// for one that listens there or everywhere, else the computer's own address it listens on.
export function serversOf(listing: PreviewListing): Listening[] {
  const ports = new Map<
    number,
    { local: boolean; address?: string; facts: Omit<Listening, "port" | "url"> }
  >();
  for (const { address, port, ...facts } of listing.listeners) {
    const local = ANY.has(address) || address.startsWith("127.");
    const own = listing.addresses.includes(address);
    if (!local && !own) continue;
    const entry = ports.get(port) ?? { local: false, facts };
    entry.local ||= local;
    if (own) entry.address ??= address;
    ports.set(port, entry);
  }
  return [...ports]
    .sort(([a], [b]) => a - b)
    .slice(0, 256)
    .map(([port, { local, address, facts }]) => ({
      port,
      url: `http://${local ? "localhost" : address}:${port}/`,
      ...facts,
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
