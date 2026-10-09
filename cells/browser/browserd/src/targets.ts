import { randomUUID } from "node:crypto";
import { z as schema } from "zod";
import {
  type BrowserUploadChooser,
  BrowserUploadOffer,
} from "../../../../packages/protocol/src/browser-uploads.ts";
import { GuardedCdp } from "./cdp.ts";
import { cookiePartitionKey } from "./cdp-guard.ts";
import { navigateOwnedDocument } from "./navigation.ts";
import type { CdpTransport } from "./pipe.ts";

export const MAX_BROWSER_TARGETS = 256;
export const MAX_DOCUMENT_NODES = 4096;
export const MAX_BROWSER_NODES = 32768;
export const BROWSER_TARGET_START_TIMEOUT_MS = 30_000;
export const BROWSER_RELOAD_TIMEOUT_MS = 3000;
export const BROWSER_CHOOSER_TIMEOUT_MS = 5 * 60_000;

const identifier = schema.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u);
const nodeNumber = schema.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const targetInfo = schema.object({
  targetId: identifier,
  type: schema.enum(["page", "iframe"]),
  title: schema.string().max(8192),
  url: schema.string().max(32768),
  attached: schema.boolean(),
});
const filter = Object.freeze([
  Object.freeze({ type: "page", exclude: false }),
  Object.freeze({ type: "iframe", exclude: false }),
  Object.freeze({ exclude: true }),
]);
const attachOptions = Object.freeze({
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter,
});

const cookieList = schema.object({
  cookies: schema
    .array(
      schema.object({
        name: schema.string().max(4096),
        domain: schema.string().min(1).max(256),
        path: schema.string().max(4096),
        partitionKey: cookiePartitionKey.optional(),
      }),
    )
    .max(50_000),
});

export interface BrowserCookie {
  readonly name: string;
  readonly domain: string;
  readonly path: string;
  readonly partitionKey?: schema.infer<typeof cookiePartitionKey>;
}

export class BrowserTargetError extends Error {
  constructor(readonly reason: "closed" | "protocol" | "busy" | "stale" | "unready") {
    super(`Browser target refused: ${reason}`);
  }
}

export interface BrowserDocument {
  readonly tabId: string;
  readonly revision: number;
  readonly frame: boolean;
}

export interface BrowserFileChooser extends BrowserUploadChooser {
  readonly document: BrowserDocument;
  readonly signal: AbortSignal;
}

interface FileChooserRecord {
  readonly target: TargetRecord;
  readonly revision: number;
  readonly backendNodeId: number;
  readonly frameId: string;
  readonly info: Readonly<BrowserUploadChooser>;
  readonly abort: AbortController;
  claimed: boolean;
  filling: boolean;
}

interface TargetRecord {
  targetId: string;
  tabId: string;
  type: "page" | "iframe";
  sessionId?: string;
  parentSessionId?: string;
  ready: boolean;
  revision: number;
  nodes: Set<number>;
  windowId?: number;
}

interface DocumentRecord {
  target: TargetRecord;
  revision: number;
}

export interface BrowserTargetsOptions {
  readonly downloadDir: string;
  readonly uploadDir: string;
  onFatal(reason: BrowserTargetError): void;
  onInvalidated?(): void;
  readonly downloads?: {
    owns(guid: string): boolean;
    begin(params: Readonly<Record<string, unknown>>): void;
    progress(params: Readonly<Record<string, unknown>>): void;
  };
}

export class BrowserTargets {
  readonly #broker: GuardedCdp;
  readonly #targets = new Map<string, TargetRecord>();
  readonly #sessions = new Map<string, TargetRecord>();
  readonly #documents = new WeakMap<BrowserDocument, DocumentRecord>();
  readonly #queue: TargetRecord[] = [];
  readonly #idle = new Set<() => void>();
  readonly #reloads = new Map<TargetRecord, () => void>();
  readonly #fileChoosers = new WeakMap<BrowserFileChooser, FileChooserRecord>();
  #fileChooser?: FileChooserRecord;
  #chooserTimer?: ReturnType<typeof setTimeout>;
  #uploadReceipt?: { chooser: FileChooserRecord; files: readonly string[] };
  #workers = 0;
  #closed = false;
  #started?: Promise<void>;

  constructor(
    transport: CdpTransport,
    private readonly options: BrowserTargetsOptions,
  ) {
    this.#broker = new GuardedCdp(
      transport,
      {
        downloadDir: options.downloadDir,
        uploadDir: options.uploadDir,
        ownsTarget: (targetId) => !this.#closed && this.#targets.has(targetId),
        ownsSession: (sessionId) => !this.#closed && this.#sessions.has(sessionId),
        ownsWindow: (windowId) =>
          !this.#closed &&
          [...this.#targets.values()].some((target) => target.windowId === windowId),
        ownsNode: (sessionId, backendNodeId) =>
          !this.#closed &&
          (this.#sessions.get(sessionId)?.nodes.has(backendNodeId) === true ||
            (this.#fileChooser?.target.sessionId === sessionId &&
              this.#fileChooser.backendNodeId === backendNodeId)),
        ownsDownload: (guid) => !this.#closed && this.options.downloads?.owns(guid) === true,
        allowsUpload: (sessionId, backendNodeId, files) => {
          const receipt = this.#uploadReceipt;
          if (
            !receipt ||
            !receipt.chooser.filling ||
            receipt.chooser !== this.#fileChooser ||
            receipt.chooser.abort.signal.aborted ||
            receipt.chooser.target.sessionId !== sessionId ||
            receipt.chooser.backendNodeId !== backendNodeId ||
            receipt.chooser.target.revision !== receipt.chooser.revision ||
            receipt.files.length !== files.length ||
            files.some((file, index) => file !== receipt.files[index])
          )
            return false;
          this.#uploadReceipt = undefined;
          return true;
        },
      },
      () => this.#fail("closed"),
    );
    for (const event of ["Target.targetCreated", "Target.targetInfoChanged"]) {
      this.#broker.on(event, (params, sessionId) => {
        const info = schema.object({ targetInfo }).parse(params).targetInfo;
        if (
          sessionId !== undefined &&
          (event !== "Target.targetInfoChanged" ||
            this.#targets.get(info.targetId)?.parentSessionId !== sessionId)
        )
          throw new BrowserTargetError("protocol");
        if (event === "Target.targetCreated" || this.#targets.has(info.targetId))
          this.#discover(info);
      });
    }
    this.#broker.on("Target.attachedToTarget", (params, parentSessionId) => {
      const attached = schema
        .object({ sessionId: identifier, targetInfo, waitingForDebugger: schema.boolean() })
        .parse(params);
      this.#attach(attached.sessionId, attached.targetInfo, parentSessionId);
    });
    this.#broker.on("Target.detachedFromTarget", (params, parentSessionId) => {
      const detached = schema
        .object({ sessionId: identifier, targetId: identifier.optional() })
        .parse(params);
      const target = this.#sessions.get(detached.sessionId);
      if (!target) return;
      if (
        parentSessionId !== target.parentSessionId ||
        (detached.targetId !== undefined && detached.targetId !== target.targetId)
      )
        throw new BrowserTargetError("protocol");
      this.#remove(target);
    });
    this.#broker.on("Target.targetDestroyed", (params, sessionId) => {
      if (sessionId !== undefined) throw new BrowserTargetError("protocol");
      const destroyed = schema.object({ targetId: identifier }).parse(params);
      const target = this.#targets.get(destroyed.targetId);
      if (target) this.#remove(target);
    });
    this.#broker.on("Target.targetCrashed", (params, sessionId) => {
      if (sessionId !== undefined) throw new BrowserTargetError("protocol");
      const crashed = schema.object({ targetId: identifier }).parse(params);
      if (!this.#targets.has(crashed.targetId)) throw new BrowserTargetError("protocol");
      this.#fail("closed");
    });
    this.#broker.on("Inspector.targetCrashed", () => this.#fail("closed"));
    this.#broker.on("Inspector.detached", (_params, sessionId) => {
      this.#remove(this.#ownedSession(sessionId));
    });
    this.#broker.on("Page.fileChooserOpened", (params, sessionId) => {
      const target = this.#ownedSession(sessionId);
      const opened = schema
        .object({
          frameId: identifier,
          mode: schema.enum(["selectSingle", "selectMultiple"]),
          backendNodeId: nodeNumber.optional(),
        })
        .parse(params);
      this.clearFileChooser();
      // Non-DOM pickers do not name an owned input and cannot authorize a file.
      if (!target.ready || opened.backendNodeId === undefined) return;
      const chooser: FileChooserRecord = {
        target,
        revision: target.revision,
        backendNodeId: opened.backendNodeId,
        frameId: opened.frameId,
        info: Object.freeze({
          id: randomUUID(),
          mode: opened.mode === "selectSingle" ? "single" : "multiple",
        }),
        abort: new AbortController(),
        claimed: false,
        filling: false,
      };
      this.#fileChooser = chooser;
      this.#chooserTimer = setTimeout(() => {
        if (this.#fileChooser === chooser) this.clearFileChooser();
      }, BROWSER_CHOOSER_TIMEOUT_MS);
      this.#chooserTimer.unref();
    });
    this.#broker.on("DOM.documentUpdated", (_params, sessionId) => {
      this.#invalidate(this.#ownedSession(sessionId));
    });
    this.#broker.on("Page.frameNavigated", (params, sessionId) => {
      schema.object({ frame: schema.object({ id: identifier }) }).parse(params);
      this.#invalidate(this.#ownedSession(sessionId));
    });
    this.#broker.on("Page.frameAttached", (params, sessionId) => {
      schema.object({ frameId: identifier, parentFrameId: identifier }).parse(params);
      this.#invalidate(this.#ownedSession(sessionId));
    });
    this.#broker.on("Page.frameDetached", (params, sessionId) => {
      schema.object({ frameId: identifier, reason: schema.enum(["remove", "swap"]) }).parse(params);
      this.#invalidate(this.#ownedSession(sessionId));
    });
    this.#broker.on("Page.navigatedWithinDocument", (params, sessionId) => {
      schema.object({ frameId: identifier, url: schema.string().max(32768) }).parse(params);
      this.#invalidate(this.#ownedSession(sessionId));
    });
    for (const [event, handle] of [
      ["Browser.downloadWillBegin", "begin"],
      ["Browser.downloadProgress", "progress"],
    ] as const) {
      this.#broker.on(event, (params, sessionId) => {
        if (sessionId !== undefined || !this.options.downloads)
          throw new BrowserTargetError("protocol");
        this.options.downloads[handle](params);
      });
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  start(): Promise<void> {
    if (this.#started) return this.#started;
    if (this.#closed) return Promise.reject(new BrowserTargetError("closed"));
    this.#started = this.#start();
    return this.#started;
  }

  tabs(): readonly { readonly id: string; readonly ready: boolean }[] {
    this.#checkOpen();
    return Object.freeze(
      [...this.#targets.values()]
        .filter((target) => target.type === "page")
        .map((target) => Object.freeze({ id: target.tabId, ready: target.ready })),
    );
  }

  documents(tabId: string): readonly BrowserDocument[] {
    const root = this.#tab(tabId);
    const family = this.#readyFamily(root);
    return Object.freeze(
      family.map((target) => {
        const handle = Object.freeze({
          tabId,
          revision: target.revision,
          frame: target !== root,
        });
        this.#documents.set(handle, { target, revision: target.revision });
        return handle;
      }),
    );
  }

  check(document: BrowserDocument): void {
    this.#document(document);
  }

  fileChooser(tabId: string): Readonly<BrowserUploadChooser> | undefined {
    const family = this.#readyFamily(this.#tab(tabId));
    const chooser = this.#fileChooser;
    if (!chooser || chooser.claimed || !family.includes(chooser.target)) return undefined;
    if (chooser.target.revision !== chooser.revision || chooser.abort.signal.aborted)
      return undefined;
    return chooser.info;
  }

  claimFileChooser(tabId: string, id: string): BrowserFileChooser {
    const info = this.fileChooser(tabId),
      chooser = this.#fileChooser;
    if (!info || info.id !== id || !chooser) throw new BrowserTargetError("stale");
    const document = this.documents(tabId).find(
      (handle) => this.#documents.get(handle)?.target === chooser.target,
    );
    if (!document) throw new BrowserTargetError("stale");
    chooser.claimed = true;
    const handle = Object.freeze({ ...info, document, signal: chooser.abort.signal });
    this.#fileChoosers.set(handle, chooser);
    return handle;
  }

  async fileChooserOffer(
    tabId: string,
    signal: AbortSignal,
  ): Promise<Readonly<BrowserUploadOffer> | undefined> {
    signal.throwIfAborted();
    const info = this.fileChooser(tabId),
      chooser = this.#fileChooser;
    if (!info || !chooser) return undefined;
    return this.#chooserOffer(chooser, signal, () => {
      if (this.fileChooser(tabId) !== info) throw new BrowserTargetError("stale");
    });
  }

  async claimedFileChooserOffer(
    handle: BrowserFileChooser,
    signal: AbortSignal,
  ): Promise<Readonly<BrowserUploadOffer>> {
    this.checkFileChooser(handle);
    const chooser = this.#fileChoosers.get(handle);
    if (!chooser) throw new BrowserTargetError("stale");
    return this.#chooserOffer(chooser, signal, () => this.checkFileChooser(handle));
  }

  async #chooserOffer(
    chooser: FileChooserRecord,
    signal: AbortSignal,
    check: () => void,
  ): Promise<Readonly<BrowserUploadOffer>> {
    const current = AbortSignal.any([signal, chooser.abort.signal]);
    current.throwIfAborted();
    check();
    const result = await this.#broker.send(
      "Page.getFrameTree",
      {},
      {
        sessionId: chooser.target.sessionId,
        signal: current,
      },
    );
    current.throwIfAborted();
    check();
    const tree = schema.object({ frameTree: schema.unknown() }).parse(result).frameTree;
    const entry = schema.object({
      frame: schema.object({ id: identifier, securityOrigin: schema.string().max(512).optional() }),
      childFrames: schema.array(schema.unknown()).max(MAX_BROWSER_TARGETS).optional(),
    });
    const root = entry.parse(tree);
    const pending: unknown[] = [root];
    const seen = new Set<string>();
    let origin: string | undefined;
    while (pending.length) {
      if (seen.size >= MAX_BROWSER_TARGETS) throw new BrowserTargetError("protocol");
      const node = entry.parse(pending.pop());
      if (seen.has(node.frame.id)) throw new BrowserTargetError("protocol");
      seen.add(node.frame.id);
      if (node.frame.id === chooser.frameId) origin = node.frame.securityOrigin;
      pending.push(...(node.childFrames ?? []));
      if (pending.length + seen.size > MAX_BROWSER_TARGETS)
        throw new BrowserTargetError("protocol");
    }
    // An opaque, unknown or missing frame has no trustworthy destination to approve.
    const offer = BrowserUploadOffer.safeParse({
      ...chooser.info,
      origin,
      embedded: chooser.target.type === "iframe" || chooser.frameId !== root.frame.id,
    });
    if (!offer.success) throw new BrowserTargetError("protocol");
    return Object.freeze(offer.data);
  }

  checkFileChooser(handle: BrowserFileChooser): void {
    const chooser = this.#fileChoosers.get(handle);
    if (
      !chooser ||
      chooser !== this.#fileChooser ||
      !chooser.claimed ||
      chooser.abort.signal.aborted
    )
      throw new BrowserTargetError("stale");
    this.#document(handle.document);
    if (chooser.target.revision !== chooser.revision) throw new BrowserTargetError("stale");
  }

  // The caller is the private upload service, after it verifies its staged files.
  // The synchronous CDP guard consumes the exact file list once; command() cannot
  // borrow the receipt for another node, document, path or repeated effect.
  async fillFileChooser(
    handle: BrowserFileChooser,
    stagedFiles: readonly string[],
    scope: { signal: AbortSignal; check(): void },
  ): Promise<void> {
    this.checkFileChooser(handle);
    const chooser = this.#fileChoosers.get(handle);
    if (!chooser) throw new BrowserTargetError("stale");
    if (chooser.filling) throw new BrowserTargetError("busy");
    chooser.filling = true;
    const files = Object.freeze([...stagedFiles]);
    let completed = false;
    try {
      scope.signal.throwIfAborted();
      scope.check();
      this.checkFileChooser(handle);
      if (
        this.#uploadReceipt ||
        files.length < 1 ||
        files.length > 10 ||
        (chooser.info.mode === "single" && files.length !== 1)
      )
        throw new BrowserTargetError("protocol");
      this.#uploadReceipt = { chooser, files };
      await this.#broker.send(
        "DOM.setFileInputFiles",
        {
          backendNodeId: chooser.backendNodeId,
          files,
        },
        {
          sessionId: chooser.target.sessionId,
          signal: AbortSignal.any([scope.signal, handle.signal]),
        },
      );
      scope.check();
      this.checkFileChooser(handle);
      completed = true;
    } finally {
      this.#uploadReceipt = undefined;
      if (this.#fileChooser === chooser) {
        if (completed) {
          clearTimeout(this.#chooserTimer);
          this.#chooserTimer = undefined;
          this.#fileChooser = undefined;
        } else this.clearFileChooser();
      }
    }
  }

  clearFileChooser(): void {
    clearTimeout(this.#chooserTimer);
    this.#chooserTimer = undefined;
    const chooser = this.#fileChooser;
    this.#fileChooser = undefined;
    this.#uploadReceipt = undefined;
    chooser?.abort.abort(new BrowserTargetError("stale"));
  }

  rememberNodes(document: BrowserDocument, nodes: readonly number[]): void {
    const target = this.#document(document);
    if (
      nodes.length > MAX_DOCUMENT_NODES ||
      nodes.some((node) => !nodeNumber.safeParse(node).success)
    )
      throw new BrowserTargetError("protocol");
    const next = new Set([...target.nodes, ...nodes]);
    const otherNodes = [...this.#sessions.values()].reduce(
      (count, session) => count + (session === target ? 0 : session.nodes.size),
      0,
    );
    if (next.size > MAX_DOCUMENT_NODES || next.size + otherNodes > MAX_BROWSER_NODES)
      throw new BrowserTargetError("busy");
    target.nodes = next;
  }

  async command(
    document: BrowserDocument,
    method: string,
    params: unknown = {},
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>> {
    const target = this.#document(document);
    const result = await this.#broker.send(method, params, {
      sessionId: target.sessionId,
      signal,
    });
    this.#document(document);
    return result;
  }

  async activate(tabId: string, signal?: AbortSignal): Promise<void> {
    const target = this.#tab(tabId);
    await this.#broker.send("Target.activateTarget", { targetId: target.targetId }, { signal });
    this.#sameTab(target);
  }

  async reload(tabId: string, signal?: AbortSignal): Promise<void> {
    const target = this.#tab(tabId);
    if (signal?.aborted) throw new BrowserTargetError("stale");
    if (this.#reloads.has(target)) throw new BrowserTargetError("busy");
    this.#readyFamily(target);
    const loaded = Promise.withResolvers<void>();
    void loaded.promise.catch(() => {});
    const lifetime = new AbortController();
    let refusal: BrowserTargetError | undefined;
    const refuse = (reason: "stale" | "unready") => {
      refusal ??= new BrowserTargetError(reason);
      loaded.reject(refusal);
      lifetime.abort();
    };
    const cancel = () => refuse("stale");
    const timeout = setTimeout(() => refuse("unready"), BROWSER_RELOAD_TIMEOUT_MS);
    const unsubscribe: (() => void)[] = [];
    let navigated = false;
    this.#reloads.set(target, cancel);
    try {
      unsubscribe.push(
        this.#broker.on("Page.frameNavigated", (params, sessionId) => {
          if (sessionId !== target.sessionId) return;
          const frame = schema
            .object({ frame: schema.object({ parentId: identifier.optional() }) })
            .parse(params).frame;
          if (!frame.parentId) {
            if (navigated) refuse("stale");
            navigated = true;
          }
        }),
      );
      unsubscribe.push(
        this.#broker.on("Page.loadEventFired", (_params, sessionId) => {
          if (sessionId === target.sessionId && navigated) loaded.resolve();
        }),
      );
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      await Promise.all([
        this.#broker.send(
          "Page.reload",
          { ignoreCache: true },
          { sessionId: target.sessionId, signal: lifetime.signal },
        ),
        loaded.promise,
      ]);
      if (refusal) throw refusal;
      if (signal?.aborted) throw new BrowserTargetError("stale");
      this.#sameTab(target);
      this.#readyFamily(target);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      for (const dispose of unsubscribe) dispose();
      this.#reloads.delete(target);
    }
  }

  async navigate(tabId: string, url: string, signal?: AbortSignal): Promise<void> {
    const target = this.#tab(tabId);
    if (this.#reloads.has(target)) throw new BrowserTargetError("busy");
    this.#readyFamily(target);
    const revision = target.revision;
    const lifetime = new AbortController();
    const cancel = () => lifetime.abort();
    this.#reloads.set(target, cancel);
    try {
      await navigateOwnedDocument({
        broker: this.#broker,
        sessionId: target.sessionId as string,
        url,
        signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
        check: () => {
          this.#sameTab(target);
          this.#readyFamily(target);
        },
        preflight: () => {
          this.#sameTab(target);
          this.#readyFamily(target);
          if (target.revision !== revision) throw new BrowserTargetError("stale");
        },
        ambiguous: () => this.#fail("unready"),
      });
    } finally {
      this.#reloads.delete(target);
    }
  }

  async window(tabId: string, signal?: AbortSignal) {
    const target = this.#tab(tabId);
    const result = await this.#broker.send(
      "Browser.getWindowForTarget",
      { targetId: target.targetId },
      { signal },
    );
    this.#sameTab(target);
    const parsed = schema
      .object({
        windowId: nodeNumber,
        bounds: schema.object({
          left: schema.number().int().min(-8192).max(8192),
          top: schema.number().int().min(-8192).max(8192),
          width: schema.number().int().positive().max(8192),
          height: schema.number().int().positive().max(8192),
          windowState: schema.enum(["normal", "minimized", "maximized", "fullscreen"]),
        }),
      })
      .safeParse(result);
    if (!parsed.success) {
      this.#fail("protocol");
      throw new BrowserTargetError("protocol");
    }
    target.windowId = parsed.data.windowId;
    return Object.freeze(parsed.data.bounds);
  }

  async maximize(tabId: string, signal?: AbortSignal): Promise<void> {
    await this.window(tabId, signal);
    const target = this.#tab(tabId);
    await this.#broker.send(
      "Browser.setWindowBounds",
      { windowId: target.windowId, bounds: { windowState: "maximized" } },
      { signal },
    );
    this.#sameTab(target);
  }

  close(): void {
    this.#fail("closed");
  }

  async downloadBehavior(enabled: boolean, signal?: AbortSignal): Promise<void> {
    this.#checkOpen();
    if (enabled && !this.options.downloads) throw new BrowserTargetError("unready");
    await this.#broker.send(
      "Browser.setDownloadBehavior",
      enabled
        ? { behavior: "allowAndName", downloadPath: this.options.downloadDir, eventsEnabled: true }
        : { behavior: "deny", eventsEnabled: true },
      { signal },
    );
    this.#checkOpen();
  }

  // Names and scopes only: cookie values never leave Chromium through browserd.
  async cookies(): Promise<readonly BrowserCookie[]> {
    this.#checkOpen();
    const parsed = cookieList.safeParse(await this.#broker.send("Storage.getCookies", {}));
    this.#checkOpen();
    if (!parsed.success) throw new BrowserTargetError("protocol");
    return parsed.data.cookies.map(({ name, domain, path, partitionKey }) => ({
      name,
      domain,
      path,
      ...(partitionKey ? { partitionKey } : {}),
    }));
  }

  async cancelDownload(guid: string, signal?: AbortSignal): Promise<void> {
    this.#checkOpen();
    await this.#broker.send("Browser.cancelDownload", { guid }, { signal });
    this.#checkOpen();
  }

  retire(): boolean {
    return this.#fail("closed", true);
  }

  async #start(): Promise<void> {
    const timeout = setTimeout(() => this.#fail("unready"), BROWSER_TARGET_START_TIMEOUT_MS);
    try {
      await this.downloadBehavior(false);
      await this.#broker.send("Target.setDiscoverTargets", { discover: true, filter });
      await this.#broker.send("Target.setAutoAttach", attachOptions);
      await this.#waitIdle();
      this.#checkOpen();
      if (![...this.#targets.values()].some((target) => target.type === "page" && target.ready))
        throw new BrowserTargetError("unready");
    } catch {
      this.#fail("unready");
      throw new BrowserTargetError("unready");
    } finally {
      clearTimeout(timeout);
    }
  }

  #discover(info: schema.infer<typeof targetInfo>): TargetRecord {
    this.#checkOpen();
    const existing = this.#targets.get(info.targetId);
    if (existing) {
      if (existing.type !== info.type) throw new BrowserTargetError("protocol");
      return existing;
    }
    if (this.#targets.size >= MAX_BROWSER_TARGETS) throw new BrowserTargetError("busy");
    const target: TargetRecord = {
      targetId: info.targetId,
      type: info.type,
      tabId: randomUUID(),
      ready: false,
      revision: 0,
      nodes: new Set(),
    };
    this.#targets.set(info.targetId, target);
    if (target.type === "iframe") {
      this.#revoke(this.#targets.values());
      this.options.onInvalidated?.();
    }
    return target;
  }

  #attach(
    sessionId: string,
    info: schema.infer<typeof targetInfo>,
    parentSessionId?: string,
  ): void {
    const parent = parentSessionId ? this.#ownedSession(parentSessionId) : undefined;
    if (info.type === "iframe" && !parent) throw new BrowserTargetError("protocol");
    const target = this.#discover(info);
    this.#checkOpen();
    if (this.#targets.get(target.targetId) !== target) return;
    if (parent && !this.#current(parent)) {
      this.#remove(target);
      return;
    }
    if (this.#sessions.has(sessionId)) {
      if (this.#sessions.get(sessionId) === target && target.parentSessionId === parentSessionId)
        return;
      throw new BrowserTargetError("protocol");
    }
    if (target.sessionId || target === parent) throw new BrowserTargetError("protocol");
    target.sessionId = sessionId;
    target.parentSessionId = parentSessionId;
    this.#sessions.set(sessionId, target);
    if (parent) this.#invalidate(parent);
    if (this.#closed || !this.#current(target)) return;
    if (this.#queue.length >= MAX_BROWSER_TARGETS) throw new BrowserTargetError("busy");
    this.#queue.push(target);
    this.#pump();
  }

  #pump(): void {
    while (!this.#closed && this.#workers < 4 && this.#queue.length > 0) {
      const target = this.#queue.shift();
      if (!target || !this.#current(target)) continue;
      this.#workers += 1;
      void this.#initialize(target)
        .catch(() => this.#fail("unready"))
        .finally(() => {
          this.#workers -= 1;
          this.#pump();
        });
    }
    if (this.#closed || (this.#workers === 0 && this.#queue.length === 0)) {
      for (const resolve of this.#idle) resolve();
      this.#idle.clear();
    }
  }

  async #initialize(target: TargetRecord): Promise<void> {
    for (const [method, params] of [
      ["Target.setAutoAttach", attachOptions],
      ["Page.enable", {}],
      ["DOM.enable", {}],
      ["Accessibility.enable", {}],
      ["Page.setInterceptFileChooserDialog", { enabled: true }],
      ["Runtime.runIfWaitingForDebugger", {}],
    ] as const) {
      this.#checkOpen();
      if (!this.#current(target)) return;
      await this.#broker.send(method, params, { sessionId: target.sessionId });
    }
    if (this.#current(target) && !this.#closed) target.ready = true;
  }

  #waitIdle(): Promise<void> {
    if (this.#closed || (this.#workers === 0 && this.#queue.length === 0)) return Promise.resolve();
    return new Promise((resolve) => this.#idle.add(resolve));
  }

  #family(root: TargetRecord): TargetRecord[] {
    const family = [root];
    for (let index = 0; index < family.length; index += 1) {
      const parent = family[index];
      if (!parent?.sessionId) continue;
      for (const target of this.#targets.values()) {
        if (target.type === "iframe" && target.parentSessionId === parent.sessionId)
          family.push(target);
      }
    }
    return family;
  }

  #readyFamily(root: TargetRecord): TargetRecord[] {
    this.#checkOpen();
    const family = this.#family(root);
    if (
      family.some((target) => !target.ready || !this.#current(target)) ||
      [...this.#targets.values()].some((target) => target.type === "iframe" && !target.sessionId)
    )
      throw new BrowserTargetError("unready");
    return family;
  }

  #affected(target: TargetRecord): Set<TargetRecord> {
    const affected = new Set(this.#family(target));
    let parent = target.parentSessionId ? this.#sessions.get(target.parentSessionId) : undefined;
    while (parent) {
      affected.add(parent);
      parent = parent.parentSessionId ? this.#sessions.get(parent.parentSessionId) : undefined;
    }
    return affected;
  }

  #revoke(affected: Iterable<TargetRecord>): void {
    for (const member of affected) {
      if (this.#fileChooser?.target === member) this.clearFileChooser();
      if (!Number.isSafeInteger(member.revision + 1)) throw new BrowserTargetError("protocol");
      member.revision += 1;
      member.nodes.clear();
    }
  }

  #invalidate(target: TargetRecord): void {
    this.#revoke(this.#affected(target));
    this.options.onInvalidated?.();
  }

  #remove(target: TargetRecord): void {
    const removed = [target];
    for (let index = 0; index < removed.length; index += 1) {
      const parent = removed[index];
      if (!parent?.sessionId) continue;
      for (const child of this.#targets.values()) {
        if (child.parentSessionId === parent.sessionId) removed.push(child);
      }
    }
    const affected = this.#affected(target);
    for (const member of removed) affected.add(member);
    this.#revoke(affected);
    for (const member of removed) {
      this.#reloads.get(member)?.();
      member.ready = false;
      member.nodes.clear();
      if (member.sessionId) this.#sessions.delete(member.sessionId);
      this.#targets.delete(member.targetId);
    }
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      const queued = this.#queue[index];
      if (!queued || !this.#current(queued)) this.#queue.splice(index, 1);
    }
    this.options.onInvalidated?.();
    this.#pump();
  }

  #document(document: BrowserDocument): TargetRecord {
    this.#checkOpen();
    const entry = this.#documents.get(document);
    if (
      !entry?.target.ready ||
      !this.#current(entry.target) ||
      entry.target.revision !== entry.revision
    )
      throw new BrowserTargetError("stale");
    if (!this.#readyFamily(this.#tab(document.tabId)).includes(entry.target))
      throw new BrowserTargetError("stale");
    return entry.target;
  }

  #tab(tabId: string): TargetRecord {
    this.#checkOpen();
    const target = [...this.#targets.values()].find(
      (candidate) => candidate.type === "page" && candidate.tabId === tabId,
    );
    if (!target) throw new BrowserTargetError("stale");
    if (!target.ready) throw new BrowserTargetError("unready");
    return target;
  }

  #sameTab(target: TargetRecord): void {
    this.#checkOpen();
    if (!this.#current(target)) throw new BrowserTargetError("stale");
  }

  #current(target: TargetRecord): boolean {
    return (
      this.#targets.get(target.targetId) === target &&
      target.sessionId !== undefined &&
      this.#sessions.get(target.sessionId) === target
    );
  }

  #ownedSession(sessionId?: string): TargetRecord {
    const target = sessionId ? this.#sessions.get(sessionId) : undefined;
    if (!target) throw new BrowserTargetError("protocol");
    return target;
  }

  #checkOpen(): void {
    if (this.#closed) throw new BrowserTargetError("closed");
  }

  #fail(reason: BrowserTargetError["reason"], retire = false): boolean {
    if (this.#closed) return false;
    this.#closed = true;
    // Retire the broker before cancelling pending reloads can hard-close its pipe.
    const retiring = retire && this.#broker.retire();
    this.clearFileChooser();
    for (const cancel of this.#reloads.values()) cancel();
    this.#reloads.clear();
    for (const target of this.#targets.values()) target.nodes.clear();
    this.#targets.clear();
    this.#sessions.clear();
    this.#queue.length = 0;
    try {
      this.options.onFatal(new BrowserTargetError(reason));
    } catch {}
    if (!retire) this.#broker.close();
    for (const resolve of this.#idle) resolve();
    this.#idle.clear();
    return retiring;
  }
}
