import type { Point, Rect } from "@localdot/protocol";
import {
  startXHelper,
  type XHelper,
  type XHelperOptions,
  XHelperTimeoutError,
} from "../x/helper.ts";
import type { HelperWindow } from "./hit-test.ts";
import type { AppToolkit } from "./mapping.ts";

// Frames are in the toolkit's units: GTK frame units, or device / c for Chromium's own UI.
export interface NativeElement {
  role: string;
  name: string;
  frame: Rect;
  space: "gtk" | "chrome";
  secret: boolean;
  editable: boolean;
}

// `unknown`: the lookup did not finish within its budget, so nothing is known below the window.
export type NativeAnswer = { element: NativeElement | null } | { unknown: true };
export type NativeTree = { elements: NativeElement[] } | { unknown: true };

export interface NativeQuery {
  kit: AppToolkit;
  g: number;
  c: number;
  // An override-redirect menu has no accessible of its own: its items hang off its parent's.
  parent?: HelperWindow;
}

export interface NativeAccessibility {
  at(win: HelperWindow, point: Point, q: NativeQuery, budgetMs: number): Promise<NativeAnswer>;
  focused(win: HelperWindow, q: NativeQuery, budgetMs: number): Promise<NativeAnswer>;
  // Kept per window while the screen's change generation stays the same.
  tree(
    win: HelperWindow,
    q: NativeQuery,
    budgetMs: number,
    generation: number,
  ): Promise<NativeTree>;
  content(win: HelperWindow, budgetMs: number): Promise<Rect | null>;
}

// Past its own deadline the helper is inside one application call at most; this long is allowed
// for that before the helper counts as stuck.
const GRACE_MS = 200;
const TREE_CACHE_LIMIT = 32;

const wire = (w: HelperWindow) => ({
  pid: w.pid,
  title: w.title,
  rect: [w.x, w.y, w.w, w.h],
  frame: w.frame,
  overrideRedirect: w.overrideRedirect,
});

const query = (q: NativeQuery) => ({
  kit: q.kit,
  g: q.g,
  c: q.c,
  ...(q.parent ? { parent: wire(q.parent) } : {}),
});

// One persistent AT-SPI helper, apart from XTest's: a hung application must not block input or its
// raw timestamps. A helper that misses its own deadline is replaced on the next query.
export class AtspiAccessibility implements NativeAccessibility {
  #helper: Promise<XHelper> | undefined;
  readonly #trees = new Map<number, { key: string; elements: NativeElement[] }>();

  constructor(
    private readonly start: () => Promise<XHelper>,
    private readonly mono: () => number,
  ) {}

  static launch(env: NodeJS.ProcessEnv, mono: () => number): AtspiAccessibility {
    const options: XHelperOptions = {
      name: "native",
      // /usr/bin/python3: the base image's PATH starts with a venv (/lsiopy) without PyGObject.
      command: "/usr/bin/python3",
      args: ["-u", env.LOCALDOT_NATIVE_HELPER ?? "/opt/localdot/native.py"],
      env,
    };
    return new AtspiAccessibility(() => startXHelper(options), mono);
  }

  // Started with desktopd, so the helper has seen every focus change before the first query.
  warm(): void {
    void this.#ensure().catch(() => {});
  }

  async #ensure(): Promise<XHelper> {
    const current = this.#helper;
    if (current) {
      const helper = await current.catch(() => undefined);
      if (helper?.alive) return helper;
      if (this.#helper === current) this.#helper = undefined;
      return this.#ensure();
    }
    const next = this.start();
    this.#helper = next;
    return next;
  }

  async #call<T extends object>(
    cmd: string,
    args: Record<string, unknown>,
    budgetMs: number,
  ): Promise<T | { unknown: true }> {
    let helper: XHelper;
    try {
      helper = await this.#ensure();
    } catch {
      return { unknown: true };
    }
    try {
      return await helper.call<T>(
        cmd,
        { ...args, deadline: this.mono() + budgetMs },
        budgetMs + GRACE_MS,
      );
    } catch (err) {
      if (err instanceof XHelperTimeoutError) {
        this.#helper = undefined;
        void helper.close();
      }
      return { unknown: true };
    }
  }

  at(win: HelperWindow, point: Point, q: NativeQuery, budgetMs: number): Promise<NativeAnswer> {
    return this.#call<NativeAnswer>("at", { window: wire(win), point, ...query(q) }, budgetMs);
  }

  focused(win: HelperWindow, q: NativeQuery, budgetMs: number): Promise<NativeAnswer> {
    return this.#call<NativeAnswer>("focused", { window: wire(win), ...query(q) }, budgetMs);
  }

  async tree(
    win: HelperWindow,
    q: NativeQuery,
    budgetMs: number,
    generation: number,
  ): Promise<NativeTree> {
    const key = JSON.stringify([generation, wire(win), query(q)]);
    const kept = this.#trees.get(win.id);
    if (kept?.key === key) return { elements: kept.elements };
    const answer = await this.#call<{ elements: NativeElement[]; truncated: boolean }>(
      "tree",
      { window: wire(win), ...query(q) },
      budgetMs,
    );
    if ("unknown" in answer) return answer;
    if (!answer.truncated) {
      if (this.#trees.size >= TREE_CACHE_LIMIT) this.#trees.clear();
      this.#trees.set(win.id, { key, elements: answer.elements });
    }
    return { elements: answer.elements };
  }

  async content(win: HelperWindow, budgetMs: number): Promise<Rect | null> {
    const answer = await this.#call<{ frame: Rect | null }>(
      "content",
      { window: wire(win), kit: "chromium" },
      budgetMs,
    );
    return "unknown" in answer ? null : answer.frame;
  }

  async close(): Promise<void> {
    const helper = await this.#helper?.catch(() => undefined);
    this.#helper = undefined;
    await helper?.close();
  }
}
