import { setTimeout as delay } from "node:timers/promises";
import { type BrowserNavigateResult, type BrowserReadResult, webUrl } from "@localdot/protocol";
import { WebSocket } from "ws";
import { CdpSession, type PageTarget } from "../perception/cdp.ts";

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

// The desktop's own Chromium, through its DevTools port on the cell's loopback (Part 3, D13):
// a fast read of the page the user sees, and navigation in that same tab.
export class PageBrowser {
  readonly #port: number;
  readonly #fetchImpl: typeof fetch;
  readonly #WebSocketImpl: typeof WebSocket;
  readonly #loadTimeoutMs: number;

  constructor(opts: BrowserOptions = {}) {
    this.#port = opts.port ?? 9222;
    this.#fetchImpl = opts.fetchImpl ?? fetch;
    this.#WebSocketImpl = opts.WebSocketImpl ?? WebSocket;
    this.#loadTimeoutMs = opts.loadTimeoutMs ?? 10_000;
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

  // Use the first ordinary page reported by Chromium; this does not prove foreground focus.
  async #page(signal: AbortSignal): Promise<PageTarget> {
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
      const page = targets.find(
        (t) =>
          t &&
          typeof t === "object" &&
          t.type === "page" &&
          typeof t.url === "string" &&
          !t.url.startsWith("devtools://") &&
          typeof t.webSocketDebuggerUrl === "string",
      ) as PageTarget | undefined;
      if (!page) throw new NoPageError();
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
      return page;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof NoPageError) throw error;
      throw new NoPageError();
    }
  }

  async #with<T>(
    fn: (cdp: CdpSession, signal: AbortSignal) => Promise<T>,
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
      cdp = new CdpSession(page.webSocketDebuggerUrl, this.#WebSocketImpl);
      await cdp.ready;
      signal.throwIfAborted();
      return await fn(cdp, signal);
    })();
    try {
      return await Promise.race([operation, cancelled]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      cdp?.close();
    }
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
    return this.#with(async (cdp, active) => {
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
      active.throwIfAborted();
      const nav = await cdp.send<{ errorText?: string; loaderId?: string }>("Page.navigate", {
        url: url.href,
      });
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
