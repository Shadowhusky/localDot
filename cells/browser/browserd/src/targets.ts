import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { z as schema } from "zod";
import {
  type BrowserUploadChooser,
  BrowserUploadOffer,
} from "../../../../packages/protocol/src/browser-uploads.ts";
import { CdpRequestError, GuardedCdp } from "./cdp.ts";
import { cookiePartitionKey } from "./cdp-guard.ts";
import { navigateOwnedDocument } from "./navigation.ts";
import type { CdpTransport } from "./pipe.ts";

export const MAX_BROWSER_TARGETS = 256;
export const MAX_DOCUMENT_NODES = 4096;
export const MAX_BROWSER_NODES = 32768;
export const BROWSER_TARGET_START_TIMEOUT_MS = 30_000;
export const BROWSER_RELOAD_TIMEOUT_MS = 3000;
export const BROWSER_CHOOSER_TIMEOUT_MS = 5 * 60_000;
// A crashed tab is reloaded at most this many times a minute; one that keeps crashing stays on
// its error page.
export const BROWSER_CRASH_RELOADS = 3;
export const BROWSER_CRASH_WINDOW_MS = 60_000;
// Opening a blank tab keeps this many tabs, itself included, closing the oldest others: every tab
// is read for each action's page geometry, and a background page still loads frames and memory.
export const BROWSER_KEPT_TABS = 4;
export const BROWSER_TAB_OPEN_TIMEOUT_MS = 5000;
const BROWSER_WINDOW_PLACE_ATTEMPTS = 20;
const BROWSER_WINDOW_PLACE_RETRY_MS = 50;

const identifier = schema.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u);
const nodeNumber = schema.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const targetInfo = schema.object({
  targetId: identifier,
  type: schema.enum(["page", "iframe"]),
  title: schema.string().max(8192),
  url: schema.string().max(32768),
  attached: schema.boolean(),
  openerId: identifier.optional(),
  parentId: identifier.optional(),
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
  constructor(
    readonly reason: "closed" | "protocol" | "busy" | "stale" | "unready",
    // What ended the connection, for the log: a fixed phrase, never page data.
    readonly cause?: string,
  ) {
    super(`Browser target refused: ${reason}`);
  }
}

// Chromium's renderer termination status, which names no page.
function crashStatus(status: string | undefined): string {
  return status && /^[a-z][a-z ]{0,31}$/u.test(status) ? status : "unknown";
}

// A page that adds frames or rewrites its URL as it settles changes its document under a read, or
// still attaches a frame: the same read a moment later can succeed.
export const PAGE_READ_ATTEMPTS = 5;
export const PAGE_READ_RETRY_MS = 150;
export function pageChanged(error: unknown): boolean {
  return (
    error instanceof BrowserTargetError && (error.reason === "stale" || error.reason === "unready")
  );
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
  timer?: ReturnType<typeof setTimeout>;
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
  // The tab whose page opened this one.
  openerId?: string;
  // The target a frame was discovered in, before it attaches.
  parentId?: string;
  // Every frame of the target, to tell which tab a download came from.
  frames: Set<string>;
  crashes?: number[];
}

interface DocumentRecord {
  target: TargetRecord;
  revision: number;
}

export interface BrowserPage {
  readonly id: string;
  readonly ready: boolean;
  readonly windowId?: number;
  readonly opener?: string;
}

export interface BrowserTargetsOptions {
  readonly downloadDir: string;
  readonly uploadDir: string;
  onFatal(reason: BrowserTargetError): void;
  onInvalidated?(): void;
  onCrash?(crash: { readonly status: string; readonly reloaded: boolean }): void;
  // Another task is at work in the browser beside this tab: a navigation in doubt closes the tab
  // instead of ending the connection every task uses.
  shared?(tabId: string): boolean;
  readonly downloads?: {
    owns(guid: string): boolean;
    begin(params: Readonly<Record<string, unknown>>): void;
    progress(params: Readonly<Record<string, unknown>>): void;
  };
}

export class BrowserTargets {
  readonly #broker: GuardedCdp;
  readonly #targets = new Map<string, TargetRecord>();
  // The tabs openTab made, which only it closes.
  readonly #ours = new Set<string>();
  readonly #sessions = new Map<string, TargetRecord>();
  readonly #documents = new WeakMap<BrowserDocument, DocumentRecord>();
  readonly #queue: TargetRecord[] = [];
  readonly #idle = new Set<() => void>();
  readonly #reloads = new Map<TargetRecord, () => void>();
  readonly #recovering = new Map<TargetRecord, { status?: string; reloaded: boolean }>();
  readonly #fileChoosers = new WeakMap<BrowserFileChooser, FileChooserRecord>();
  // A tab's open chooser, by the tab: a task's chooser outlasts another task's.
  readonly #openChoosers = new Map<TargetRecord, FileChooserRecord>();
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
            [...this.#openChoosers.values()].some(
              (chooser) =>
                chooser.target.sessionId === sessionId && chooser.backendNodeId === backendNodeId,
            )),
        ownsDownload: (guid) => !this.#closed && this.options.downloads?.owns(guid) === true,
        allowsUpload: (sessionId, backendNodeId, files) => {
          const receipt = this.#uploadReceipt;
          if (
            !receipt ||
            !receipt.chooser.filling ||
            !this.#chooserOpen(receipt.chooser) ||
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
      (error) =>
        this.#fail(
          "closed",
          false,
          `control ${error.reason}${error.method ? ` (${error.method})` : ""}`,
        ),
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
      const crashed = schema
        .object({ targetId: identifier, status: schema.string().max(64).optional() })
        .parse(params);
      const target = this.#targets.get(crashed.targetId);
      if (!target) throw new BrowserTargetError("protocol");
      this.#crashed(target, crashed.status);
    });
    this.#broker.on("Inspector.targetCrashed", (_params, sessionId) => {
      this.#crashed(this.#ownedSession(sessionId));
    });
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
      this.#clearChooser(this.#openChoosers.get(this.#tabOf(target)));
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
      this.#openChoosers.set(this.#tabOf(target), chooser);
      chooser.timer = setTimeout(() => this.#clearChooser(chooser), BROWSER_CHOOSER_TIMEOUT_MS);
      chooser.timer.unref();
    });
    this.#broker.on("DOM.documentUpdated", (_params, sessionId) => {
      this.#invalidate(this.#ownedSession(sessionId));
    });
    this.#broker.on("Page.frameNavigated", (params, sessionId) => {
      const { frame } = schema.object({ frame: schema.object({ id: identifier }) }).parse(params);
      const target = this.#ownedSession(sessionId);
      this.#noteFrame(target, frame.id);
      this.#invalidate(target);
    });
    this.#broker.on("Page.frameAttached", (params, sessionId) => {
      const { frameId } = schema
        .object({ frameId: identifier, parentFrameId: identifier })
        .parse(params);
      const target = this.#ownedSession(sessionId);
      this.#noteFrame(target, frameId);
      this.#invalidate(target);
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

  // The tabs with the window each is in and the tab that opened it.
  pages(): readonly BrowserPage[] {
    this.#checkOpen();
    return Object.freeze(
      [...this.#targets.values()]
        .filter((target) => target.type === "page")
        .map((target) => {
          const opener = target.openerId ? this.#targets.get(target.openerId) : undefined;
          return Object.freeze({
            id: target.tabId,
            ready: target.ready,
            ...(target.windowId === undefined ? {} : { windowId: target.windowId }),
            ...(opener ? { opener: opener.tabId } : {}),
          });
        }),
    );
  }

  // The tabs in the same window as this one, itself included.
  tabsBeside(tabId: string): readonly { readonly id: string; readonly ready: boolean }[] {
    const tab = this.#tab(tabId);
    return Object.freeze(
      [...this.#targets.values()]
        .filter((target) => target.type === "page" && target.windowId === tab.windowId)
        .map((target) => Object.freeze({ id: target.tabId, ready: target.ready })),
    );
  }

  windowOf(tabId: string): number | undefined {
    return this.#tab(tabId).windowId;
  }

  // The tab a download's frame is in.
  tabOfFrame(frameId: string): string | undefined {
    for (const target of this.#targets.values())
      if (target.targetId === frameId || target.frames.has(frameId))
        return this.#tabOf(target).tabId;
    return undefined;
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
    const tab = this.#tab(tabId);
    const family = this.#readyFamily(tab);
    const chooser = this.#openChoosers.get(tab);
    if (!chooser || chooser.claimed || !family.includes(chooser.target)) return undefined;
    if (chooser.target.revision !== chooser.revision || chooser.abort.signal.aborted)
      return undefined;
    return chooser.info;
  }

  claimFileChooser(tabId: string, id: string): BrowserFileChooser {
    const info = this.fileChooser(tabId),
      chooser = this.#openChoosers.get(this.#tab(tabId));
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
      chooser = this.#openChoosers.get(this.#tab(tabId));
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
    if (!chooser || !this.#chooserOpen(chooser) || !chooser.claimed || chooser.abort.signal.aborted)
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
      if (this.#chooserOpen(chooser)) {
        if (completed) {
          clearTimeout(chooser.timer);
          this.#openChoosers.delete(this.#tabOf(chooser.target));
        } else this.#clearChooser(chooser);
      }
    }
  }

  // The tab's open chooser; every tab's without one.
  clearFileChooser(tabId?: string): void {
    const choosers =
      tabId === undefined
        ? [...this.#openChoosers.values()]
        : [this.#openChoosers.get(this.#tab(tabId))];
    for (const chooser of choosers) this.#clearChooser(chooser);
    if (tabId === undefined) this.#uploadReceipt = undefined;
  }

  #clearChooser(chooser: FileChooserRecord | undefined): void {
    if (!chooser) return;
    clearTimeout(chooser.timer);
    for (const [tab, open] of this.#openChoosers)
      if (open === chooser) this.#openChoosers.delete(tab);
    if (this.#uploadReceipt?.chooser === chooser) this.#uploadReceipt = undefined;
    chooser.abort.abort(new BrowserTargetError("stale"));
  }

  #chooserOpen(chooser: FileChooserRecord): boolean {
    return [...this.#openChoosers.values()].includes(chooser);
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

  // A task's own window, blank, in front and maximized as the first window is.
  async openWindow(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    this.#checkOpen();
    const created = schema
      .object({ targetId: identifier })
      .safeParse(
        await this.#broker.send("Target.createTarget", { url: "about:blank", newWindow: true }),
      );
    if (!created.success) throw new BrowserTargetError("protocol");
    this.#ours.add(created.data.targetId);
    const opened = await this.#opened(created.data.targetId, signal);
    await this.maximize(opened.tabId);
    return opened.tabId;
  }

  // A new window's keyboard focus is in its address bar, and its blank page is one Chromium's
  // accessibility has not seen: both are put right as for the first window and a new tab.
  async settleNewWindow(tabId: string): Promise<void> {
    const target = this.#tab(tabId);
    await this.activate(tabId);
    await this.#broker.send("Page.bringToFront", {}, { sessionId: target.sessionId });
    await this.#layOut(target);
  }

  async closeTab(tabId: string): Promise<void> {
    const target = this.#tab(tabId);
    await this.#broker.send("Target.closeTarget", { targetId: target.targetId });
  }

  // A blank tab in front of the others in its window: the blank tab already open there, else a new
  // one. Page geometry tells a window's tabs apart by address, so its other blank tabs close, as do
  // the oldest of the tabs opened here past BROWSER_KEPT_TABS; tabs the user or a page opened stay.
  // A new tab lands in the window in front, which is the caller's. Cancelling stops between
  // Chromium commands: abandoning one fences them all.
  async openTab(signal: AbortSignal, near?: string): Promise<string> {
    signal.throwIfAborted();
    this.#checkOpen();
    const windowId = near === undefined ? undefined : this.#tab(near).windowId;
    const here = (target: TargetRecord) => near === undefined || target.windowId === windowId;
    const listed = schema
      .object({ targetInfos: schema.array(targetInfo).max(MAX_BROWSER_TARGETS) })
      .safeParse(await this.#broker.send("Target.getTargets", { filter }));
    if (!listed.success) throw new BrowserTargetError("protocol");
    const blank = new Set(
      listed.data.targetInfos
        .filter((info) => info.type === "page" && info.url === "about:blank")
        .map((info) => info.targetId),
    );
    const tabs = () =>
      [...this.#targets.values()].filter((target) => target.type === "page" && here(target));
    let front = tabs().findLast(
      (target) => blank.has(target.targetId) && target.ready && this.#current(target),
    );
    if (!front) {
      signal.throwIfAborted();
      const created = schema
        .object({ targetId: identifier })
        .safeParse(await this.#broker.send("Target.createTarget", { url: "about:blank" }));
      if (!created.success) throw new BrowserTargetError("protocol");
      this.#ours.add(created.data.targetId);
      front = await this.#opened(created.data.targetId, signal);
      if (!here(front)) {
        await this.#broker.send("Target.closeTarget", { targetId: created.data.targetId });
        throw new BrowserTargetError("stale");
      }
    }
    for (const id of this.#ours) if (!this.#targets.has(id)) this.#ours.delete(id);
    const others = tabs().filter((target) => target !== front);
    const earlier = others.filter(
      (target) => !blank.has(target.targetId) && this.#ours.has(target.targetId),
    );
    for (const target of [
      ...others.filter((target) => blank.has(target.targetId)),
      ...earlier.slice(0, Math.max(0, earlier.length + 1 - BROWSER_KEPT_TABS)),
    ]) {
      signal.throwIfAborted();
      if (this.#targets.get(target.targetId) === target)
        await this.#broker.send("Target.closeTarget", { targetId: target.targetId });
    }
    signal.throwIfAborted();
    await this.activate(front.tabId);
    await this.#layOut(front);
    return front.tabId;
  }

  // Chromium's accessibility attaches to an about:blank document after it has loaded and misses it
  // until its layout changes, so the native surface can't see the tab: a viewport a pixel shorter,
  // then the real one, lays it out again.
  async #layOut(target: TargetRecord): Promise<void> {
    const options = { sessionId: target.sessionId };
    const metrics = schema
      .object({
        cssLayoutViewport: schema.object({
          clientWidth: schema.number().min(2).max(8192),
          clientHeight: schema.number().min(2).max(8192),
        }),
      })
      .safeParse(await this.#broker.send("Page.getLayoutMetrics", {}, options));
    if (!metrics.success) throw new BrowserTargetError("protocol");
    const { clientWidth, clientHeight } = metrics.data.cssLayoutViewport;
    await this.#broker.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width: Math.round(clientWidth),
        height: Math.round(clientHeight) - 1,
        deviceScaleFactor: 0,
        mobile: false,
      },
      options,
    );
    try {
      await this.#broker.send("Page.getLayoutMetrics", {}, options);
    } finally {
      await this.#broker.send("Emulation.clearDeviceMetricsOverride", {}, options);
    }
    this.#sameTab(target);
  }

  async #opened(targetId: string, signal: AbortSignal): Promise<TargetRecord> {
    for (const deadline = performance.now() + BROWSER_TAB_OPEN_TIMEOUT_MS; ; ) {
      this.#checkOpen();
      const target = this.#targets.get(targetId);
      if (target?.type === "page" && target.ready && this.#current(target)) return target;
      if (performance.now() >= deadline) throw new BrowserTargetError("unready");
      await sleep(25, undefined, { signal });
    }
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

  async navigate(tabId: string, url: string, signal?: AbortSignal): Promise<"download" | void> {
    const target = this.#tab(tabId);
    if (this.#reloads.has(target)) throw new BrowserTargetError("busy");
    this.#readyFamily(target);
    const revision = target.revision;
    const lifetime = new AbortController();
    const cancel = () => lifetime.abort();
    this.#reloads.set(target, cancel);
    try {
      return await navigateOwnedDocument({
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
        ambiguous: () => {
          if (!this.options.shared?.(target.tabId) || !this.#current(target))
            this.#fail("unready", false, "navigation outcome unknown");
          else
            void this.#broker
              .send("Target.closeTarget", { targetId: target.targetId })
              .catch(() => {});
        },
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
      this.#fail("protocol", false, "unexpected window reply");
      throw new BrowserTargetError("protocol");
    }
    target.windowId = parsed.data.windowId;
    return Object.freeze(parsed.data.bounds);
  }

  async maximize(tabId: string, signal?: AbortSignal): Promise<void> {
    await this.windowState(tabId, "maximized", signal);
  }

  async windowState(
    tabId: string,
    windowState: "maximized" | "minimized" | "normal",
    signal?: AbortSignal,
  ): Promise<void> {
    await this.window(tabId, signal);
    const target = this.#tab(tabId);
    await this.#broker.send(
      "Browser.setWindowBounds",
      { windowId: target.windowId, bounds: { windowState } },
      { signal },
    );
    this.#sameTab(target);
  }

  // A frozen page runs no timers, frames or loading. Chromium hides a page as it freezes it, and
  // waking it leaves it hidden until its window comes back on screen.
  async lifecycle(tabId: string, state: "frozen" | "active", signal?: AbortSignal): Promise<void> {
    const target = this.#tab(tabId);
    await this.#broker.send(
      "Page.setWebLifecycleState",
      { state },
      { sessionId: target.sessionId, signal },
    );
    this.#sameTab(target);
  }

  close(): void {
    this.#fail("closed");
  }

  // The browser process answers at all: a read of a tab's window that changes nothing, and whose
  // unanswered request does not fence the connection.
  async ping(signal: AbortSignal): Promise<void> {
    this.#checkOpen();
    const tab = [...this.#targets.values()].find((target) => target.type === "page");
    if (!tab) return;
    await this.#broker.send("Browser.getWindowForTarget", { targetId: tab.targetId }, { signal });
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
      frames: new Set(),
      ...(info.openerId ? { openerId: info.openerId } : {}),
      ...(info.parentId ? { parentId: info.parentId } : {}),
    };
    this.#targets.set(info.targetId, target);
    if (target.type === "iframe") {
      // A new frame changes the page it is in; only a frame that names no page changes them all.
      const parent = info.parentId ? this.#targets.get(info.parentId) : undefined;
      this.#revoke(parent ? this.#affected(parent) : [...this.#targets.values()]);
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
    this.#broker.attachSession(sessionId);
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
        .catch(() => {
          // A sign-in frame may disappear while its initialization is in flight.
          // Removal already revoked that session; healthy tabs remain usable.
          if (this.#current(target)) this.#fail("unready", false, "a tab could not be attached");
        })
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
    if (target.type === "page") await this.#placeInWindow(target);
    if (this.#current(target) && !this.#closed) target.ready = true;
  }

  // A popup's window may come a moment after its page: Chromium refuses until then. One that never
  // gets a window counts as in none.
  async #placeInWindow(target: TargetRecord): Promise<void> {
    for (let attempt = 0; attempt < BROWSER_WINDOW_PLACE_ATTEMPTS; attempt++) {
      if (attempt) await sleep(BROWSER_WINDOW_PLACE_RETRY_MS);
      if (!this.#current(target)) return;
      try {
        const reply = await this.#broker.send("Browser.getWindowForTarget", {
          targetId: target.targetId,
        });
        const placed = schema.object({ windowId: nodeNumber }).safeParse(reply);
        if (placed.success) target.windowId = placed.data.windowId;
        return;
      } catch (error) {
        if (!(error instanceof CdpRequestError) || error.reason !== "failed") throw error;
      }
    }
  }

  #noteFrame(target: TargetRecord, frameId: string): void {
    if (target.frames.size < MAX_BROWSER_TARGETS * 4) target.frames.add(frameId);
  }

  // The page a target is in.
  #tabOf(target: TargetRecord): TargetRecord {
    let tab = target;
    while (tab.type === "iframe" && tab.parentSessionId) {
      const parent = this.#sessions.get(tab.parentSessionId);
      if (!parent) break;
      tab = parent;
    }
    return tab;
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
      [...this.#targets.values()].some(
        (target) => target.type === "iframe" && !target.sessionId && this.#mayBeIn(target, family),
      )
    )
      throw new BrowserTargetError("unready");
    return family;
  }

  // A frame still attaching holds up the page it names; one that names none, every page.
  #mayBeIn(frame: TargetRecord, family: readonly TargetRecord[]): boolean {
    const parent = frame.parentId ? this.#targets.get(frame.parentId) : undefined;
    return !parent || family.includes(parent);
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
      for (const chooser of this.#openChoosers.values())
        if (chooser.target === member) this.#clearChooser(chooser);
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
    // Retire requests before revocation aborts chooser/reload work. Its cancellation must
    // not turn a target that Chromium has already closed into a whole-connection failure.
    for (const member of removed)
      if (member.sessionId) this.#broker.retireSession(member.sessionId);
    this.#revoke(affected);
    for (const member of removed) {
      this.#reloads.get(member)?.();
      this.#recovering.delete(member);
      member.ready = false;
      member.nodes.clear();
      if (member.sessionId) {
        this.#sessions.delete(member.sessionId);
      }
      this.#targets.delete(member.targetId);
    }
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      const queued = this.#queue[index];
      if (!queued || !this.#current(queued)) this.#queue.splice(index, 1);
    }
    this.options.onInvalidated?.();
    this.#pump();
  }

  // A renderer crash takes down its tab, not the browser: the tab's documents are revoked and
  // the tab reloaded, within a budget. A frame's crash reloads the tab that holds it.
  #crashed(target: TargetRecord, status?: string): void {
    let tab: TargetRecord | undefined = target;
    while (tab?.type === "iframe")
      tab = tab.parentSessionId ? this.#sessions.get(tab.parentSessionId) : undefined;
    if (!tab?.sessionId || !this.#current(tab)) return;
    // Chromium reports one crash twice, to the tab's session and to the browser, which names
    // the termination status.
    const reported = this.#recovering.get(tab);
    if (reported) {
      reported.status ??= status;
      return;
    }
    this.#reloads.get(tab)?.();
    this.#invalidate(tab);
    const now = performance.now();
    tab.crashes = [...(tab.crashes ?? []).filter((at) => now - at < BROWSER_CRASH_WINDOW_MS), now];
    const crash = { status, reloaded: tab.crashes.length <= BROWSER_CRASH_RELOADS };
    const recovering = tab;
    this.#recovering.set(recovering, crash);
    const reload = crash.reloaded
      ? this.#broker.send("Page.reload", {}, { sessionId: recovering.sessionId }).catch(() => {})
      : Promise.resolve();
    void Promise.all([reload, new Promise((resolve) => setTimeout(resolve, 100))]).then(() => {
      if (this.#recovering.get(recovering) !== crash) return;
      this.#recovering.delete(recovering);
      try {
        this.options.onCrash?.({ status: crashStatus(crash.status), reloaded: crash.reloaded });
      } catch {}
    });
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

  #fail(reason: BrowserTargetError["reason"], retire = false, cause?: string): boolean {
    if (this.#closed) return false;
    this.#closed = true;
    // Retire the broker before cancelling pending reloads can hard-close its pipe.
    const retiring = retire && this.#broker.retire();
    this.#uploadReceipt = undefined;
    for (const chooser of [...this.#openChoosers.values()]) this.#clearChooser(chooser);
    for (const cancel of this.#reloads.values()) cancel();
    this.#reloads.clear();
    this.#recovering.clear();
    for (const target of this.#targets.values()) target.nodes.clear();
    this.#targets.clear();
    this.#sessions.clear();
    this.#queue.length = 0;
    try {
      this.options.onFatal(new BrowserTargetError(reason, cause));
    } catch {}
    if (!retire) this.#broker.close();
    for (const resolve of this.#idle) resolve();
    this.#idle.clear();
    return retiring;
  }
}
