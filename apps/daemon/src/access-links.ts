import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccessAddress, AccessLinksStatus, TailscaleAccess } from "@localdot/protocol";
import { configuredAccessOrigins, registerPublicOrigin } from "./guard.ts";
import { detectHost, type HostPlatform } from "./platform/host.ts";

type Platform = Pick<HostPlatform, "os" | "wsl">;
const WINDOWS_TAILSCALE = "/mnt/c/Program Files/Tailscale/tailscale.exe";
const TAILNET_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net(?::\d{1,5})?$/i;
const READ_MS = 10_000;
const ENABLE_MS = 90_000;
const SERVE_MS = 20_000;
const FRESH_MS = 5_000;
const RECHECK_MS = 15_000;
const OUTPUT_LIMIT = 256 * 1024;

export function servedOrigins(status: unknown, serve: unknown, port: number): string[] {
  const s = status as { BackendState?: string; Self?: { DNSName?: string } };
  const config = serve as {
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
    TCP?: Record<string, { HTTPS?: boolean }>;
    AllowFunnel?: Record<string, boolean>;
  };
  const name = s?.Self?.DNSName?.replace(/\.$/, "");
  if (s?.BackendState !== "Running" || !name || !/^[a-z0-9.-]+\.ts\.net$/.test(name)) return [];
  return Object.entries(config?.Web ?? {}).flatMap(([host, web]) => {
    const url = new URL(`https://${host}`);
    const target = web.Handlers?.["/"]?.Proxy;
    return url.hostname === name &&
      config.TCP?.[url.port || "443"]?.HTTPS === true &&
      !config.AllowFunnel?.[host] &&
      [`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(target ?? "")
      ? [url.origin]
      : [];
  });
}

// Where each platform installs Tailscale's command line. A service starts with a short PATH,
// without Homebrew's folders, so these come before a PATH lookup.
export function tailscaleCommands(host: Platform, home = homedir()): string[] {
  if (host.os === "macos")
    return [
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      join(home, "Applications/Tailscale.app/Contents/MacOS/Tailscale"),
      "/opt/homebrew/bin/tailscale",
      "/usr/local/bin/tailscale",
    ];
  const linux = [
    "/usr/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/usr/sbin/tailscale",
    "/snap/bin/tailscale",
  ];
  // On Windows, localDot runs in WSL. The Windows app's Serve reaches this port through WSL's
  // localhost forwarding.
  return host.wsl ? [WINDOWS_TAILSCALE, ...linux] : linux;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  // Why it never ran: ENOENT, ENOEXEC, EACCES…
  error?: string;
  timedOut?: boolean;
}

function run(
  command: string,
  args: readonly string[],
  ms: number,
  onOutput?: (output: string) => void,
): { done: Promise<CommandResult>; stop(): void } {
  const result: CommandResult = { code: null, stdout: "", stderr: "" };
  let settle!: (value: CommandResult) => void;
  const done = new Promise<CommandResult>((resolve) => {
    settle = resolve;
  });
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const take = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
    if (result[stream].length < OUTPUT_LIMIT) result[stream] += chunk.toString("utf8");
    onOutput?.(`${result.stdout}\n${result.stderr}`);
  };
  child.stdout.on("data", take("stdout"));
  child.stderr.on("data", take("stderr"));
  // Settled at the deadline even when the command ignores the signal or something holds its pipes.
  const timer = setTimeout(() => {
    result.timedOut = true;
    child.kill("SIGKILL");
    settle(result);
  }, ms);
  child.once("error", (error: NodeJS.ErrnoException) => {
    clearTimeout(timer);
    result.error = error.code ?? "failed";
    settle(result);
  });
  child.once("close", (code) => {
    clearTimeout(timer);
    result.code = code;
    settle(result);
  });
  return {
    done,
    stop: () => {
      clearTimeout(timer);
      child.kill("SIGKILL");
    },
  };
}

// How to name the Tailscale that answers and how to get it going again, in the words of its app.
export interface Place {
  name: string;
  open: string;
  restart: string;
  connect: string;
  signIn: string;
  // tailscaled on Linux changes Serve only for root and its operator.
  operator: boolean;
}

export function placeOf(command: string, host: Platform): Place {
  if (command.endsWith(".exe"))
    return {
      name: "Windows",
      open: "Open Tailscale from the Start menu",
      restart: "Open Tailscale, or quit it and open it again",
      connect: "Open Tailscale and connect",
      signIn: "Open Tailscale and sign in",
      operator: false,
    };
  if (host.os === "macos")
    return {
      name: "this Mac",
      open: "Open the Tailscale app",
      restart: "Open the Tailscale app, or quit it and open it again",
      connect: "Open Tailscale and connect",
      signIn: "Open Tailscale and sign in",
      operator: false,
    };
  return {
    name: "this computer",
    open: "Start it with sudo systemctl start tailscaled",
    restart: "Restart it with sudo systemctl restart tailscaled",
    connect: "Connect with sudo tailscale up",
    signIn: "Sign in with sudo tailscale up",
    operator: process.getuid?.() !== 0,
  };
}

function notInstalled(host: Platform): TailscaleAccess {
  const where = host.os === "macos" ? "this Mac" : host.wsl ? "Windows" : "this computer";
  return {
    state: "not-installed",
    message: `Tailscale isn't installed on ${where}. Install it and sign in to use it here.`,
  };
}

const unavailable = (
  reason: NonNullable<TailscaleAccess["reason"]>,
  message: string,
): TailscaleAccess => ({ state: "unavailable", reason, message });

// The first line of what a command printed, short and without control characters.
function firstLine(result: CommandResult): string {
  const line =
    `${result.stderr}\n${result.stdout}`
      .split("\n")
      .map((text) =>
        text
          .replace(/\p{Cc}/gu, "")
          .trim()
          .replace(/[.:;,]+$/, ""),
      )
      .find(Boolean) ?? `exit ${result.code}`;
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

// What a `tailscale` command that gave no usable answer says about Tailscale here.
export function failedCommand(
  result: CommandResult,
  place: Place,
  host: Platform,
  ms = READ_MS,
): TailscaleAccess {
  if (result.error === "ENOENT") return notInstalled(host);
  if (result.timedOut)
    return unavailable(
      "no-answer",
      `Tailscale on ${place.name} didn't answer within ${Math.round(ms / 1000)} seconds. ${place.restart}, then check again.`,
    );
  if (result.error === "ENOEXEC" && place.name === "Windows")
    return unavailable(
      "no-answer",
      "Windows programs can't start from WSL here, so localDot can't reach Tailscale. Turn WSL interop back on, restart WSL, then check again.",
    );
  if (result.error)
    return unavailable("no-answer", `Tailscale on ${place.name} couldn't start (${result.error}).`);
  // How Tailscale's command line says Tailscale isn't running, on each platform. One that runs
  // but won't take the connection names its process instead.
  if (
    /failed to connect to local (?:tailscale service|tailscaled)/i.test(result.stderr) &&
    !/appears to be running as/i.test(result.stderr)
  )
    return {
      state: "not-running",
      message: `Tailscale is installed but not running. ${place.open}, then check again.`,
    };
  return unavailable(
    "no-answer",
    `Tailscale on ${place.name} reported a problem: ${firstLine(result)}. ${place.restart}, then check again.`,
  );
}

export interface TailscaleStatus {
  BackendState?: string;
  Self?: { DNSName?: string; KeyExpiry?: string };
}

// Why Tailscale can't serve yet, or nothing when it is connected.
export function backendProblem(
  status: TailscaleStatus,
  place: Place,
  now = Date.now(),
): TailscaleAccess | undefined {
  switch (status.BackendState) {
    case "Running":
      return undefined;
    case "NeedsLogin": {
      const expiry = Date.parse(status.Self?.KeyExpiry ?? "");
      return {
        state: "needs-login",
        message:
          expiry > 0 && expiry < now
            ? `Tailscale's sign-in on ${place.name} has expired. ${place.signIn}, then check again.`
            : `Tailscale is signed out. ${place.signIn}, then check again.`,
      };
    }
    case "NeedsMachineAuth":
      return {
        state: "needs-login",
        message:
          "This computer is waiting for approval in your Tailscale admin console. Approve it there, then check again.",
      };
    case "Stopped":
      return {
        state: "not-running",
        message: `Tailscale is off. ${place.connect}, then check again.`,
      };
    case "Starting":
    case "NoState":
      return {
        state: "not-running",
        message: "Tailscale is still starting. Check again in a moment.",
      };
    case "InUseOtherUser":
      return unavailable(
        "other-user",
        "Tailscale is in use by another Windows account on this PC. Use it from this account, then check again.",
      );
    default:
      return unavailable(
        "failed",
        `Tailscale isn't ready (${status.BackendState ?? "no state"}). Check again in a moment.`,
      );
  }
}

// What connected Tailscale offers localDot: its address, served or ready to be.
export function serveState(status: TailscaleStatus, serve: unknown, port: number): TailscaleAccess {
  const name = status.Self?.DNSName?.replace(/\.$/, "");
  if (!name || !/^[a-z0-9.-]+\.ts\.net$/.test(name))
    return unavailable(
      "no-name",
      "Tailscale hasn't given this computer a ts.net name. Turn on MagicDNS in the Tailscale admin console, then check again.",
    );
  const served = servedOrigins(status, serve, port)[0];
  if (served)
    return {
      state: "served",
      origin: served,
      message: "Copy a link and open it on any device signed in to your Tailscale network.",
    };
  const config = serve as { TCP?: Record<string, unknown>; AllowFunnel?: Record<string, boolean> };
  if (config?.AllowFunnel?.[`${name}:${port}`])
    return unavailable(
      "funnel",
      `Tailscale Funnel puts port ${port} on the public internet, so localDot won't use it. Turn Funnel off with tailscale funnel --https=${port} off, then check again.`,
    );
  if (config?.TCP?.[String(port)])
    return unavailable(
      "port-taken",
      `Tailscale already shares something else on port ${port}. Free it with tailscale serve --https=${port} off, then check again.`,
    );
  return {
    state: "ready-to-enable",
    origin: port === 443 ? `https://${name}` : `https://${name}:${port}`,
    message:
      "Turn on to open localDot from your devices signed in to Tailscale. No one else can reach it.",
  };
}

// Tailscale's page for allowing HTTPS, printed on a line of its own. The address a finished Serve
// prints is on the tailnet, never this page.
export function approvalUrl(output: string): string | undefined {
  for (const [, text] of output.matchAll(/^\s*(https:\/\/\S+)\s*$/gm)) {
    if (!text || !URL.canParse(text)) continue;
    const url = new URL(text);
    if (!url.hostname.endsWith(".ts.net")) return url.href;
  }
  return undefined;
}

// Why `tailscale serve` stopped before localDot was served.
export function enableProblem(
  result: CommandResult,
  place: Place,
  host: Platform,
  approval: string | undefined,
  ms = ENABLE_MS,
): TailscaleAccess {
  const denied = /access denied|serve config denied|--operator=/i.test(
    `${result.stderr}\n${result.stdout}`,
  );
  if (approval && !denied && !result.error)
    return {
      state: "ready-to-enable",
      approvalUrl: approval,
      message: result.timedOut
        ? "HTTPS wasn't allowed in time. Allow it in Tailscale, then turn on again."
        : "Allow HTTPS for this computer in Tailscale, then turn on again.",
    };
  if (result.timedOut || result.error) return failedCommand(result, place, host, ms);
  if (denied)
    return place.operator
      ? {
          ...unavailable(
            "permission",
            "Tailscale needs your permission before localDot can share through it. Run this once in a terminal, then turn on again.",
          ),
          operatorHint: "sudo tailscale set --operator=$USER",
        }
      : unavailable("permission", `Tailscale refused to share localDot: ${firstLine(result)}.`);
  return unavailable(
    "failed",
    `Tailscale couldn't turn on HTTPS for localDot: ${firstLine(result)}.`,
  );
}

function json<T>(result: CommandResult): T | undefined {
  if (result.code !== 0) return undefined;
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    return undefined;
  }
}

export function accessAddresses(port: number, tailscale?: string): AccessAddress[] {
  return [
    { origin: `http://localhost:${port}`, label: "This computer" },
    ...configuredAccessOrigins()
      .filter((origin) => origin !== tailscale)
      .map((origin) => ({
        origin,
        label: new URL(origin).hostname.endsWith(".ts.net") ? "Tailscale" : "Remote address",
      })),
  ];
}

export interface AccessLinksOptions {
  // The Tailscale command lines to try instead of the platform's usual places.
  commands?: readonly string[];
  host?: Platform;
  readMs?: number;
  enableMs?: number;
}

interface Enabling {
  approvalUrl?: string;
  first: Promise<AccessLinksStatus>;
  stop(): void;
}

export class AccessLinks {
  private cached?: { at: number; value: AccessLinksStatus };
  private pending?: Promise<AccessLinksStatus>;
  private enabling?: Enabling;
  // Why the last attempt to turn Serve on didn't finish, while Tailscale is otherwise ready.
  private problem?: TailscaleAccess;
  // The command line of the Tailscale that answered as connected.
  private command?: string;
  private saved?: { origin: string; unregister(): void };
  private recheckedAt = 0;
  private rechecking?: Promise<void>;
  private closed = false;
  private readonly file: string;
  private readonly host: Platform;

  constructor(
    private port: number,
    home: string,
    private options: AccessLinksOptions = {},
  ) {
    this.file = join(home, "tailscale-serve.json");
    this.host = options.host ?? detectHost();
    // Tailnet devices pass the host guard from the start, before Tailscale has answered.
    try {
      const { origin } = JSON.parse(readFileSync(this.file, "utf8")) as { origin?: unknown };
      if (typeof origin === "string") this.register(origin);
    } catch {}
  }

  async read(fresh = false): Promise<AccessLinksStatus> {
    const approval = this.enabling?.approvalUrl;
    if (approval) return this.status(this.awaitingApproval(approval));
    if (!fresh && this.cached && Date.now() - this.cached.at < FRESH_MS) return this.cached.value;
    this.pending ??= this.discover().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  // A tailnet name the host guard doesn't know may be a Serve address set up since the last look,
  // or while localDot was starting, so look again (at most every 15 s) before refusing it.
  recheck(host: string | undefined): Promise<void> {
    if (!host || !TAILNET_HOST.test(host)) return Promise.resolve();
    if (this.rechecking) return this.rechecking;
    if (Date.now() - this.recheckedAt < RECHECK_MS) return Promise.resolve();
    this.recheckedAt = Date.now();
    this.rechecking = this.read(true)
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.rechecking = undefined;
      });
    return this.rechecking;
  }

  // Answers as soon as Tailscale prints its page for allowing HTTPS, and keeps waiting for that.
  async enableTailscale(): Promise<AccessLinksStatus> {
    if (this.enabling) return this.enabling.first;
    let answer!: (value: AccessLinksStatus) => void;
    const enabling: Enabling = {
      first: new Promise((resolve) => {
        answer = resolve;
      }),
      stop: () => {},
    };
    this.enabling = enabling;
    const current = await this.read(true);
    const { state, reason, origin } = current.tailscale;
    const command = this.command;
    if (!command || !(state === "ready-to-enable" || reason === "permission")) {
      this.enabling = undefined;
      answer(current);
      return current;
    }
    const place = placeOf(command, this.host);
    this.problem = undefined;
    const ms = this.options.enableMs ?? ENABLE_MS;
    const job = run(
      command,
      ["serve", "--bg", `--https=${this.port}`, `http://127.0.0.1:${this.port}`],
      ms,
      (output) => {
        const url = enabling.approvalUrl ? undefined : approvalUrl(output);
        if (!url) return;
        enabling.approvalUrl = url;
        answer(this.status(this.awaitingApproval(url, origin)));
      },
    );
    enabling.stop = job.stop;
    void job.done.then(async (result) => {
      this.enabling = undefined;
      if (this.closed) return;
      this.problem =
        result.code === 0
          ? undefined
          : enableProblem(result, place, this.host, enabling.approvalUrl, ms);
      const settled = await this.read(true);
      if (result.code !== 0 || settled.tailscale.state !== "ready-to-enable") {
        answer(settled);
        return;
      }
      // Serve said it was on but isn't listed yet: one more look before saying so.
      this.problem = unavailable(
        "failed",
        "Tailscale finished without sharing localDot. Check again in a moment.",
      );
      answer(await this.read(true));
    });
    return enabling.first;
  }

  // Runs the Tailscale that answered as connected, for the Serve entries previews add and remove
  // for the ports they hold.
  async runTailscale(args: readonly string[]): Promise<CommandResult | undefined> {
    if (!this.command) await this.read(true).catch(() => undefined);
    const command = this.command;
    return command && !this.closed ? run(command, args, SERVE_MS).done : undefined;
  }

  close(): void {
    this.closed = true;
    this.enabling?.stop();
    this.saved?.unregister();
    this.saved = undefined;
  }

  private awaitingApproval(
    approvalUrl: string,
    origin = this.cached?.value.tailscale.origin,
  ): TailscaleAccess {
    return {
      state: "needs-approval",
      ...(origin ? { origin } : {}),
      approvalUrl,
      message: "Allow HTTPS for this computer in Tailscale. localDot turns on as soon as you do.",
    };
  }

  private status(tailscale: TailscaleAccess): AccessLinksStatus {
    return { links: accessAddresses(this.port, tailscale.origin), tailscale };
  }

  private async discover(): Promise<AccessLinksStatus> {
    const found = await this.tailscale();
    if (found.state !== "ready-to-enable") this.problem = undefined;
    const value = this.status(this.problem ? { ...found, ...this.problem } : found);
    this.cached = { at: Date.now(), value };
    return value;
  }

  // The first Tailscale that answers as connected; otherwise what the first one says.
  private async tailscale(): Promise<TailscaleAccess> {
    const readMs = this.options.readMs ?? READ_MS;
    const installed = tailscaleCommands(this.host).filter((path) => existsSync(path));
    const commands = this.options.commands ?? (installed.length ? installed : ["tailscale"]);
    let first: TailscaleAccess | undefined;
    for (const command of commands) {
      const place = placeOf(command, this.host);
      const read = await run(command, ["status", "--json", "--peers=false"], readMs).done;
      const status = json<TailscaleStatus>(read);
      const problem = status
        ? backendProblem(status, place)
        : failedCommand(read, place, this.host, readMs);
      if (!problem && status) {
        this.command = command;
        const listing = await run(command, ["serve", "status", "--json"], readMs).done;
        const serve = json<unknown>(listing);
        if (serve === undefined) return failedCommand(listing, place, this.host, readMs);
        const access = serveState(status, serve, this.port);
        if (access.state === "served" && access.origin) this.remember(access.origin);
        else this.forget();
        return access;
      }
      first ??= problem;
    }
    this.command = undefined;
    return first ?? notInstalled(this.host);
  }

  private register(origin: string): boolean {
    if (this.saved?.origin === origin) return false;
    if (!/^https:\/\/[a-z0-9.-]+\.ts\.net(?::\d{1,5})?$/.test(origin)) return false;
    try {
      const unregister = registerPublicOrigin(origin);
      this.saved?.unregister();
      this.saved = { origin, unregister };
      return true;
    } catch {
      return false;
    }
  }

  private remember(origin: string): void {
    if (!this.register(origin)) return;
    const temp = `${this.file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify({ origin })}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temp, this.file);
    } catch {
      // Registered for this run; the next start finds it through Tailscale again.
    } finally {
      rmSync(temp, { force: true });
    }
  }

  private forget(): void {
    this.saved?.unregister();
    this.saved = undefined;
    rmSync(this.file, { force: true });
  }
}
