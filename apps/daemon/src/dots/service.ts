import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  type AddDotRequest,
  type DotJob,
  DotSelf,
  type DotSummary,
  MAIN_DOT_ID,
} from "../../../../packages/protocol/src/dots.ts";
import type { Sealed } from "../../../../packages/protocol/src/keyd.ts";
import { readInstallToken } from "../install-token-reader.ts";
import { runOpenLink } from "../open-link.ts";
import { dotName, instanceOf } from "./instance.ts";
import { type DotsRegistry, RegistryError } from "./registry.ts";
import { DotsError, type DotsRoutesDeps } from "./routes.ts";

// How this installation runs its localdot command: the installed one for source and package
// installs, or the CLI from this checkout for a development daemon.
export interface DotsCli {
  command: string;
  args: readonly string[];
  cwd: string;
}

export function dotsCli(env: NodeJS.ProcessEnv, development: boolean): DotsCli | undefined {
  if (env.LOCALDOT_INSTALL_PREFIX)
    return { command: join(env.LOCALDOT_INSTALL_PREFIX, "bin", "localdot"), args: [], cwd: "/" };
  if (!development) return undefined;
  return {
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("../../../cli/src/main.ts", import.meta.url))],
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
  };
}

export interface DotsServiceDeps {
  self: string;
  registry: DotsRegistry;
  // Undefined where dots can't be managed from the app, such as a managed release.
  cli?: DotsCli;
  env: NodeJS.ProcessEnv;
  spawn?: typeof nodeSpawn;
  fetch?: typeof fetch;
  // Whether this dot is working on something an update or a stop would interrupt.
  busy(): boolean;
  // The HTTPS addresses other devices reach this dot at.
  origins(): string[];
}

interface Job extends DotJob {
  child?: ChildProcess;
  ended?: number;
}

const JOB_KEEP_MS = 10 * 60_000;
const jobId = () => randomBytes(16).toString("base64url");
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function described(home: string) {
  const instance = instanceOf(home);
  return { instance, name: dotName(home, instance.name) };
}

export class DotsService implements DotsRoutesDeps {
  readonly #jobs = new Map<string, Job>();
  readonly #fetch: typeof fetch;

  constructor(private readonly deps: DotsServiceDeps) {
    this.#fetch = deps.fetch ?? fetch;
  }

  #dots() {
    try {
      return this.deps.registry.read();
    } catch (error) {
      if (error instanceof RegistryError) throw new DotsError(503, error.message);
      throw error;
    }
  }

  #dot(id: string) {
    const entry = this.#dots().find((dot) => dot.id === id);
    if (!entry) throw new DotsError(404, "There's no such dot on this computer.");
    return { ...entry, ...described(entry.home) };
  }

  async #running(port: number): Promise<boolean> {
    try {
      const reply = await this.#fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1500),
        redirect: "error",
      });
      return reply.ok && (await reply.text()) === "ok";
    } catch {
      return false;
    }
  }

  async list() {
    const dots = await Promise.all(
      this.#dots().map(async (entry): Promise<DotSummary | undefined> => {
        let about: ReturnType<typeof described>;
        try {
          about = described(entry.home);
        } catch {
          // A dot whose home can't be read is left out here; localdot dots list shows it.
          return undefined;
        }
        const self = entry.id === this.deps.self;
        return {
          id: entry.id,
          name: about.name,
          port: about.instance.ports.app,
          self,
          main: entry.id === MAIN_DOT_ID,
          state: self || (await this.#running(about.instance.ports.app)) ? "running" : "stopped",
        };
      }),
    );
    return { dots: dots.filter((dot) => dot !== undefined), manage: !!this.deps.cli };
  }

  // Names of the other dots that are working now: an update restarts every dot together.
  async busyOthers(): Promise<string[]> {
    const busy: string[] = [];
    let entries: ReturnType<DotsRegistry["read"]> = [];
    try {
      entries = this.#dots();
    } catch {
      // An unreadable list of dots names none; it never holds an update back.
    }
    for (const entry of entries) {
      if (entry.id === this.deps.self) continue;
      try {
        const { instance, name } = described(entry.home);
        if ((await this.#about(entry.home, instance.ports.app))?.busy) busy.push(name);
      } catch {}
    }
    return busy;
  }

  // What a running dot says about itself, asked with its own token, which this user can read.
  async #about(home: string, port: number) {
    if (!(await this.#running(port))) return undefined;
    try {
      const reply = await this.#fetch(`http://127.0.0.1:${port}/api/dots/self`, {
        headers: { authorization: `Bearer ${readInstallToken(home)}` },
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      return reply.ok ? DotSelf.parse(await reply.json()) : undefined;
    } catch {
      return undefined;
    }
  }

  self() {
    return { busy: this.deps.busy(), origins: this.deps.origins() };
  }

  job(id: string): DotJob | undefined {
    this.#prune();
    const job = this.#jobs.get(id);
    if (!job) return undefined;
    const { child: _child, ended: _ended, ...shown } = job;
    return shown;
  }

  #prune() {
    const now = Date.now();
    for (const [id, job] of this.#jobs)
      if (job.ended && now - job.ended > JOB_KEEP_MS) this.#jobs.delete(id);
  }

  #busyJob(): Job | undefined {
    return [...this.#jobs.values()].find(
      (job) =>
        (job.state === "running" || job.state === "needs-passphrase") && job.kind !== "start",
    );
  }

  #run(kind: DotJob["kind"], args: string[], dot?: string): DotJob {
    const cli = this.deps.cli;
    if (!cli) throw new DotsError(503, "Dots are managed from Terminal on this installation.");
    if (this.#busyJob())
      throw new DotsError(409, "Another dot is being added or removed. Wait for it to finish.");
    const job: Job = {
      id: jobId(),
      kind,
      state: "running",
      step: "Starting",
      ...(dot ? { dot } : {}),
    };
    this.#jobs.set(job.id, job);
    const child = (this.deps.spawn ?? nodeSpawn)(
      cli.command,
      [...cli.args, "dots", ...args, "--json"],
      {
        cwd: cli.cwd,
        env: this.#environment(),
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    job.child = child;
    const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    lines.on("line", (line) => this.#progress(job, line));
    child.once("error", () => this.#end(job, "The localdot command couldn't run."));
    child.once("close", (code) =>
      this.#end(
        job,
        code === 0
          ? undefined
          : "It didn't finish. Run localdot dots list in Terminal to see where it got to.",
      ),
    );
    return this.job(job.id) as DotJob;
  }

  #progress(job: Job, line: string) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.step === "string") job.step = message.step.slice(0, 200);
    if (typeof message.dot === "string") job.dot = message.dot;
    if (message.needs === "passphrase" && typeof message.sealKey === "string") {
      job.state = "needs-passphrase";
      job.sealKey = message.sealKey;
    }
    if (typeof message.error === "string") job.error = message.error.slice(0, 500);
  }

  #end(job: Job, failure?: string) {
    if (job.ended) return;
    job.ended = Date.now();
    delete job.child;
    delete job.sealKey;
    if (job.error || failure) {
      job.state = "failed";
      job.error ??= failure;
    } else job.state = "done";
  }

  #environment(): NodeJS.ProcessEnv {
    const env = this.deps.env;
    const main = this.#dots()[0]?.home;
    return {
      HOME: env.HOME,
      PATH: env.PATH ?? "/usr/bin:/bin",
      LANG: env.LANG ?? "en_US.UTF-8",
      ...(main ? { LOCALDOT_HOME: main } : {}),
      ...(env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME } : {}),
      ...(env.DOCKER_HOST ? { DOCKER_HOST: env.DOCKER_HOST } : {}),
      ...(env.LOCALDOT_INSTALL_PREFIX
        ? { LOCALDOT_INSTALL_PREFIX: env.LOCALDOT_INSTALL_PREFIX }
        : {}),
    };
  }

  add(request: AddDotRequest): DotJob {
    const from = request.from ?? this.deps.self;
    this.#dot(from);
    return this.#run("add", [
      "add",
      request.name,
      "--from",
      from,
      "--copy",
      request.copy.length ? request.copy.join(",") : "none",
    ]);
  }

  passphrase(id: string, sealed: Sealed): DotJob {
    const job = this.#jobs.get(id);
    if (job?.state !== "needs-passphrase" || !job.child?.stdin)
      throw new DotsError(409, "That dot isn't waiting for a passphrase.");
    job.child.stdin.write(`${JSON.stringify({ sealed })}\n`);
    job.state = "running";
    delete job.sealKey;
    return this.job(id) as DotJob;
  }

  cancel(id: string): DotJob {
    const job = this.#jobs.get(id);
    if (job?.state !== "needs-passphrase" || !job.child?.stdin)
      throw new DotsError(409, "That dot isn't waiting for a passphrase.");
    job.child.stdin.end();
    job.state = "running";
    job.step = "Cancelling";
    delete job.sealKey;
    return this.job(id) as DotJob;
  }

  start(id: string): DotJob {
    this.#dot(id);
    return this.#run("start", ["start", id], id);
  }

  stop(id: string): DotJob {
    this.#dot(id);
    if (id === this.deps.self)
      throw new DotsError(
        409,
        "Stop this dot from another dot, or with localdot down in Terminal.",
      );
    return this.#run("stop", ["stop", id], id);
  }

  async remove(id: string, deleteData: boolean, pageOrigin: string) {
    if (id === MAIN_DOT_ID)
      throw new DotsError(409, "The first dot stays; uninstalling localDot removes it.");
    this.#dot(id);
    const args = ["remove", id, ...(deleteData ? ["--delete-data"] : [])];
    if (id !== this.deps.self) return { job: this.#run("remove", args, id) };
    // This dot stops on the way out: the browser goes to another one first, the first dot when it
    // can.
    let next: string | undefined;
    for (const other of this.#dots().filter((dot) => dot.id !== id)) {
      next = await this.signIn(other.id, pageOrigin).then(
        (signIn) => signIn.url,
        () => undefined,
      );
      if (next) break;
    }
    this.#detached(args);
    return next ? { next } : {};
  }

  // A command that stops this daemon must outlive it, in its own process group.
  #detached(args: string[]) {
    const cli = this.deps.cli;
    if (!cli) throw new DotsError(503, "Dots are managed from Terminal on this installation.");
    const child = (this.deps.spawn ?? nodeSpawn)(cli.command, [...cli.args, "dots", ...args], {
      cwd: cli.cwd,
      env: this.#environment(),
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  }

  async signIn(id: string, pageOrigin: string) {
    const dot = this.#dot(id);
    const port = dot.instance.ports.app;
    if (!(await this.#running(port)))
      throw new DotsError(409, `${dot.name} isn't running. Start it first.`);
    let page: URL;
    try {
      page = new URL(pageOrigin);
    } catch {
      throw new DotsError(400, "invalid request");
    }
    const origin = LOOPBACK.has(page.hostname)
      ? `http://127.0.0.1:${port}`
      : (await this.#about(dot.home, port))?.origins.find(
          (candidate) => new URL(candidate).hostname === page.hostname,
        );
    if (!origin)
      throw new DotsError(
        409,
        `${dot.name} can't be opened from this device yet. Open it on this computer, or turn on Tailscale for it.`,
      );
    let link: string | undefined;
    const code = await runOpenLink(
      { home: dot.home, port, signal: AbortSignal.timeout(10_000) },
      { out: (line) => (link ??= line), err: () => {}, fetch: this.#fetch },
    );
    const issued = link?.match(/#code=([A-Za-z0-9_-]{43})$/)?.[1];
    if (code !== 0 || !issued)
      throw new DotsError(409, `${dot.name} didn't give a sign-in. Try again.`);
    return { url: `${origin}/#code=${issued}` };
  }
}
