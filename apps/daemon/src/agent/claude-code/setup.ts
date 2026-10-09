import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import {
  CLAUDE_CODE_INSTALL,
  CLAUDE_CODE_MODEL,
  CLAUDE_CODE_MODELS,
  CLAUDE_CODE_SIGN_IN,
  CLAUDE_CODE_UPDATE,
  ClaudeCodeStatus,
} from "@localdot/protocol";
import { z } from "zod";

// Claude Code takes localDot's prompts verbatim from this version on.
export const MIN_CLAUDE_CODE = "2.1.248";
const CHECK_TTL_MS = 60_000;
const RUN_TIMEOUT_MS = 15_000;

export type ClaudeCodeModel = ClaudeCodeStatus["models"][number];
export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
}
export type Run = (
  file: string,
  args: readonly string[],
  options: { env: Record<string, string>; cwd: string; signal: AbortSignal },
) => Promise<RunResult>;
export interface ClaudeCodeLaunch {
  readonly executable: string;
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly plan?: string;
}
export class ClaudeCodeUnavailable extends Error {
  constructor(readonly status: ClaudeCodeStatus) {
    super(status.reason ?? "Claude Code isn't ready.");
    this.name = "ClaudeCodeUnavailable";
  }
}

// What Claude Code gets from localDot's environment: enough to run as the user, nothing that
// carries a sign-in or an API key, and switches that keep the user's own setup out of dot's work.
const PASSED = ["HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ"];
export const ISOLATION: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_AGENT_SDK_CLIENT_APP: "localdot",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  DISABLE_AUTOUPDATER: "1",
});
export function claudeCodeEnv(
  base: NodeJS.ProcessEnv,
  home: string,
  executable: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED) {
    const value = base[name];
    if (typeof value === "string") env[name] = value;
  }
  env.HOME = home;
  env.PATH = [dirname(executable), base.PATH].filter(Boolean).join(delimiter);
  return { ...env, ...ISOLATION };
}

const SYSTEM_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
// The user's own installation: on the daemon's PATH or where Claude Code's installers put it.
export function findClaudeCode(
  home: string,
  path = process.env.PATH ?? "",
  system: readonly string[] = SYSTEM_DIRS,
): string | undefined {
  const dirs = [
    ...path.split(delimiter),
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    ...system,
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
  ];
  for (const dir of dirs) {
    if (!dir || !isAbsolute(dir)) continue;
    const file = join(dir, "claude");
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      /* Not here. */
    }
  }
  return undefined;
}

export function versionAtLeast(version: string, minimum: string): boolean {
  const a = version.split(".").map(Number),
    b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

const AuthStatus = z.looseObject({
  loggedIn: z.boolean(),
  subscriptionType: z.string().nullish(),
});

export const runFile: Run = (file, args, { env, cwd, signal }) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { env, cwd, signal, timeout: RUN_TIMEOUT_MS, maxBuffer: 256 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") reject(error);
        else resolve({ code: error ? Number((error as { code?: unknown }).code) : 0, stdout });
      },
    );
  });

export interface ClaudeCodeSetupDeps {
  readonly home: string;
  // The empty folder Claude Code runs in, created on demand.
  workDir(): string;
  find(): string | undefined;
  readonly run: Run;
  readonly env: NodeJS.ProcessEnv;
  // The models the user's own Claude Code offers, read without a model call.
  listModels(launch: ClaudeCodeLaunch, signal: AbortSignal): Promise<readonly ClaudeCodeModel[]>;
  readonly now?: () => number;
}

// Checks the user's Claude Code with its own commands only: its version and `claude auth status`.
// localDot never opens Claude Code's credential store, settings or memory files.
export class ClaudeCodeSetup {
  readonly #deps: ClaudeCodeSetupDeps;
  readonly #abort = new AbortController();
  #status: ClaudeCodeStatus | undefined;
  #launch: ClaudeCodeLaunch | undefined;
  // One flight per kind: "Check again" lists the models afresh, and a task start never waits on it.
  readonly #flights = new Map<boolean, Promise<ClaudeCodeStatus>>();
  constructor(deps: ClaudeCodeSetupDeps) {
    this.#deps = deps;
  }
  async status(): Promise<ClaudeCodeStatus> {
    const now = this.#deps.now?.() ?? Date.now();
    if (this.#status?.checkedAt !== undefined && now - this.#status.checkedAt < CHECK_TTL_MS)
      return this.#status;
    return this.check();
  }
  check(): Promise<ClaudeCodeStatus> {
    return this.#run(true);
  }
  // A task asks again, so a sign-out since the last check is noticed before anything starts. Its
  // models were read already; listing them would start Claude Code once more.
  async launch(): Promise<ClaudeCodeLaunch> {
    const status = await this.#run(false);
    if (status.state !== "signed_in" || !this.#launch) throw new ClaudeCodeUnavailable(status);
    return this.#launch;
  }
  close(): void {
    this.#abort.abort();
  }
  #run(listing: boolean): Promise<ClaudeCodeStatus> {
    let flight = this.#flights.get(listing);
    if (!flight) {
      flight = this.#check(listing).finally(() => this.#flights.delete(listing));
      this.#flights.set(listing, flight);
    }
    return flight;
  }
  async #check(listing: boolean): Promise<ClaudeCodeStatus> {
    const known = this.#status?.state === "signed_in" ? this.#status.models : [];
    const checkedAt = this.#deps.now?.() ?? Date.now();
    const result = (
      fields: Omit<ClaudeCodeStatus, "models" | "checkedAt">,
      models: ClaudeCodeModel[] = [],
    ) => {
      const status = ClaudeCodeStatus.parse({ ...fields, models, checkedAt });
      this.#status = status;
      if (status.state !== "signed_in") this.#launch = undefined;
      return status;
    };
    const signal = this.#abort.signal;
    let executable: string | undefined;
    try {
      executable = this.#deps.find();
    } catch {
      executable = undefined;
    }
    if (!executable)
      return result({
        state: "not_installed",
        reason: "Install Claude Code and sign in there.",
        command: CLAUDE_CODE_INSTALL,
      });
    let cwd: string;
    try {
      cwd = this.#deps.workDir();
    } catch {
      return result({
        state: "unavailable",
        reason: "localDot couldn't prepare a folder for Claude Code. Try again.",
      });
    }
    const launch: ClaudeCodeLaunch = {
      executable,
      env: claudeCodeEnv(this.#deps.env, this.#deps.home, executable),
      cwd,
    };
    const run = (args: readonly string[]) =>
      this.#deps.run(executable, args, { env: launch.env, cwd: launch.cwd, signal });
    let version: string | undefined;
    try {
      version = /^(\d{1,4}\.\d{1,4}\.\d{1,6})\b/.exec(
        (await run(["--version"])).stdout.trim(),
      )?.[1];
    } catch {
      version = undefined;
    }
    if (!version)
      return result({
        state: "unavailable",
        reason: "Claude Code didn't answer. Check that it opens in Terminal, then try again.",
        command: "claude --version",
      });
    if (!versionAtLeast(version, MIN_CLAUDE_CODE))
      return result({
        state: "outdated",
        version,
        reason: "Update Claude Code, then check again.",
        command: CLAUDE_CODE_UPDATE,
      });
    let auth: z.infer<typeof AuthStatus> | undefined;
    try {
      const parsed = AuthStatus.safeParse(
        JSON.parse((await run(["auth", "status", "--json"])).stdout),
      );
      auth = parsed.success ? parsed.data : undefined;
    } catch {
      auth = undefined;
    }
    if (!auth?.loggedIn)
      return result({
        state: "signed_out",
        version,
        reason: "Sign in to Claude Code, then check again.",
        command: CLAUDE_CODE_SIGN_IN,
      });
    let models: ClaudeCodeModel[] = listing ? [] : known;
    if (listing || !models.length)
      try {
        models = (await this.#deps.listModels(launch, signal))
          .filter((model) => CLAUDE_CODE_MODEL.test(model.id) && model.name.trim())
          .filter((model, i, all) => all.findIndex((m) => m.id === model.id) === i)
          .slice(0, 32)
          .map((model) => ({ id: model.id, name: model.name.trim().slice(0, 128) }));
      } catch {
        models = [];
      }
    const plan = auth.subscriptionType?.toLowerCase();
    const status = result(
      {
        state: "signed_in",
        version,
        ...(plan && /^[a-z0-9_-]{1,32}$/.test(plan) ? { plan } : {}),
      },
      models.length ? models : [...CLAUDE_CODE_MODELS],
    );
    this.#launch = { ...launch, ...(status.plan ? { plan: status.plan } : {}) };
    return status;
  }
}
