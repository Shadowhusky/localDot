import type { Rect } from "@localdot/protocol";

export interface OwnedWindow {
  readonly id: number;
  readonly pid: number;
  // The process's start, in the computer's clock ticks since boot, and the shell command whose
  // process session it is in.
  readonly started?: number;
  readonly command?: string;
  readonly frame: Rect;
  readonly active: boolean;
  readonly transientFor?: number | null;
}
// Top first, as the window manager stacks them, with the computer's clock when they were read.
export interface WindowsSnapshot {
  readonly ticks: number;
  readonly windows: readonly OwnedWindow[];
}

interface Turn {
  readonly sessionId: string;
  readonly from: number;
  to?: number;
}

const TURNS_KEPT = 256;

// The parts of the screen the windows `hide` picks show, top first: a window's frame less every
// window above it.
export function hiddenParts(
  windows: readonly Pick<OwnedWindow, "id" | "frame">[],
  hide: (id: number) => boolean,
): Rect[] {
  const parts: Rect[] = [];
  let above: Rect[] = [];
  for (const w of windows) {
    if (w.frame.w <= 0 || w.frame.h <= 0) continue;
    if (hide(w.id))
      parts.push(...above.reduce((left, cover) => left.flatMap((r) => minus(r, cover)), [w.frame]));
    above = [...above, w.frame];
  }
  return parts;
}

// `r` less `cover`: up to four rectangles.
function minus(r: Rect, cover: Rect): Rect[] {
  const x1 = Math.max(r.x, cover.x);
  const y1 = Math.max(r.y, cover.y);
  const x2 = Math.min(r.x + r.w, cover.x + cover.w);
  const y2 = Math.min(r.y + r.h, cover.y + cover.h);
  if (x1 >= x2 || y1 >= y2) return [r];
  const out: Rect[] = [];
  if (r.y < y1) out.push({ x: r.x, y: r.y, w: r.w, h: y1 - r.y });
  if (y2 < r.y + r.h) out.push({ x: r.x, y: y2, w: r.w, h: r.y + r.h - y2 });
  if (r.x < x1) out.push({ x: r.x, y: y1, w: x1 - r.x, h: y2 - y1 });
  if (x2 < r.x + r.w) out.push({ x: x2, y: y1, w: r.x + r.w - x2, h: y2 - y1 });
  return out;
}

// Which task each window belongs to. A window is its task's when the task's own action made it: a
// dialog follows its parent, a program its shell started is the shell's, and a program's first
// window is the task's that started the program; any other new window is the task's that was acting
// when it appeared. Windows nobody's action made (the desktop's own, the user's) belong to no task.
export class WindowOwners {
  readonly #owners = new Map<number, string>();
  readonly #known = new Map<number, OwnedWindow>();
  readonly #turns: Turn[] = [];
  readonly #shells = new Map<string, string>();
  readonly #focus = new Map<string, number>();

  constructor(private readonly live: (sessionId: string) => boolean) {}

  ownerOf(windowId: number): string | undefined {
    return this.#owners.get(windowId);
  }
  known(windowId: number): boolean {
    return this.#known.has(windowId);
  }
  // Another task at work owns it; an ended task's windows belong to nobody until its conversation
  // goes on.
  foreign(sessionId: string, windowId: number | null | undefined): boolean {
    if (!windowId) return false;
    const owner = this.#owners.get(windowId);
    return !!owner && owner !== sessionId && this.live(owner);
  }
  owned(sessionId: string): number[] {
    return [...this.#owners].filter(([, owner]) => owner === sessionId).map(([id]) => id);
  }
  shell(command: string, sessionId: string): void {
    this.#shells.set(command, sessionId);
    if (this.#shells.size > TURNS_KEPT) this.#shells.delete(this.#shells.keys().next().value ?? "");
  }
  // A task that continues another takes up its windows.
  inherit(sessionId: string, from: string): void {
    for (const [id, owner] of this.#owners) if (owner === from) this.#owners.set(id, sessionId);
    for (const [command, owner] of this.#shells)
      if (owner === from) this.#shells.set(command, sessionId);
    const focus = this.#focus.get(from);
    if (focus !== undefined && !this.#focus.has(sessionId)) this.#focus.set(sessionId, focus);
  }

  begin(sessionId: string, snapshot: WindowsSnapshot): void {
    this.learn(snapshot);
    this.#turns.push({ sessionId, from: snapshot.ticks });
    if (this.#turns.length > TURNS_KEPT) this.#turns.shift();
  }
  end(sessionId: string, snapshot: WindowsSnapshot): void {
    this.learn(snapshot, sessionId);
    const turn = this.#turns.findLast((t) => t.sessionId === sessionId && t.to === undefined);
    if (turn) turn.to = snapshot.ticks;
    const active = snapshot.windows.find((w) => w.active);
    if (active && this.#owners.get(active.id) === sessionId) this.#focus.set(sessionId, active.id);
  }

  // The window to bring forward before the task acts: the one it last left active, or its topmost.
  target(sessionId: string, snapshot: WindowsSnapshot): number | undefined {
    const focus = this.#focus.get(sessionId);
    if (focus !== undefined && snapshot.windows.some((w) => w.id === focus)) return focus;
    return snapshot.windows.find(
      (w) => !w.transientFor && this.#owners.get(w.id) === sessionId && w.frame.w > 0,
    )?.id;
  }

  learn(snapshot: WindowsSnapshot, during?: string): void {
    const present = new Set(snapshot.windows.map((w) => w.id));
    for (const id of [...this.#known.keys()])
      if (!present.has(id)) {
        this.#known.delete(id);
        this.#owners.delete(id);
        for (const [sessionId, focus] of this.#focus)
          if (focus === id) this.#focus.delete(sessionId);
      }
    // Parents first: a dialog's parent is stacked below it.
    for (const w of [...snapshot.windows].reverse()) {
      if (this.#known.has(w.id)) continue;
      const owner = this.#attribute(w, during);
      this.#known.set(w.id, w);
      if (owner) this.#owners.set(w.id, owner);
    }
  }

  #attribute(w: OwnedWindow, during: string | undefined): string | undefined {
    const parent = w.transientFor ? this.#owners.get(w.transientFor) : undefined;
    if (parent) return parent;
    const shell = w.command ? this.#shells.get(w.command) : undefined;
    if (shell) return shell;
    const starter =
      w.started === undefined
        ? undefined
        : this.#turns.findLast(
            (t) => t.from <= (w.started ?? 0) && (w.started ?? 0) <= (t.to ?? Infinity),
          )?.sessionId;
    // A program that already had windows opened this one for whoever was acting; opened while
    // nobody acted, it is nobody's.
    const sibling = w.pid > 0 && [...this.#known.values()].some((known) => known.pid === w.pid);
    if (starter && !sibling) return starter;
    return during;
  }
}
