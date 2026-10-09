import {
  type AcceptanceHost,
  accountStamped,
  CODEX_VERSION,
  type CodexInstaller,
  codexAccepted,
  codexReleased,
  type InstalledCodex,
  type LocalAcceptance,
  NativeCheckError,
  nativeStamped,
  stampAccount,
  stampNative,
} from "@localdot/codex-harness";
import type { ChatgptSandbox } from "@localdot/protocol";
import type { ChatgptStatus } from "./account.ts";

export const SANDBOX_REASONS: Record<Exclude<ChatgptSandbox, "passed">, string> = {
  unchecked: "ChatGPT support needs a quick safety check on this Mac.",
  checking: "Checking that ChatGPT support runs safely on this Mac…",
  failed: "ChatGPT support didn't pass its safety check on this Mac, so it stays off.",
};
export const SETUP_UNSAVED = "ChatGPT setup couldn't be saved on this Mac.";

export interface ChatgptSetupDeps {
  readonly installer: Pick<CodexInstaller, "status" | "verifiedInstallation">;
  // This Mac's macOS build and sandbox runtime; throws when either can't be read.
  host(): AcceptanceHost;
  check(
    installed: InstalledCodex,
    signal: AbortSignal,
  ): Promise<{ readonly host: AcceptanceHost; readonly reportSha256: string }>;
  read(): LocalAcceptance | undefined;
  write(record: LocalAcceptance): Promise<void>;
  readonly now?: () => number;
}
export interface ChatgptSetupControl {
  sandbox(): ChatgptSandbox;
  check(): Promise<ChatgptSandbox>;
  confirm(status: ChatgptStatus): Promise<ChatgptStatus>;
}

// Install, then this Mac's sandbox check, then the user's first verified sign-in. Each step is
// recorded beside the Codex folders; a missing, stale or unreadable record keeps the plan off.
export class ChatgptSetup implements ChatgptSetupControl {
  readonly #deps: ChatgptSetupDeps;
  readonly #abort = new AbortController();
  #record: LocalAcceptance | undefined;
  #host: AcceptanceHost | undefined;
  #state: ChatgptSandbox;
  #flight: Promise<ChatgptSandbox> | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(deps: ChatgptSetupDeps) {
    this.#deps = deps;
    this.#record = deps.read();
    try {
      this.#host = deps.host();
    } catch {
      this.#host = undefined;
    }
    this.#state = this.#host && nativeStamped(this.#record, this.#host) ? "passed" : "unchecked";
  }
  sandbox(): ChatgptSandbox {
    return this.#state;
  }
  reason(): string | undefined {
    return this.#state === "passed" ? undefined : SANDBOX_REASONS[this.#state];
  }
  ready(): boolean {
    return (
      this.#state === "passed" &&
      this.#host !== undefined &&
      codexAccepted(this.#record, this.#host)
    );
  }
  // Without release evidence for this pin there is nothing for this Mac to check against.
  check(): Promise<ChatgptSandbox> {
    if (this.#flight) return this.#flight;
    if (
      this.#state === "passed" ||
      this.#abort.signal.aborted ||
      !codexReleased() ||
      this.#deps.installer.status().state !== "ready"
    )
      return Promise.resolve(this.#state);
    this.#state = "checking";
    const flight = this.#serial(() => this.#run()).finally(() => {
      if (this.#flight === flight) this.#flight = undefined;
    });
    this.#flight = flight;
    return flight;
  }
  async #run(): Promise<ChatgptSandbox> {
    const signal = this.#abort.signal;
    try {
      const installed = await this.#deps.installer.verifiedInstallation(signal);
      if (!installed) {
        this.#state = "unchecked";
        return this.#state;
      }
      const { host, reportSha256 } = await this.#deps.check(installed, signal);
      const expected = this.#deps.host();
      if (host.system !== expected.system || host.runtime !== expected.runtime)
        throw new NativeCheckError("host");
      signal.throwIfAborted();
      await this.#deps.write(stampNative(this.#record, host, reportSha256, this.#now()));
      this.#record = this.#deps.read();
      this.#host = host;
      this.#state = nativeStamped(this.#record, host) ? "passed" : "failed";
    } catch (error) {
      this.#state = signal.aborted ? "unchecked" : "failed";
      if (!signal.aborted)
        console.error(
          error instanceof NativeCheckError && error.probe
            ? `ChatGPT safety check failed at: ${error.probe}`
            : "ChatGPT safety check failed.",
        );
    }
    return this.#state;
  }
  // A signed-in account read through the sandboxed Codex is the user's account stamp.
  async confirm(status: ChatgptStatus): Promise<ChatgptStatus> {
    if (status.state !== "signed_in" || !status.account || accountStamped(this.#record))
      return status;
    try {
      await this.#serial(async () => {
        const host = this.#host;
        if (this.#state !== "passed" || !host) throw new Error("unchecked");
        await this.#deps.write(stampAccount(this.#record, host, this.#now()));
        this.#record = this.#deps.read();
      });
      if (!accountStamped(this.#record)) throw new Error("unsaved");
      return status;
    } catch {
      return {
        available: false,
        codexVersion: CODEX_VERSION,
        state: "unavailable",
        reason: SETUP_UNSAVED,
      };
    }
  }
  async close(): Promise<void> {
    this.#abort.abort();
    await this.#flight?.catch(() => {});
  }
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work, work);
    this.#tail = next.catch(() => {});
    return next;
  }
  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }
}
