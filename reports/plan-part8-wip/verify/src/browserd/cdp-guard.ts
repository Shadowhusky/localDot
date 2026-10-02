import { isAbsolute, normalize } from "node:path";

// browserd's only way into Chromium (P8-R3). Chromium runs with --remote-debugging-pipe, so no
// port exists that anything else could dial, and every command browserd sends passes this guard.
// The list is what browserd needs and nothing more: no Runtime (script), no Network, Storage,
// DOMStorage, IndexedDB or CacheStorage (cookies and site data), no Fetch (interception), no
// Input (input is XTest, so the XI2 stamps hold) and no Page.captureScreenshot (screenshots are
// the X screen, as the stream shows it). A refused call never reaches the pipe.
export const CDP_ALLOWED: ReadonlySet<string> = new Set([
  "Browser.getVersion",
  "Browser.setDownloadBehavior",
  "Browser.cancelDownload",
  "Browser.getWindowForTarget",
  "Browser.setWindowBounds",
  "Target.setDiscoverTargets",
  "Target.setAutoAttach",
  "Target.getTargets",
  "Target.attachToTarget",
  "Target.detachFromTarget",
  "Target.createTarget",
  "Target.activateTarget",
  "Runtime.runIfWaitingForDebugger",
  "Page.enable",
  "Page.navigate",
  "Page.reload",
  "Page.stopLoading",
  "Page.getLayoutMetrics",
  "Page.getFrameTree",
  "Page.bringToFront",
  "Page.setInterceptFileChooserDialog",
  "Page.handleJavaScriptDialog",
  "DOM.enable",
  "DOM.getDocument",
  "DOM.getNodeForLocation",
  "DOM.getBoxModel",
  "DOM.describeNode",
  "DOM.setFileInputFiles",
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  "Accessibility.queryAXTree",
]);

// The events browserd acts on; anything else Chromium sends is dropped at the pipe.
export const CDP_EVENTS: ReadonlySet<string> = new Set([
  "Target.attachedToTarget",
  "Target.detachedFromTarget",
  "Target.targetCreated",
  "Target.targetDestroyed",
  "Target.targetInfoChanged",
  "Target.targetCrashed",
  "Page.fileChooserOpened",
  "Page.frameNavigated",
  "Page.loadEventFired",
  "Page.javascriptDialogOpening",
  "Browser.downloadWillBegin",
  "Browser.downloadProgress",
  "Inspector.detached",
  "Inspector.targetCrashed",
]);

export class CdpRefused extends Error {
  constructor(
    readonly method: string,
    reason: string,
  ) {
    super(`refused CDP ${method}: ${reason}`);
    this.name = "CdpRefused";
  }
}

export interface GuardConfig {
  downloadDir: string;
  uploadDir: string;
}

type Params = Record<string, unknown>;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// A page browserd may open: http(s), a name rather than an address, no credentials. keyd refuses
// the rest anyway (spec "Every cell reaches hosts by name only"); refusing here gives a clear
// answer and keeps javascript:, file:, chrome: and data: out of Page.navigate entirely.
export function navigable(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname;
  return !(host.startsWith("[") || IPV4.test(host) || host === "localhost" || !host.includes("."));
}

function keysWithin(method: string, params: Params, allowed: readonly string[]): void {
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) throw new CdpRefused(method, `parameter ${key}`);
  }
}

function inside(dir: string, file: unknown): boolean {
  if (typeof file !== "string" || !isAbsolute(file)) return false;
  const clean = normalize(file);
  return clean === file && clean.startsWith(`${normalize(dir)}/`);
}

// Throws CdpRefused for anything outside the list or outside a method's own limits.
export function checkCdpCall(method: string, params: Params, cfg: GuardConfig): void {
  if (!CDP_ALLOWED.has(method)) throw new CdpRefused(method, "not on browserd's list");
  switch (method) {
    case "Page.navigate":
      keysWithin(method, params, ["url", "referrer", "transitionType", "frameId"]);
      if (!navigable(params.url)) throw new CdpRefused(method, "not a web URL");
      return;
    case "Page.reload":
      // scriptToEvaluateOnLoad would run script in the page.
      keysWithin(method, params, ["ignoreCache"]);
      return;
    case "Target.createTarget":
      keysWithin(method, params, ["url"]);
      if (params.url !== "about:blank") throw new CdpRefused(method, "only about:blank");
      return;
    case "Target.attachToTarget":
      keysWithin(method, params, ["targetId", "flatten"]);
      if (params.flatten !== true) throw new CdpRefused(method, "flat sessions only");
      return;
    case "Target.setAutoAttach":
      keysWithin(method, params, ["autoAttach", "waitForDebuggerOnStart", "flatten", "filter"]);
      if (params.flatten !== true) throw new CdpRefused(method, "flat sessions only");
      return;
    case "DOM.setFileInputFiles": {
      keysWithin(method, params, ["files", "backendNodeId"]);
      const files = params.files;
      if (!Array.isArray(files) || files.length === 0 || files.length > 10)
        throw new CdpRefused(method, "one to ten files");
      if (!files.every((f) => inside(cfg.uploadDir, f)))
        throw new CdpRefused(method, "files must be staged uploads");
      return;
    }
    case "Browser.setDownloadBehavior":
      keysWithin(method, params, ["behavior", "downloadPath", "eventsEnabled"]);
      if (
        params.behavior !== "allowAndName" ||
        params.downloadPath !== cfg.downloadDir ||
        params.eventsEnabled !== true
      )
        throw new CdpRefused(method, "downloads go to the quarantine folder, named by GUID");
      return;
    case "Page.handleJavaScriptDialog":
      keysWithin(method, params, ["accept"]);
      return;
  }
}

// What a CDP transport looks like to the guard: Chromium's pipe (fds 3 and 4, NUL-separated JSON)
// in the cell, a fake in tests.
export interface CdpTransport {
  write(message: string): void;
  onMessage(listener: (message: string) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

interface Pending {
  method: string;
  resolve(result: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export type CdpEventListener = (params: Params, sessionId: string | undefined) => void;

export class GuardedCdp {
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Map<string, Set<CdpEventListener>>();
  #nextId = 1;
  #closed = false;

  constructor(
    private readonly transport: CdpTransport,
    private readonly cfg: GuardConfig,
    private readonly timeoutMs = 15_000,
  ) {
    transport.onMessage((text) => this.#receive(text));
    transport.onClose(() => this.#fail(new Error("Chromium closed the DevTools pipe")));
  }

  get closed(): boolean {
    return this.#closed;
  }

  send<T = Params>(method: string, params: Params = {}, sessionId?: string): Promise<T> {
    try {
      checkCdpCall(method, params, this.cfg);
    } catch (err) {
      return Promise.reject(err);
    }
    if (this.#closed) return Promise.reject(new Error("the DevTools pipe is closed"));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, this.timeoutMs);
      this.#pending.set(id, { method, resolve: resolve as (r: unknown) => void, reject, timer });
      this.transport.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(event: string, listener: CdpEventListener): () => void {
    if (!CDP_EVENTS.has(event)) throw new CdpRefused(event, "not an event browserd handles");
    const set = this.#listeners.get(event) ?? new Set();
    set.add(listener);
    this.#listeners.set(event, set);
    return () => set.delete(listener);
  }

  close(): void {
    this.transport.close();
    this.#fail(new Error("closed"));
  }

  #receive(text: string): void {
    let msg: { id?: number; method?: string; params?: Params; result?: unknown; error?: { message?: string }; sessionId?: string };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`CDP ${p.method}: ${msg.error.message ?? "error"}`));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method !== "string" || !CDP_EVENTS.has(msg.method)) return;
    for (const listener of this.#listeners.get(msg.method) ?? []) listener(msg.params ?? {}, msg.sessionId);
  }

  #fail(err: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
  }
}
