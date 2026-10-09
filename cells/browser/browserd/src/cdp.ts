import { type CdpCapabilities, guardCdpCommand } from "./cdp-guard.ts";
import { type CdpTransport, MAX_CDP_MESSAGE_BYTES } from "./pipe.ts";

export const MAX_CDP_PENDING = 32;
export const CDP_REQUEST_TIMEOUT_MS = 5000;

const events = new Set([
  "Target.attachedToTarget",
  "Target.detachedFromTarget",
  "Target.targetCreated",
  "Target.targetDestroyed",
  "Target.targetInfoChanged",
  "Target.targetCrashed",
  "Page.fileChooserOpened",
  "Page.frameNavigated",
  "Page.frameAttached",
  "Page.frameDetached",
  "Page.navigatedWithinDocument",
  "DOM.documentUpdated",
  "Page.loadEventFired",
  "Page.lifecycleEvent",
  "Page.javascriptDialogOpening",
  "Browser.downloadWillBegin",
  "Browser.downloadProgress",
  "Inspector.detached",
  "Inspector.targetCrashed",
]);

// Reads of a page that change nothing in Chromium. A slow page answers them slowly; one given up on,
// by its caller or for taking too long, is no longer waited for and its late reply is dropped,
// where any other request left unanswered fences the connection.
const PAGE_READS = new Set([
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "DOMSnapshot.captureSnapshot",
  "Accessibility.getFullAXTree",
  "Browser.getWindowForTarget",
  "DOM.getNodeForLocation",
]);

export class CdpRequestError extends Error {
  constructor(
    readonly reason: "closed" | "busy" | "cancelled" | "timeout" | "protocol" | "failed",
  ) {
    super(`Browser request refused: ${reason}`);
  }
}

interface PendingRequest {
  sessionId?: string;
  resolve(result: Readonly<Record<string, unknown>>): void;
  reject(reason: CdpRequestError): void;
  cleanup(): void;
}

type EventListener = (params: Readonly<Record<string, unknown>>, sessionId?: string) => void;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class GuardedCdp {
  readonly #pending = new Map<number, PendingRequest>();
  readonly #listeners = new Map<string, Set<EventListener>>();
  readonly #unsubscribe: (() => void)[] = [];
  #nextId = 1;
  #closed = false;

  constructor(
    private readonly transport: CdpTransport,
    private readonly capabilities: CdpCapabilities,
    private readonly onFatal: (reason: CdpRequestError) => void,
  ) {
    this.#unsubscribe.push(transport.onMessage((message) => this.#receive(message)));
    this.#unsubscribe.push(transport.onClose(() => this.#fail(new CdpRequestError("closed"))));
  }

  get closed(): boolean {
    return this.#closed;
  }

  send(
    method: string,
    params: unknown = {},
    options: { sessionId?: string; signal?: AbortSignal } = {},
  ): Promise<Readonly<Record<string, unknown>>> {
    try {
      if (this.#closed) throw new CdpRequestError("closed");
      if (options.signal?.aborted) throw new CdpRequestError("cancelled");
      if (this.#pending.size >= MAX_CDP_PENDING) throw new CdpRequestError("busy");
      const command = guardCdpCommand(method, params, this.capabilities, options.sessionId);
      if (this.#closed) throw new CdpRequestError("closed");
      if (options.signal?.aborted) throw new CdpRequestError("cancelled");
      if (this.#pending.size >= MAX_CDP_PENDING) throw new CdpRequestError("busy");
      if (!Number.isSafeInteger(this.#nextId)) {
        this.#fail(new CdpRequestError("protocol"));
        throw new CdpRequestError("closed");
      }
      const id = this.#nextId++;
      const reply = Promise.withResolvers<Readonly<Record<string, unknown>>>();
      const unanswered = (reason: "timeout" | "cancelled") => {
        if (!PAGE_READS.has(method)) {
          this.#fail(new CdpRequestError(reason));
          return;
        }
        if (this.#pending.get(id) !== request) return;
        this.#pending.delete(id);
        request.cleanup();
        request.reject(new CdpRequestError(reason));
      };
      const timeout = setTimeout(() => unanswered("timeout"), CDP_REQUEST_TIMEOUT_MS);
      const cancelled = () => unanswered("cancelled");
      const signal = options.signal;
      const request: PendingRequest = {
        sessionId: command.sessionId,
        resolve: reply.resolve,
        reject: reply.reject,
        cleanup: () => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", cancelled);
        },
      };
      this.#pending.set(id, request);
      signal?.addEventListener("abort", cancelled, { once: true });
      if (signal?.aborted) cancelled();
      if (!this.#closed) {
        try {
          this.transport.write(JSON.stringify({ id, ...command }));
        } catch {
          this.#fail(new CdpRequestError("closed"));
        }
      }
      return reply.promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  on(event: string, listener: EventListener): () => void {
    if (this.#closed) throw new CdpRequestError("closed");
    if (!events.has(event)) throw new CdpRequestError("protocol");
    const listeners = this.#listeners.get(event) ?? new Set<EventListener>();
    if (listeners.size >= 32) throw new CdpRequestError("busy");
    listeners.add(listener);
    this.#listeners.set(event, listeners);
    return () => {
      listeners.delete(listener);
    };
  }

  close(): void {
    this.#fail(new CdpRequestError("closed"));
  }

  retire(): boolean {
    return this.#fail(new CdpRequestError("closed"), true);
  }

  #receive(message: string): void {
    if (this.#closed) return;
    if (Buffer.byteLength(message, "utf8") > MAX_CDP_MESSAGE_BYTES) {
      this.#fail(new CdpRequestError("protocol"));
      return;
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(message);
    } catch {
      this.#fail(new CdpRequestError("protocol"));
      return;
    }
    if (!record(envelope)) {
      this.#fail(new CdpRequestError("protocol"));
      return;
    }
    if (Object.hasOwn(envelope, "id")) {
      if (
        typeof envelope.id !== "number" ||
        !Number.isSafeInteger(envelope.id) ||
        envelope.id <= 0
      ) {
        this.#fail(new CdpRequestError("protocol"));
        return;
      }
      const request = this.#pending.get(envelope.id);
      if (!request) return;
      const hasResult = Object.hasOwn(envelope, "result");
      const hasError = Object.hasOwn(envelope, "error");
      if (
        envelope.sessionId !== request.sessionId ||
        (request.sessionId !== undefined && !this.capabilities.ownsSession(request.sessionId)) ||
        hasResult === hasError ||
        Object.keys(envelope).some(
          (key) => !["id", "sessionId", "result", "error"].includes(key),
        ) ||
        (hasResult && !record(envelope.result)) ||
        (hasError &&
          (!record(envelope.error) ||
            typeof envelope.error.code !== "number" ||
            !Number.isSafeInteger(envelope.error.code) ||
            typeof envelope.error.message !== "string"))
      ) {
        this.#fail(new CdpRequestError("protocol"));
        return;
      }
      this.#pending.delete(envelope.id);
      request.cleanup();
      if (hasError) request.reject(new CdpRequestError("failed"));
      else request.resolve(Object.freeze(envelope.result as Record<string, unknown>));
      return;
    }
    if (typeof envelope.method !== "string" || !events.has(envelope.method)) return;
    const pageEvent = /^(Page|DOM|Inspector)\./u.test(envelope.method);
    const browserEvent = envelope.method.startsWith("Browser.");
    if (
      !record(envelope.params) ||
      Object.keys(envelope).some((key) => !["method", "params", "sessionId"].includes(key)) ||
      (pageEvent && typeof envelope.sessionId !== "string") ||
      (browserEvent && envelope.sessionId !== undefined) ||
      (envelope.sessionId !== undefined &&
        (typeof envelope.sessionId !== "string" ||
          !this.capabilities.ownsSession(envelope.sessionId)))
    ) {
      this.#fail(new CdpRequestError("protocol"));
      return;
    }
    const params = Object.freeze(envelope.params);
    const listeners = this.#listeners.get(envelope.method);
    for (const listener of [...(listeners ?? [])]) {
      if (this.#closed) break;
      if (!listeners?.has(listener)) continue;
      try {
        listener(params, envelope.sessionId as string | undefined);
      } catch {
        this.#fail(new CdpRequestError("protocol"));
      }
    }
  }

  #fail(reason: CdpRequestError, retire = false): boolean {
    if (this.#closed) return false;
    this.#closed = true;
    try {
      this.onFatal(reason);
    } catch {}
    for (const unsubscribe of this.#unsubscribe.splice(0)) {
      try {
        unsubscribe();
      } catch {}
    }
    for (const request of this.#pending.values()) {
      try {
        request.cleanup();
      } catch {}
      request.reject(reason);
    }
    this.#pending.clear();
    this.#listeners.clear();
    try {
      if (retire && this.transport.retire?.()) return true;
    } catch {}
    try {
      this.transport.close();
    } catch {}
    return false;
  }
}
