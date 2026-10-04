import {
  type ClientMethod,
  CodexLaunchError,
  decideServerRequest,
  isApprovalCurrent,
  type RpcRequestOptions,
} from "@localdot/codex-harness";
import type { CodexDriverLease, TaskConnection, TaskLaunch } from "../driver.ts";

export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
export async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 2500;
  while (!check()) {
    if (Date.now() > end) throw new Error("fake Codex condition was not reached");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}
export interface FakeConnection {
  readonly input: TaskLaunch;
  readonly connection: TaskConnection;
  readonly requests: { method: ClientMethod; params: unknown }[];
  readonly notifications: { method: string; params: unknown }[];
  threadId: string;
  turnId: string;
  stopped: boolean;
  stopGate?: Promise<void>;
  requestHook?: (method: ClientMethod, params: unknown) => Promise<unknown> | undefined;
  notify(method: string, params: unknown): void;
  complete(status?: "completed" | "failed" | "interrupted", errorKind?: string): void;
  crash(): void;
  serverRequest(method: string, params: unknown): unknown;
  waitFor(method: ClientMethod, count?: number): Promise<{ method: ClientMethod; params: unknown }>;
}
// Inert protocol fixtures, not a pinned binary or auth/sandbox acceptance. Their lease has the
// same reserve/register/confirmed-release ordering as the later single credential owner.
export function fakeCodex() {
  const launches: FakeConnection[] = [];
  let authAbort = new AbortController();
  let authGeneration = 1,
    activeLeases = 0,
    maxLeases = 0,
    signedIn = true;
  const fixture = {
    launches,
    signedOut: [] as number[],
    acquireGate: undefined as Promise<void> | undefined,
    launchGate: undefined as Promise<void> | undefined,
    releaseGate: undefined as Promise<void> | undefined,
    requestHook: undefined as FakeConnection["requestHook"],
    get activeLeases() {
      return activeLeases;
    },
    get maxLeases() {
      return maxLeases;
    },
    setSignedIn(value: boolean) {
      signedIn = value;
    },
    changeAuth() {
      authGeneration++;
      authAbort.abort();
      authAbort = new AbortController();
    },
    auth: {
      get authGeneration() {
        return authGeneration;
      },
      canResume(generation: number) {
        return generation === authGeneration && signedIn;
      },
      markSignedOut(generation: number) {
        if (generation === authGeneration) fixture.signedOut.push(generation);
      },
      async acquireTask(_sessionId: string, signal: AbortSignal): Promise<CodexDriverLease> {
        await fixture.acquireGate;
        signal.throwIfAborted();
        if (activeLeases) throw new Error("fake credential owner is still registered");
        activeLeases++;
        maxLeases = Math.max(maxLeases, activeLeases);
        const generation = authGeneration,
          leaseAbort = new AbortController(),
          leaseSignal = AbortSignal.any([signal, leaseAbort.signal, authAbort.signal]);
        let holder: TaskConnection | undefined, released: Promise<void> | undefined;
        return {
          generation,
          signal: leaseSignal,
          async launch(input) {
            leaseSignal.throwIfAborted();
            const exited = deferred<unknown>(),
              closed = deferred<void>(),
              failure = deferred<CodexLaunchError>();
            let stopping: Promise<void> | undefined;
            const current: FakeConnection = {
              input,
              connection: undefined as never,
              requests: [],
              notifications: [],
              threadId: "",
              turnId: "",
              stopped: false,
              requestHook: fixture.requestHook,
              notify: (method, params) =>
                input.onNotification(method, params, { signal: input.signal }),
              complete: (status = "completed", errorKind) =>
                current.notify("turn/completed", {
                  threadId: current.threadId,
                  turn: {
                    id: current.turnId,
                    status,
                    ...(errorKind
                      ? { error: { message: "fake-private-diagnostic", codexErrorInfo: errorKind } }
                      : {}),
                  },
                }),
              crash() {
                input.onFence();
                const cause = new CodexLaunchError("process_exited");
                input.onFailure(cause);
                failure.resolve(cause);
                exited.resolve({ code: 1, signal: null });
              },
              serverRequest(method, params) {
                const decision = decideServerRequest(method, params, input.approvalContext());
                if (decision.blocked && input.isCurrent()) input.onBlocked(decision.blocked);
                return decision.verdict === "approved" && !isApprovalCurrent(decision)
                  ? undefined
                  : decision;
              },
              async waitFor(method, count = 1) {
                await until(
                  () => current.requests.filter((r) => r.method === method).length >= count,
                );
                return current.requests.filter((r) => r.method === method)[count - 1] as {
                  method: ClientMethod;
                  params: unknown;
                };
              },
            };
            const conn: TaskConnection = Object.freeze({
              workDir: "/private/tmp/fake-codex-work",
              exited: exited.promise,
              closed: closed.promise,
              failure: failure.promise,
              rpc: {
                async request<T>(
                  method: ClientMethod,
                  params: unknown,
                  options: RpcRequestOptions<T>,
                ): Promise<T> {
                  options.signal.throwIfAborted();
                  current.requests.push({ method, params });
                  let result: unknown;
                  const custom = current.requestHook?.(method, params);
                  if (custom) result = await custom;
                  else if (method === "initialize") result = {};
                  else if (method === "account/read")
                    result = {
                      account: signedIn
                        ? { type: "chatgpt", email: "fixture@example.invalid", planType: "plus" }
                        : null,
                      requiresOpenaiAuth: true,
                    };
                  else if (method === "thread/start") {
                    current.threadId = `thread-${launches.length}`;
                    result = {
                      thread: { id: current.threadId },
                      model: (params as { model: string }).model,
                      approvalsReviewer: "user",
                    };
                  } else if (method === "turn/start") {
                    current.turnId = `turn-${launches.length}`;
                    const turn = { id: current.turnId, status: "inProgress" };
                    current.notify("turn/started", { threadId: current.threadId, turn });
                    result = { turn };
                  } else if (method === "turn/steer") result = { turnId: current.turnId };
                  else result = {};
                  options.signal.throwIfAborted();
                  return options.validateResult(result);
                },
                notify(method: "initialized", params: Record<string, never>) {
                  current.notifications.push({ method, params });
                },
              },
              stop() {
                if (stopping) return stopping;
                current.stopped = true;
                const active = input.interruptTurn();
                if (active) current.requests.push({ method: "turn/interrupt", params: active });
                input.onFence();
                stopping = (async () => {
                  await current.stopGate;
                  exited.resolve({ code: 0, signal: null });
                  closed.resolve();
                })();
                void stopping.catch(() => {});
                return stopping;
              },
            });
            Object.defineProperty(current, "connection", { value: conn });
            holder = conn;
            launches.push(current);
            input.onRegister(conn);
            await fixture.launchGate;
            input.signal.throwIfAborted();
            return conn;
          },
          release() {
            if (released) return released;
            leaseAbort.abort();
            released = (async () => {
              if (holder) {
                await holder.stop();
                await holder.closed;
              }
              await fixture.releaseGate;
              activeLeases--;
            })();
            void released.catch(() => {});
            return released;
          },
        };
      },
    },
    async nextLaunch(count: number) {
      await until(() => launches.length >= count);
      return launches[count - 1] as FakeConnection;
    },
  };
  return fixture;
}
