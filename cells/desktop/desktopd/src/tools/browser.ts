import { setTimeout as delay } from "node:timers/promises";
import {
  type BrowserNavigateResult,
  type BrowserPageResult,
  type BrowserReadResult,
  webUrl,
} from "@localdot/protocol";
import { WebSocket } from "ws";
import { CdpSession, type PageTarget, pickTarget } from "../perception/cdp.ts";
import type { HelperWindow } from "../perception/hit-test.ts";

export class NoPageError extends Error {
  constructor() {
    super("Chromium has no open page");
    this.name = "NoPageError";
  }
}

export interface BrowserOptions {
  port?: number;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
  loadTimeoutMs?: number;
  // The same native foreground Chromium window used by browser_act and pageElements.
  window?(signal: AbortSignal): Promise<HelperWindow | undefined>;
}

interface SelectedPage {
  target: PageTarget;
  windowId?: number;
  active?: boolean;
}

interface AxNode {
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
}

// Roles worth a line in the outline: what a person would point at or read as a heading.
const OUTLINE_ROLES = new Set([
  "heading",
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "tab",
  "menuitem",
  "option",
  "listbox",
  "switch",
  "slider",
  "image",
  "table",
  "row",
  "cell",
  "columnheader",
  "dialog",
  "alert",
]);
const OUTLINE_MAX_LINES = 400;

export function outlineOf(nodes: AxNode[]): string {
  const lines: string[] = [];
  for (const n of nodes) {
    const role = n.role?.value ?? "";
    const name = (n.name?.value ?? "").replace(/\s+/g, " ").trim();
    if (n.ignored || !OUTLINE_ROLES.has(role) || !name) continue;
    lines.push(`${role} "${name.slice(0, 120)}"`);
    if (lines.length >= OUTLINE_MAX_LINES) break;
  }
  return lines.join("\n");
}

function readExpression(maxChars: number): string {
  return `(() => { const text = document.body ? document.body.innerText : ""; return { url: location.href, title: document.title, text: text.slice(0, ${maxChars}), truncated: text.length > ${maxChars} }; })()`;
}
const STATE =
  "({ url: location.href, title: document.title, ready: document.readyState, origin: performance.timeOrigin })";

interface PageState {
  url: string;
  title: string;
  ready: string;
  origin: number;
}

export class NavigationError extends Error {
  constructor(reason: string) {
    super(`navigation failed: ${reason}`);
    this.name = "NavigationError";
  }
}

// CDP can publish a new title before the window manager does. This is a read-only
// identity check that can settle; it does not authorize a new target or another input.
class PageTitlePendingError extends NavigationError {
  constructor() {
    super("the visible Chromium page title is still settling");
  }
}

// The desktop's own Chromium, through its DevTools port on the cell's loopback (Part 3, D13):
// a fast read of the page the user sees, and navigation in that same tab.
export class PageBrowser {
  readonly #port: number;
  readonly #fetchImpl: typeof fetch;
  readonly #WebSocketImpl: typeof WebSocket;
  readonly #loadTimeoutMs: number;
  readonly #window: BrowserOptions["window"];

  constructor(opts: BrowserOptions = {}) {
    this.#port = opts.port ?? 9222;
    this.#fetchImpl = opts.fetchImpl ?? fetch;
    this.#WebSocketImpl = opts.WebSocketImpl ?? WebSocket;
    this.#loadTimeoutMs = opts.loadTimeoutMs ?? 10_000;
    this.#window = opts.window;
    if (
      !Number.isInteger(this.#port) ||
      this.#port < 1 ||
      this.#port > 65535 ||
      !Number.isFinite(this.#loadTimeoutMs) ||
      this.#loadTimeoutMs < 1 ||
      this.#loadTimeoutMs > 60_000
    ) {
      throw new RangeError("invalid browser options");
    }
  }

  // CDP target order is not tab focus. Match the native foreground browser; without
  // that identity only a single page can be selected, never an arbitrary background tab.
  async #page(signal: AbortSignal, expected?: SelectedPage): Promise<SelectedPage> {
    signal.throwIfAborted();
    try {
      const res = await this.#fetchImpl(`http://127.0.0.1:${this.#port}/json/list`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
        redirect: "error",
      });
      signal.throwIfAborted();
      if (!res.ok) throw new NoPageError();
      const targets: unknown = await res.json();
      signal.throwIfAborted();
      if (!Array.isArray(targets)) throw new NoPageError();
      const pages = targets.filter(
        (t) =>
          t &&
          typeof t === "object" &&
          t.type === "page" &&
          typeof t.id === "string" &&
          typeof t.title === "string" &&
          typeof t.url === "string" &&
          !t.url.startsWith("devtools://") &&
          typeof t.webSocketDebuggerUrl === "string",
      ) as PageTarget[];
      if (!pages.length) throw new NoPageError();
      let window: HelperWindow | undefined;
      try {
        window = await this.#window?.(signal);
      } catch {
        signal.throwIfAborted();
        throw new NavigationError("the visible Chromium window is unavailable");
      }
      signal.throwIfAborted();
      const page = this.#window
        ? window && pickTarget(pages, window)
        : pages.length === 1
          ? pages[0]
          : undefined;
      if (!page) {
        // During revalidation, wait only while the already admitted CDP target and
        // native window still exist and no page matches the native title. Once a
        // different tab matches, or identity becomes ambiguous, refuse immediately.
        if (
          expected &&
          window?.id === expected.windowId &&
          pages.some(
            (candidate) =>
              candidate.id === expected.target.id &&
              candidate.webSocketDebuggerUrl === expected.target.webSocketDebuggerUrl,
          ) &&
          window &&
          !pages.some((candidate) => candidate.title === window.title.replace(/ - Chromium$/, ""))
        )
          throw new PageTitlePendingError();
        throw new NavigationError("the visible Chromium page cannot be identified");
      }
      const socket = new URL(page.webSocketDebuggerUrl);
      if (
        socket.protocol !== "ws:" ||
        socket.hostname !== "127.0.0.1" ||
        socket.port !== String(this.#port) ||
        socket.username ||
        socket.password ||
        !socket.pathname.startsWith("/devtools/page/")
      )
        throw new NoPageError();
      return { target: page, ...(window ? { windowId: window.id, active: window.active } : {}) };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof NoPageError || error instanceof NavigationError) throw error;
      throw new NoPageError();
    }
  }

  async #samePage(selected: SelectedPage, signal: AbortSignal, focused = false): Promise<void> {
    // Native title/focus may settle after Chromium acknowledges navigation or
    // bringToFront. Wait briefly, but never change the admitted target or resend input.
    for (let attempt = 0; ; attempt++) {
      let current: SelectedPage;
      try {
        current = await this.#page(signal, selected);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof PageTitlePendingError && attempt < 10) {
          await delay(50, undefined, { signal });
          continue;
        }
        throw new NavigationError("the visible Chromium page changed; inspect it before retrying");
      }
      if (
        current.target.id !== selected.target.id ||
        current.target.webSocketDebuggerUrl !== selected.target.webSocketDebuggerUrl ||
        current.windowId !== selected.windowId
      )
        throw new NavigationError("the visible Chromium page changed; inspect it before retrying");
      if (!focused || !this.#window || current.active === true) return;
      if (attempt >= 10)
        throw new NavigationError("the visible Chromium window did not receive focus");
      await delay(50, undefined, { signal });
    }
  }

  async #with<T>(
    fn: (
      cdp: CdpSession,
      signal: AbortSignal,
      check: (focused?: boolean) => Promise<void>,
    ) => Promise<T>,
    parent?: AbortSignal,
  ): Promise<T> {
    parent?.throwIfAborted();
    const deadline = new AbortController();
    const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
    const timer = setTimeout(
      () => deadline.abort(new NavigationError("page operation timed out")),
      this.#loadTimeoutMs + 5000,
    );
    let cdp: CdpSession | undefined;
    let rejectAbort: ((reason: unknown) => void) | undefined;
    const abort = () => {
      cdp?.close();
      rejectAbort?.(signal.reason);
    };
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    signal.addEventListener("abort", abort, { once: true });
    const operation = (async () => {
      const page = await this.#page(signal);
      signal.throwIfAborted();
      cdp = new CdpSession(page.target.webSocketDebuggerUrl, this.#WebSocketImpl);
      await cdp.ready;
      signal.throwIfAborted();
      const check = (focused = false) => this.#samePage(page, signal, focused);
      await check();
      const result = await fn(cdp, signal, check);
      await check();
      return result;
    })();
    try {
      return await Promise.race([operation, cancelled]);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof Error && /^cdp: .*timed out$/.test(error.message))
        throw new NavigationError("page operation timed out");
      if (error instanceof Error && error.message.startsWith("cdp:"))
        throw new NavigationError("browser connection failed");
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      cdp?.close();
    }
  }

  // The front page's address from Chromium's target list: nothing runs in the page.
  async page(signal = AbortSignal.timeout(5000)): Promise<BrowserPageResult> {
    const page = await this.#page(signal);
    await this.#samePage(page, signal);
    return { url: page.target.url };
  }

  read(maxChars: number, signal?: AbortSignal): Promise<BrowserReadResult> {
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 100_000)
      return Promise.reject(new RangeError("invalid page text limit"));
    return this.#with(async (cdp, active) => {
      const r = await cdp.send<{
        result?: { value?: { url: string; title: string; text: string; truncated?: boolean } };
      }>("Runtime.evaluate", { expression: readExpression(maxChars), returnByValue: true });
      active.throwIfAborted();
      const page = r.result?.value;
      if (
        !page ||
        typeof page.url !== "string" ||
        typeof page.title !== "string" ||
        typeof page.text !== "string"
      )
        throw new NavigationError("could not read page");
      await cdp.send("Accessibility.enable").catch(() => undefined);
      active.throwIfAborted();
      const ax = await cdp
        .send<{ nodes?: AxNode[] }>("Accessibility.getFullAXTree", {}, 5000)
        .catch(() => ({ nodes: [] as AxNode[] }));
      active.throwIfAborted();
      return {
        url: page.url,
        title: page.title,
        text: page.text.slice(0, maxChars),
        outline: outlineOf(Array.isArray(ax.nodes) ? ax.nodes : []),
        truncated: page.truncated === true || page.text.length > maxChars,
      };
    }, signal);
  }

  // A new document needs a new timeOrigin. A same-document navigation instead requires Chromium
  // to report no loaderId and the requested URL to match the completed current document.
  navigate(raw: string, signal?: AbortSignal): Promise<BrowserNavigateResult> {
    const url = webUrl(raw);
    if (!url) return Promise.reject(new NavigationError("only http and https pages can be opened"));
    return this.#with(async (cdp, active, check) => {
      const probe = async (): Promise<PageState | undefined> => {
        active.throwIfAborted();
        const r = await cdp
          .send<{ result?: { value?: PageState } }>("Runtime.evaluate", {
            expression: STATE,
            returnByValue: true,
          })
          .catch(() => undefined);
        active.throwIfAborted();
        const value = r?.result?.value;
        return value &&
          typeof value.url === "string" &&
          typeof value.title === "string" &&
          typeof value.ready === "string" &&
          Number.isFinite(value.origin)
          ? value
          : undefined;
      };
      const before = await probe();
      if (!before) throw new NavigationError("could not establish the current document");
      await check();
      active.throwIfAborted();
      // Explicit navigation may reveal the already identified browser window. Reads
      // never activate tabs, and an ambiguous target never reaches this command.
      await cdp.send("Page.bringToFront");
      active.throwIfAborted();
      await check(true);
      const nav = await cdp.send<{ errorText?: string; loaderId?: string }>(
        "Page.navigate",
        { url: url.href },
        this.#loadTimeoutMs,
      );
      active.throwIfAborted();
      if (nav.errorText) throw new NavigationError(nav.errorText);
      const deadline = performance.now() + this.#loadTimeoutMs;
      let state = before;
      while (performance.now() < deadline) {
        await delay(Math.min(200, Math.max(1, deadline - performance.now())), undefined, {
          signal: active,
        });
        const now = await probe();
        if (!now) continue;
        state = now;
        if (
          now.ready === "complete" &&
          (now.origin !== before.origin || (nav.loaderId === undefined && now.url === url.href))
        ) {
          return { url: now.url, title: now.title, loaded: true };
        }
      }
      return { url: state.url, title: state.title, loaded: false };
    }, signal);
  }
}
