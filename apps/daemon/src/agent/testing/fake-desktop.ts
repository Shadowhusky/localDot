import type { WindowsRequest, WindowsResult } from "@localdot/protocol";

const frameOf = (id: number) => ({ x: (id * 97) % 1600, y: (id * 61) % 900, w: 900, h: 600 });

interface FakeWindow {
  id: number;
  pid: number;
  started: number;
  command?: string;
  transientFor?: number;
}

// A desktop's windows as desktopd reports them: a stack (top first), an active window, programs
// with start times on a clock that moves on every read.
export class FakeDesktop {
  readonly #stack: FakeWindow[] = [];
  #active: number | undefined;
  #ticks = 0;
  #next = 1;
  // A window that refuses to give up focus, as a full-screen app or a modal might.
  stuck: number | undefined;

  get active(): number | undefined {
    return this.#active;
  }
  get ticks(): number {
    return this.#ticks;
  }
  // A program starts and shows its first window on top, focused.
  open(more: Partial<Omit<FakeWindow, "id">> = {}): number {
    this.#ticks++;
    const id = this.#next++;
    this.#stack.unshift({ id, pid: more.pid ?? 1000 + id, started: this.#ticks, ...more });
    this.#active = id;
    return id;
  }
  close(id: number): void {
    const at = this.#stack.findIndex((w) => w.id === id);
    if (at >= 0) this.#stack.splice(at, 1);
    if (this.#active === id) this.#active = this.#stack[0]?.id;
  }
  // Something else takes focus.
  steal(id: number): void {
    this.raise(id);
  }
  raise(id: number): void {
    const at = this.#stack.findIndex((w) => w.id === id);
    if (at < 0) return;
    const [w] = this.#stack.splice(at, 1);
    if (w) this.#stack.unshift(w);
    this.#active = id;
  }
  pidOf(id: number): number | undefined {
    return this.#stack.find((w) => w.id === id)?.pid;
  }
  ids(): number[] {
    return this.#stack.map((w) => w.id);
  }
  // Top first, each window where its program put it.
  stack(): { id: number; frame: { x: number; y: number; w: number; h: number } }[] {
    return this.#stack.map((w) => ({ id: w.id, frame: frameOf(w.id) }));
  }

  read = async (request: WindowsRequest): Promise<WindowsResult> => {
    this.#ticks++;
    if (request.activate && this.stuck === undefined) this.raise(request.activate);
    return {
      ticks: this.#ticks,
      windows: this.#stack.map((w) => ({
        id: w.id,
        pid: w.pid,
        started: w.started,
        ...(w.command ? { command: w.command } : {}),
        frame: frameOf(w.id),
        active: w.id === this.#active,
        transientFor: w.transientFor ?? null,
      })),
    };
  };
}
