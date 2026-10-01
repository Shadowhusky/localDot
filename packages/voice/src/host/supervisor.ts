import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";

export const VOICED_PORT = 4752;
export const STARTUP_POLL_MS = 500;
export const STARTUP_TIMEOUT_MS = 120_000;
export const HEALTH_EVERY_MS = 5000;
export const HEALTH_FAILURES = 3;
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 30_000];
export const STABLE_MS = 60_000;
export const KILL_AFTER_MS = 5000;
// voiced never sees the host's other variables, so no provider key can reach it.
const PASSED_ENV = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "HF_HOME",
  "HF_HUB_CACHE",
  "HF_HUB_OFFLINE",
  "UV_CACHE_DIR",
  "LOCALDOT_ASR",
  "LOCALDOT_LMSTUDIO_URL",
  "LOCALDOT_VOICED_IDLE_S",
];

export type VoicedStatus = "stopped" | "starting" | "ready" | "restarting";

export interface VoicedHealth {
  ok: boolean;
  voice: "pack" | "stock";
  slots: Record<string, { state: string; reason: string | null }>;
}

export interface ChildLike {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly stderr?: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "ignore", "pipe"]; detached: true },
) => ChildLike;

export interface SupervisorOptions {
  command: string[];
  port?: number;
  voiceDir?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnLike;
  fetch?: typeof fetch;
}

export class VoicedSupervisor {
  readonly token = randomBytes(32).toString("base64url");
  readonly port: number;
  readonly #options: SupervisorOptions;
  readonly #spawn: SpawnLike;
  readonly #fetch: typeof fetch;
  readonly #listeners = new Set<(status: VoicedStatus) => void>();
  #status: VoicedStatus = "stopped";
  #health: VoicedHealth | null = null;
  #child: ChildLike | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #failures = 0;
  #restarts = 0;
  #readySince = 0;
  #stderr = "";

  constructor(options: SupervisorOptions) {
    this.#options = options;
    this.port = options.port ?? VOICED_PORT;
    this.#spawn = options.spawn ?? (nodeSpawn as unknown as SpawnLike);
    this.#fetch = options.fetch ?? fetch;
  }

  get status(): VoicedStatus {
    return this.#status;
  }

  get health(): VoicedHealth | null {
    return this.#health;
  }

  get host(): string {
    return `127.0.0.1:${this.port}`;
  }

  // The last lines voiced wrote to stderr, for a "voice offline" diagnosis.
  get stderrTail(): string {
    return this.#stderr;
  }

  onStatus(listener: (status: VoicedStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    if (this.#status === "stopped") this.#launch();
  }

  whenReady(timeoutMs: number): Promise<boolean> {
    if (this.#status === "ready") return Promise.resolve(true);
    if (this.#status === "stopped") return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(false);
      }, timeoutMs);
      const off = this.onStatus((status) => {
        if (status !== "ready" && status !== "stopped") return;
        clearTimeout(timer);
        off();
        resolve(status === "ready");
      });
    });
  }

  async stop(): Promise<void> {
    this.#set("stopped");
    clearTimeout(this.#timer);
    const child = this.#child;
    this.#child = null;
    if (child && child.exitCode === null) await this.#terminate(child);
  }

  #launch(): void {
    this.#set("starting");
    const [command, ...args] = this.#options.command;
    if (!command) throw new Error("voiced command is empty");
    const child = this.#spawn(command, args, {
      env: this.#childEnv(),
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });
    this.#child = child;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => this.#log(text));
    const gone = () => {
      if (this.#child !== child) return;
      this.#child = null;
      if (this.#status !== "stopped") this.#backoff();
    };
    child.once("exit", gone);
    // A command that cannot run (uv not installed) reports only an error, never an exit.
    child.on("error", (error) => {
      this.#log(`${error.message}\n`);
      if (child.exitCode !== null) gone();
    });
    this.#poll(Date.now());
  }

  #poll(startedAt: number): void {
    const delay = this.#status === "starting" ? STARTUP_POLL_MS : HEALTH_EVERY_MS;
    this.#timer = setTimeout(async () => {
      const health = await this.#check();
      if (this.#status === "stopped" || this.#status === "restarting") return;
      if (health) {
        this.#health = health;
        this.#failures = 0;
        if (this.#status !== "ready") {
          this.#readySince = Date.now();
          this.#set("ready");
        }
      } else if (
        this.#status === "starting"
          ? Date.now() - startedAt > STARTUP_TIMEOUT_MS
          : ++this.#failures >= HEALTH_FAILURES
      ) {
        this.#restart();
        return;
      }
      this.#poll(startedAt);
    }, delay);
  }

  async #check(): Promise<VoicedHealth | null> {
    try {
      const response = await this.#fetch(`http://127.0.0.1:${this.port}/health`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(1000),
      });
      return response.ok ? ((await response.json()) as VoicedHealth) : null;
    } catch {
      return null;
    }
  }

  #restart(): void {
    const child = this.#child;
    if (child && child.exitCode === null) {
      this.#set("restarting");
      void this.#terminate(child);
    } else this.#backoff();
  }

  // SIGTERM first, then SIGKILL if voiced is still there KILL_AFTER_MS later.
  #terminate(child: ChildLike): Promise<void> {
    return new Promise<void>((resolve) => {
      const kill = setTimeout(() => signalGroup(child, "SIGKILL"), KILL_AFTER_MS);
      child.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      signalGroup(child, "SIGTERM");
    });
  }

  #backoff(): void {
    clearTimeout(this.#timer);
    if (this.#readySince && Date.now() - this.#readySince >= STABLE_MS) this.#restarts = 0;
    this.#readySince = 0;
    this.#health = null;
    this.#failures = 0;
    this.#set("restarting");
    const delay = BACKOFF_MS[Math.min(this.#restarts, BACKOFF_MS.length - 1)] ?? 30_000;
    this.#restarts++;
    this.#timer = setTimeout(() => this.#launch(), delay);
  }

  #log(text: string): void {
    this.#stderr = (this.#stderr + text).slice(-2000);
  }

  #childEnv(): NodeJS.ProcessEnv {
    const source = this.#options.env ?? process.env;
    const env: NodeJS.ProcessEnv = {};
    for (const key of PASSED_ENV) if (source[key] !== undefined) env[key] = source[key];
    env.LOCALDOT_VOICED_TOKEN = this.token;
    env.LOCALDOT_VOICED_PORT = String(this.port);
    env.LOCALDOT_VOICED_PARENT_PID = String(process.pid);
    if (this.#options.voiceDir) env.LOCALDOT_VOICE_DIR = this.#options.voiceDir;
    return env;
  }

  #set(status: VoicedStatus): void {
    if (status === this.#status) return;
    this.#status = status;
    for (const listener of this.#listeners) listener(status);
  }
}

// voiced runs in its own process group (detached) under `uv run`, which may not pass a signal on,
// so the signal goes to the whole group; the child alone is the fallback.
function signalGroup(child: ChildLike, name: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined && process.kill(-child.pid, name)) return;
  } catch {
    // The group is already gone.
  }
  child.kill(name);
}
