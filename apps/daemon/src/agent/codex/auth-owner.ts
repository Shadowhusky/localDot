import {
  AccountRead,
  CHATGPT_INSTALL_FIRST,
  CHATGPT_NEEDS_APPLE_SILICON,
  type ClientMethod,
  CODEX_VERSION,
  type CodexConnection,
  type CodexInstaller,
  CodexLaunchError,
  createCodexInstaller,
  harnessAvailability,
  type LaunchInput,
  LoginCompleted,
  LoginStarted,
  launchCodex,
  ModelList,
  NO_CA_BUNDLE,
  type OwnedCodexRoots,
  platformUnavailable,
  RateLimitsRead,
  type RpcRequestOptions,
} from "@localdot/codex-harness";
import { CHATGPT_DEVICE_CODE_OFF, ULID_PATTERN } from "@localdot/protocol";
import type { AgentSession } from "../session.ts";
import {
  AccountError,
  accountFor,
  type ChatgptLogin,
  type ChatgptStatus,
  loginFor,
  modelsFor,
  TASK_BUSY,
} from "./account.ts";
import type { CodexDriverLease, TaskLaunch } from "./driver.ts";
import { subscriptionUsage } from "./usage.ts";

const BUSY = "The ChatGPT account is busy.";
const RETIRE_FAILED = "Account process could not be stopped.";
const SUPERSEDED = "The ChatGPT account operation was superseded.";
const BROWSER_GATE = "Browser sign-in is awaiting its bounded native callback check.";
const opaque = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid account response.");
  return value as Record<string, unknown>;
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function readonlyAwait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      action();
    };
    const abort = () => finish(() => reject(new AccountError(409, SUPERSEDED)));
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (cause) => finish(() => reject(cause)),
    );
    if (signal.aborted) abort();
  });
}
interface Mutation {
  kind: "login" | "logout" | "refresh" | "cancel" | "completion";
  generation: number;
  retiring: Promise<void>;
  pauseFailed?: boolean;
}
interface Entry {
  kind: "task" | "account" | "login";
  generation: number;
  abort: AbortController;
  signal: AbortSignal;
  valid: boolean;
  launched: boolean;
  holders: Set<CodexConnection>;
  stops: Map<CodexConnection, Promise<void>>;
  startup: Promise<void>;
  release?: Promise<void>;
  detach(): void;
  readonly extraDenyRead: readonly string[];
}
interface Attempt {
  nonce: number;
  generation: number;
  entry: Entry;
  startedAt: number;
  login?: ChatgptLogin;
  early?: { loginId: string; success: boolean; cancelled: boolean };
  timer?: ReturnType<typeof setTimeout>;
}
export interface CodexAuthOwnerDeps {
  readonly roots: OwnedCodexRoots;
  readonly extraDenyRead?: readonly string[];
  // Trusted daemon settings snapshot for this task, never model-provided paths.
  readonly taskDenyRead?: (sessionId: string) => readonly string[];
  // All ChatGPT sessions, including paused/idle ones. This is a notification target, not a lock.
  readonly sessions: () => readonly AgentSession[];
  // Trusted synchronous runner admission state; independent of event-log/UI publication.
  readonly pauseForAuth?: (session: AgentSession, generation: number) => void;
  // Why no Codex process may start yet: this Mac's sandbox check hasn't passed.
  readonly sandboxReason?: () => string | undefined;
  readonly now?: () => number;
  readonly statusTtlMs?: number;
  readonly loginTimeoutMs?: number;
}
// The only production caller of raw launchCodex. Metadata/cache never authorizes a binary;
// the fixed launcher independently verifies the pinned installation before each owned spawn.
export class CodexAuthOwner {
  readonly installer: CodexInstaller;
  readonly #deps: CodexAuthOwnerDeps;
  readonly #entries = new Set<Entry>();
  #reservation: Entry | undefined;
  #generation = 1;
  #nonce = 0;
  #attempt: Attempt | undefined;
  #mutation: Mutation | undefined;
  #cache: ChatgptStatus | undefined;
  #expired = false;
  #blocked = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #tail: Promise<void> = Promise.resolve();
  constructor(deps: CodexAuthOwnerDeps) {
    for (const n of [deps.statusTtlMs ?? 30000, deps.loginTimeoutMs ?? 600000])
      if (!Number.isFinite(n) || n <= 0) throw new Error("Invalid account deadline.");
    this.#deps = Object.freeze({
      ...deps,
      ...(deps.extraDenyRead ? { extraDenyRead: Object.freeze([...deps.extraDenyRead]) } : {}),
    });
    this.installer = createCodexInstaller({ roots: deps.roots });
  }
  get authGeneration(): number {
    return this.#generation;
  }
  // Private readiness only: safety Resume must not start an account or usage polling process.
  canResume(generation: number): boolean {
    return (
      generation === this.#generation &&
      !this.#closed &&
      !this.#blocked &&
      !this.#expired &&
      !this.#mutation &&
      !this.#attempt &&
      !this.#reservation &&
      this.#cache?.state === "signed_in" &&
      this.#reason() === undefined
    );
  }
  #now(): number {
    const n = (this.#deps.now ?? Date.now)();
    if (!Number.isFinite(n) || n < 0) throw new Error("Invalid account clock.");
    return n;
  }
  #base(): ChatgptStatus {
    return {
      available: true,
      codexVersion: CODEX_VERSION,
      state: this.#expired ? "expired" : "signed_out",
    };
  }
  #unavailable(reason: string): ChatgptStatus {
    return { available: false, codexVersion: CODEX_VERSION, state: "unavailable", reason };
  }
  #reason(): string | undefined {
    if (this.#blocked) return RETIRE_FAILED;
    if (this.#closed) return "The ChatGPT account service is closed.";
    const available = harnessAvailability();
    // Only reasons the harness owns are shown; anything else reads as this platform's own.
    if (!available.available)
      return available.reason === NO_CA_BUNDLE
        ? available.reason
        : (platformUnavailable() ?? CHATGPT_NEEDS_APPLE_SILICON);
    if (this.installer.status().state !== "ready") return CHATGPT_INSTALL_FIRST;
    return this.#deps.sandboxReason?.();
  }
  #usable(): void {
    const reason = this.#reason();
    if (reason) throw new AccountError(503, reason);
  }
  #serial<T>(run: () => Promise<T>): Promise<T> {
    const work = this.#tail.then(run, run);
    this.#tail = work.then(
      () => {},
      () => {},
    );
    return work;
  }
  #checkGeneration(generation: number, mutation?: Mutation): void {
    this.#usable();
    if (generation !== this.#generation || this.#mutation !== mutation)
      throw new AccountError(409, SUPERSEDED);
  }
  #current(entry: Entry): boolean {
    return (
      entry.valid &&
      !entry.signal.aborted &&
      !this.#closed &&
      !this.#blocked &&
      entry.generation === this.#generation &&
      this.#reservation === entry
    );
  }
  #reserve(
    kind: Entry["kind"],
    signal: AbortSignal,
    generation = this.#generation,
    mutation?: Mutation,
    taskDenyRead: readonly string[] = [],
  ): Entry {
    this.#checkGeneration(generation, mutation);
    signal.throwIfAborted();
    if (this.#attempt && kind !== "login")
      throw new AccountError(409, "Finish or cancel the ChatGPT sign-in first.");
    if (this.#entries.size || this.#reservation)
      throw new AccountError(409, this.#reservation?.kind === "task" ? TASK_BUSY : BUSY);
    const abort = new AbortController(),
      combined = AbortSignal.any([signal, abort.signal]);
    const entry: Entry = {
      kind,
      generation,
      abort,
      signal: combined,
      valid: true,
      launched: false,
      holders: new Set(),
      stops: new Map(),
      startup: Promise.resolve(),
      detach: () => signal.removeEventListener("abort", canceled),
      extraDenyRead: Object.freeze([...(this.#deps.extraDenyRead ?? []), ...taskDenyRead]),
    };
    const canceled = () => {
      void this.#retire(entry).catch(() => {});
    };
    this.#reservation = entry;
    this.#entries.add(entry);
    signal.addEventListener("abort", canceled, { once: true });
    if (signal.aborted) canceled();
    return entry;
  }
  #stop(entry: Entry, holder: CodexConnection): void {
    if (entry.stops.has(holder)) return;
    const stopped = deferred<void>();
    entry.stops.set(holder, stopped.promise);
    try {
      Promise.all([holder.stop(), holder.closed]).then(() => stopped.resolve(), stopped.reject);
    } catch {
      stopped.reject(new AccountError(503, RETIRE_FAILED));
    }
  }
  #retire(entry: Entry): Promise<void> {
    if (entry.release) return entry.release;
    const released = deferred<void>();
    entry.release = released.promise;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.#blocked = true;
      this.#cache = this.#unavailable(RETIRE_FAILED);
      released.reject(new AccountError(503, RETIRE_FAILED));
    };
    const timer = setTimeout(fail, 2000);
    timer.unref();
    entry.valid = false;
    entry.abort.abort();
    for (const holder of entry.holders) this.#stop(entry, holder);
    const cleanup = entry.startup.then(async () => {
      for (const holder of entry.holders) this.#stop(entry, holder);
      await Promise.all(entry.stops.values());
    });
    cleanup.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      entry.detach();
      this.#entries.delete(entry);
      if (this.#reservation === entry) this.#reservation = undefined;
      released.resolve();
    }, fail);
    return released.promise;
  }
  async #launch(
    entry: Entry,
    purpose: "task" | "account" | "login-browser",
    task?: TaskLaunch,
    notify?: LaunchInput["onNotification"],
  ): Promise<CodexConnection> {
    if (!this.#current(entry) || entry.launched) throw new AccountError(409, SUPERSEDED);
    entry.launched = true;
    const startup = deferred<void>();
    entry.startup = startup.promise;
    const current = () =>
      this.#current(entry) && (!task || (!task.signal.aborted && task.isCurrent()));
    const register = (holder: CodexConnection) => {
      entry.holders.add(holder);
      task?.onRegister(holder);
      if (!current()) this.#stop(entry, holder);
    };
    try {
      const conn = await launchCodex(
        { roots: this.#deps.roots, extraDenyRead: entry.extraDenyRead },
        {
          purpose,
          ...(task
            ? {
                sessionId: task.sessionId,
                mcp: task.endpoint.directory,
                retireBridge: task.endpoint.close.bind(task.endpoint),
                approvalContext: task.approvalContext,
                onBlocked: task.onBlocked,
                interruptTurn: task.interruptTurn,
              }
            : {}),
          signal: task ? AbortSignal.any([entry.signal, task.signal]) : entry.signal,
          owner: { register, isCurrent: current },
          onFence: () => {
            const waitingAttempt =
              this.#attempt?.entry === entry && this.#attempt.login ? this.#attempt : undefined;
            entry.valid = false;
            if (task) task.onFence();
            else if (waitingAttempt)
              this.#settleAttempt(waitingAttempt, "The ChatGPT sign-in connection ended.", true);
            else void this.#retire(entry).catch(() => {});
          },
          onNotification: (method, params, context) => {
            if (current() && !context.signal.aborted)
              (task?.onNotification ?? notify)?.(method, params, context);
          },
          onFailure: (cause) => {
            try {
              task?.onFailure(cause);
            } finally {
              void this.#retire(entry).catch(() => {});
            }
          },
        },
      );
      if (!entry.holders.has(conn)) register(conn);
      if (!current()) {
        this.#stop(entry, conn);
        throw new AccountError(409, SUPERSEDED);
      }
      return conn;
    } finally {
      startup.resolve();
    }
  }
  async #request<T>(
    entry: Entry,
    conn: CodexConnection,
    method: ClientMethod,
    params: unknown,
    validateResult: RpcRequestOptions<T>["validateResult"],
  ): Promise<T> {
    if (!this.#current(entry)) throw new AccountError(409, SUPERSEDED);
    const signal = AbortSignal.any([entry.signal, AbortSignal.timeout(10000)]);
    const value = await readonlyAwait(
      conn.rpc.request(method, params, { signal, timeoutMs: 10000, validateResult }),
      signal,
    );
    if (!this.#current(entry)) throw new AccountError(409, SUPERSEDED);
    return value;
  }
  async #initialize(entry: Entry, conn: CodexConnection): Promise<void> {
    await this.#request(
      entry,
      conn,
      "initialize",
      { clientInfo: { name: "localdot", title: "localDot", version: "0.0.0" } },
      opaque,
    );
    if (!this.#current(entry)) throw new AccountError(409, SUPERSEDED);
    conn.rpc.notify("initialized", {});
  }
  acquireTask(sessionId: string, signal: AbortSignal): Promise<CodexDriverLease> {
    return this.#serial(async () => {
      if (!ULID_PATTERN.test(sessionId))
        throw new AccountError(409, "The ChatGPT task is invalid.");
      const entry = this.#reserve(
        "task",
        signal,
        this.#generation,
        undefined,
        this.#deps.taskDenyRead?.(sessionId),
      );
      return Object.freeze({
        generation: entry.generation,
        signal: entry.signal,
        launch: (input: TaskLaunch) => {
          if (input.sessionId !== sessionId)
            return Promise.reject(new AccountError(409, "The ChatGPT task is invalid."));
          return this.#launch(entry, "task", input);
        },
        release: () => this.#retire(entry),
      });
    });
  }
  markSignedOut(generation: number): void {
    if (generation !== this.#generation || this.#closed || this.#blocked) return;
    this.#expired = true;
    this.#cache = { ...this.#base(), checkedAt: this.#now() };
  }
  status(opts: { fresh?: boolean } = {}): Promise<ChatgptStatus> {
    const reason = this.#reason();
    if (reason) return Promise.resolve(this.#unavailable(reason));
    if (this.#attempt || this.#mutation || this.#reservation?.kind === "task")
      return Promise.resolve(structuredClone(this.#cache ?? this.#base()));
    if (
      !opts.fresh &&
      this.#cache?.checkedAt !== undefined &&
      this.#now() - this.#cache.checkedAt < (this.#deps.statusTtlMs ?? 30000)
    )
      return Promise.resolve(structuredClone(this.#cache));
    return this.#serial(async () => {
      this.#usable();
      if (this.#attempt || this.#mutation || this.#reservation?.kind === "task")
        return structuredClone(this.#cache ?? this.#base());
      if (
        !opts.fresh &&
        this.#cache?.checkedAt !== undefined &&
        this.#now() - this.#cache.checkedAt < (this.#deps.statusTtlMs ?? 30000)
      )
        return structuredClone(this.#cache);
      const generation = this.#generation,
        status = await this.#read(generation, false);
      this.#checkGeneration(generation);
      this.#cache = status;
      this.#expired = status.state === "expired";
      return structuredClone(status);
    });
  }
  async #read(
    generation: number,
    refreshToken: boolean,
    mutation?: Mutation,
  ): Promise<ChatgptStatus> {
    const entry = this.#reserve("account", new AbortController().signal, generation, mutation);
    let status: ChatgptStatus;
    try {
      const conn = await this.#launch(entry, "account");
      await this.#initialize(entry, conn);
      const read = await this.#request(
          entry,
          conn,
          "account/read",
          { refreshToken },
          AccountRead.parse,
        ),
        account = accountFor(read.account);
      status = {
        ...this.#base(),
        state: account ? "signed_in" : this.#expired ? "expired" : "signed_out",
        checkedAt: this.#now(),
        ...(account ? { account } : {}),
      };
      if (account) {
        try {
          const models = await this.#request(entry, conn, "model/list", {}, ModelList.parse);
          status.models = modelsFor(models);
          const rates = await this.#request(
            entry,
            conn,
            "account/rateLimits/read",
            {},
            RateLimitsRead.parse,
          );
          const usage = subscriptionUsage(rates.rateLimits);
          if (usage) status.usage = usage;
        } catch {
          if (!this.#current(entry)) throw new AccountError(409, SUPERSEDED);
          status.lastError = "The ChatGPT account details could not be loaded.";
        }
      }
    } catch {
      this.#checkGeneration(generation, mutation);
      status = {
        ...(this.#cache ?? this.#base()),
        checkedAt: this.#now(),
        lastError: "The ChatGPT account could not be checked.",
      };
    } finally {
      await this.#retire(entry);
    }
    this.#checkGeneration(generation, mutation);
    return status;
  }
  #invalidateAttempt(): void {
    const attempt = this.#attempt;
    this.#attempt = undefined;
    this.#nonce++;
    if (!attempt) return;
    clearTimeout(attempt.timer);
    if (attempt.login)
      for (const conn of attempt.entry.holders) {
        try {
          void conn.rpc
            .request(
              "account/login/cancel",
              { loginId: attempt.login.loginId },
              {
                signal: AbortSignal.any([attempt.entry.signal, AbortSignal.timeout(500)]),
                timeoutMs: 500,
                validateResult: opaque,
              },
            )
            .catch(() => {});
        } catch {
          /* Cancellation is best effort; owned retirement is mandatory. */
        }
      }
  }
  #beginMutation(kind: Mutation["kind"]): Mutation {
    this.#usable();
    const mutation: Mutation = {
      kind,
      generation: ++this.#generation,
      retiring: Promise.resolve(),
    };
    this.#mutation = mutation;
    this.#cache = this.#base();
    this.#invalidateAttempt();
    try {
      for (const session of this.#deps.sessions()) {
        if (session.stopped) continue;
        try {
          this.#deps.pauseForAuth?.(session, mutation.generation);
        } catch {
          mutation.pauseFailed = true;
        }
        try {
          if (session.generation) session.retireBrain(session.generation);
        } catch {
          mutation.pauseFailed = true;
        }
        if (!session.controlHeld) {
          try {
            session.setStatus("paused");
          } catch {
            mutation.pauseFailed = true;
          }
          try {
            session.append("agent.state", { state: "paused", reason: "chatgpt account changed" });
          } catch {
            mutation.pauseFailed = true;
          }
        }
      }
    } catch {
      mutation.pauseFailed = true;
    }
    mutation.retiring = Promise.all([...this.#entries].map((entry) => this.#retire(entry))).then(
      () => {},
    );
    void mutation.retiring.catch(() => {});
    return mutation;
  }
  async #waitMutation(mutation: Mutation): Promise<void> {
    await mutation.retiring;
    this.#checkGeneration(mutation.generation, mutation);
    if (mutation.pauseFailed) throw new AccountError(503, "The ChatGPT tasks could not be paused.");
  }
  #endMutation(mutation: Mutation): void {
    if (this.#mutation === mutation) this.#mutation = undefined;
  }
  async login(method: "code" | "browser" = "code"): Promise<ChatgptLogin> {
    if (method !== "code" && method !== "browser")
      throw new AccountError(409, "The ChatGPT sign-in method is invalid.");
    this.#usable();
    // Raw Task9 launch has the same hard gate. Task14 must prove native binding and occupied
    // port handling before this is enabled; the upstream pin can otherwise fall back to1457.
    if (method === "browser") throw new AccountError(503, BROWSER_GATE);
    const mutation = this.#beginMutation("login");
    return this.#serial(async () => {
      let entry: Entry | undefined;
      try {
        await this.#waitMutation(mutation);
        entry = this.#reserve("login", new AbortController().signal, mutation.generation, mutation);
        const attempt: Attempt = {
          nonce: ++this.#nonce,
          generation: mutation.generation,
          entry,
          startedAt: this.#now(),
        };
        this.#attempt = attempt;
        this.#cache = { ...this.#base(), state: "signing_in" };
        attempt.timer = setTimeout(() => {
          if (this.#attempt === attempt)
            void this.#cancel("The sign-in timed out.").catch(() => {});
        }, this.#deps.loginTimeoutMs ?? 600000);
        attempt.timer.unref();
        const conn = await this.#launch(entry, "account", undefined, (name, value) =>
          this.#notification(attempt, name, value),
        );
        await this.#initialize(entry, conn);
        const result = await this.#request(
          entry,
          conn,
          "account/login/start",
          { type: "chatgptDeviceCode" },
          LoginStarted.parse,
        );
        this.#checkGeneration(mutation.generation, mutation);
        if (this.#attempt !== attempt || attempt.nonce !== this.#nonce)
          throw new AccountError(409, SUPERSEDED);
        const login = loginFor(result, method, attempt.startedAt);
        attempt.login = login;
        this.#cache = { ...this.#base(), state: "signing_in", login };
        if (attempt.early) this.#complete(attempt, attempt.early);
        return structuredClone(login);
      } catch (cause) {
        if (entry) await this.#retire(entry);
        if (this.#generation === mutation.generation && this.#mutation === mutation) {
          this.#invalidateAttempt();
          this.#cache = { ...this.#base(), lastError: CHATGPT_DEVICE_CODE_OFF };
        }
        if (cause instanceof AccountError) throw cause;
        if (
          cause instanceof CodexLaunchError &&
          ["install_required", "integrity_failed", "browser_unavailable"].includes(cause.code)
        )
          throw new AccountError(503, cause.message);
        throw new AccountError(503, CHATGPT_DEVICE_CODE_OFF);
      } finally {
        this.#endMutation(mutation);
      }
    });
  }
  #notification(attempt: Attempt, method: string, params: unknown): void {
    if (
      method !== "account/login/completed" ||
      this.#attempt !== attempt ||
      attempt.nonce !== this.#nonce ||
      !this.#current(attempt.entry)
    )
      return;
    const parsed = LoginCompleted.safeParse(params);
    if (!parsed.success || !parsed.data.loginId || parsed.data.loginId.length > 128) return;
    const result = {
      loginId: parsed.data.loginId,
      success: parsed.data.success,
      cancelled: parsed.data.error === "Login cancelled",
    };
    if (!attempt.login) {
      if (!attempt.early) attempt.early = result;
      return;
    }
    this.#complete(attempt, result);
  }
  #complete(attempt: Attempt, result: NonNullable<Attempt["early"]>): void {
    if (
      this.#attempt !== attempt ||
      attempt.nonce !== this.#nonce ||
      !this.#current(attempt.entry) ||
      result.loginId !== attempt.login?.loginId
    )
      return;
    this.#settleAttempt(
      attempt,
      result.success
        ? undefined
        : result.cancelled
          ? "The sign-in was cancelled."
          : "The ChatGPT sign-in could not be completed.",
    );
  }
  #settleAttempt(attempt: Attempt, reason?: string, omitErrorIfSignedIn = false): void {
    if (this.#attempt !== attempt || attempt.nonce !== this.#nonce) return;
    this.#attempt = undefined;
    this.#nonce++;
    clearTimeout(attempt.timer);
    this.#cache = this.#base();
    const mutation: Mutation = {
      kind: "completion",
      generation: attempt.generation,
      retiring: Promise.resolve(),
    };
    this.#mutation = mutation;
    mutation.retiring = this.#retire(attempt.entry);
    void mutation.retiring.catch(() => {});
    void this.#serial(async () => {
      try {
        await this.#waitMutation(mutation);
        const status = await this.#read(mutation.generation, false, mutation);
        this.#checkGeneration(mutation.generation, mutation);
        if (reason && (!omitErrorIfSignedIn || status.state !== "signed_in"))
          status.lastError = reason;
        this.#cache = status;
        this.#expired = status.state === "expired";
      } catch {
        if (
          this.#generation === mutation.generation &&
          this.#mutation === mutation &&
          !this.#blocked &&
          !this.#closed
        )
          this.#cache = { ...this.#base(), lastError: "The ChatGPT sign-in could not be checked." };
      } finally {
        this.#endMutation(mutation);
      }
    }).catch(() => {});
  }
  cancelLogin(): Promise<void> {
    return this.#cancel();
  }
  #cancel(reason?: string): Promise<void> {
    if (!this.#attempt && this.#mutation?.kind !== "login" && this.#mutation?.kind !== "completion")
      return Promise.resolve();
    let mutation: Mutation;
    try {
      mutation = this.#beginMutation("cancel");
    } catch (cause) {
      return Promise.reject(cause);
    }
    return this.#serial(async () => {
      try {
        await this.#waitMutation(mutation);
        const status = await this.#read(mutation.generation, false, mutation);
        this.#checkGeneration(mutation.generation, mutation);
        if (reason && status.state !== "signed_in") status.lastError = reason;
        this.#cache = status;
        this.#expired = status.state === "expired";
      } finally {
        this.#endMutation(mutation);
      }
    });
  }
  async logout(): Promise<void> {
    const mutation = this.#beginMutation("logout");
    return this.#serial(async () => {
      let entry: Entry | undefined;
      try {
        await this.#waitMutation(mutation);
        entry = this.#reserve(
          "account",
          new AbortController().signal,
          mutation.generation,
          mutation,
        );
        const conn = await this.#launch(entry, "account");
        await this.#initialize(entry, conn);
        await this.#request(entry, conn, "account/logout", {}, opaque);
        await this.#retire(entry);
        this.#checkGeneration(mutation.generation, mutation);
        this.#expired = false;
        this.#cache = { ...this.#base(), checkedAt: this.#now() };
      } catch (cause) {
        if (entry) await this.#retire(entry);
        if (cause instanceof AccountError) throw cause;
        throw new AccountError(503, "The ChatGPT account could not be signed out.");
      } finally {
        this.#endMutation(mutation);
      }
    });
  }
  async refresh(): Promise<ChatgptStatus> {
    if (this.#attempt || this.#mutation?.kind === "login")
      throw new AccountError(409, "Finish or cancel the ChatGPT sign-in first.");
    const mutation = this.#beginMutation("refresh");
    return this.#serial(async () => {
      try {
        await this.#waitMutation(mutation);
        const status = await this.#read(mutation.generation, true, mutation);
        this.#checkGeneration(mutation.generation, mutation);
        this.#cache = status;
        this.#expired = status.state === "expired";
        return structuredClone(status);
      } finally {
        this.#endMutation(mutation);
      }
    });
  }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    const closed = deferred<void>();
    this.#closePromise = closed.promise;
    this.#closed = true;
    this.#generation++;
    this.#invalidateAttempt();
    this.#cache = undefined;
    Promise.all([...this.#entries].map((entry) => this.#retire(entry))).then(
      () => closed.resolve(),
      closed.reject,
    );
    return closed.promise;
  }
}
