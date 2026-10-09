import { setTimeout as sleep } from "node:timers/promises";
import type {
  Injector,
  Input,
  InputRequest,
  InputResult,
  KeyProgress,
  Point,
  TypeProgress,
  TypeRequest,
  TypeResult,
} from "@localdot/protocol";
import { keyName, keysymOf } from "@localdot/protocol/keys";
import { motionSamples } from "@localdot/protocol/motion";
import { type HelperWindow, listWindows, windowUnder } from "./perception/hit-test.ts";
import type { XEvent, XHelper } from "./x/helper.ts";

export const PRESS_TIMEOUT_MS = 150;
const PROGRESS_EVERY = 8;
const BUTTONS = { left: 1, middle: 2, right: 3 } as const;
// The gap between the presses of a repeated combo.
const REPEAT_GAP_MS = 20;
// A drag waits this long after its press before it moves, and over the drop point before it lets
// go: apps start a drag on the motion after a press, and a drop target has to answer the drag.
export const DRAG_PRESS_MS = 50;
export const DRAG_DROP_MS = 120;

export class NoPressError extends Error {
  constructor(what: string) {
    super(`no raw press observed for ${what} within ${PRESS_TIMEOUT_MS} ms`);
    this.name = "NoPressError";
  }
}

export class UnsupportedInputError extends Error {
  constructor(what: string) {
    super(`${what} is not available in this desktopd`);
    this.name = "UnsupportedInputError";
  }
}

export class ActivationError extends Error {
  constructor(window: number) {
    super(`could not activate window ${window}`);
    this.name = "ActivationError";
  }
}

export class DropChangedError extends Error {
  constructor() {
    super("another window is at the drop point now; the drag was cancelled before its drop");
    this.name = "DropChangedError";
  }
}

function transientRoot(windows: HelperWindow[], win: HelperWindow): number {
  let top = win;
  for (let hops = 0; hops < 8 && top.transientFor !== null; hops++) {
    const parent = windows.find((w) => w.id === top.transientFor);
    if (!parent) break;
    top = parent;
  }
  return top.id;
}

// Input goes to the window the action's identity named, and activating moves keyboard focus there
// only when focus is known to be in another window. A pointer press needs no activation within the
// active window's transient group: activating the window under an open menu or popup closes it,
// and the window manager focuses a dialog's parent on the click itself. Keys need the focus.
async function activate(x: XHelper, window: number | undefined, keyboard: boolean): Promise<void> {
  if (window === undefined) return;
  const windows = await listWindows(x);
  const target = windows.find((w) => w.id === window);
  if (!target) throw new ActivationError(window);
  if (target.overrideRedirect || target.active) return;
  const active = windows.find((w) => w.active);
  if (!active) return;
  if (!keyboard && transientRoot(windows, target) === transientRoot(windows, active)) return;
  const result = await x.call<{ active: number; timedOut?: boolean }>("activate", { window });
  if (result.timedOut || result.active !== window) throw new ActivationError(window);
}

// The subscription opens before the helper call, so a raw press that lands before the reply is
// still seen; resolves with the first `count` matching presses or fails loudly (Review Focus 2).
// `match` may read the helper's reply: presses before it arrives are kept until it does.
export function withPress<R>(
  x: XHelper,
  match: (e: XEvent, reply: R) => boolean,
  count: number,
  act: () => Promise<R>,
  timeoutMs = PRESS_TIMEOUT_MS,
): Promise<XEvent[]> {
  return withEvents(x, "press", match, () => count, act, timeoutMs);
}

// The same for raw releases, as many as the reply says to expect.
export function withRelease<R>(
  x: XHelper,
  match: (e: XEvent, reply: R) => boolean,
  count: (reply: R) => number,
  act: () => Promise<R>,
  timeoutMs = PRESS_TIMEOUT_MS,
): Promise<XEvent[]> {
  return withEvents(x, "release", match, count, act, timeoutMs);
}

async function withEvents<R>(
  x: XHelper,
  ev: XEvent["ev"],
  match: (e: XEvent, reply: R) => boolean,
  countOf: (reply: R) => number,
  act: () => Promise<R>,
  timeoutMs: number,
): Promise<XEvent[]> {
  const early: XEvent[] = [];
  const hits: XEvent[] = [];
  let reply: { value: R; count: number } | undefined;
  let done!: () => void;
  const complete = new Promise<void>((resolve) => {
    done = resolve;
  });
  const off = x.onEvent((e) => {
    if (e.ev !== ev) return;
    if (!reply) early.push(e);
    else if (match(e, reply.value)) {
      hits.push(e);
      if (hits.length >= reply.count) done();
    }
  });
  try {
    const value = await act();
    const count = countOf(value);
    reply = { value, count };
    hits.push(...early.filter((e) => match(e, value)));
    if (hits.length < count) {
      const ac = new AbortController();
      const timeout = sleep(timeoutMs, undefined, { signal: ac.signal }).then(
        () => false,
        () => true,
      );
      const arrived = complete.then(() => true);
      const ok = await Promise.race([arrived, timeout]);
      ac.abort();
      if (!ok) throw new NoPressError(`${count} ${ev}(es)`);
    }
    return hits.slice(0, count);
  } finally {
    off();
  }
}

// The Cua Driver fallback (D12, P3-C9) delivers clicks and typed text, both with XTest-like
// foreground delivery the XI2 listener still times. Its press_key is XSendEvent, invisible to
// XI2, so key combos, moves and scrolls stay on the own-XTest path or are refused.
export interface DriverInjector {
  click(req: InputRequest): Promise<void>;
  type(req: TypeRequest): Promise<void>;
}

export interface Injectors {
  xtest: true;
  driver?: DriverInjector;
}

function driverFor(injectors: Injectors, what: string): DriverInjector {
  if (!injectors.driver) throw new UnsupportedInputError("the driver injector");
  if (what !== "click" && what !== "type")
    throw new UnsupportedInputError(
      `${what} through the driver injector (it delivers clicks and typed text only)`,
    );
  return injectors.driver;
}

// A combo's keys as the keysyms xhelper presses; an unknown name fails before anything is armed.
const keysyms = (names: readonly string[]) => names.map((name) => keysymOf(keyName(name)));

// The press of a combo's last key: a shifted symbol's level modifier, which the helper adds, is
// not it.
const lastKey = (e: XEvent, reply: { keycodes: number[] }) =>
  e.kind === "key" && e.detail === reply.keycodes.at(-1);
const buttonEvent = (button: number) => (e: XEvent) => e.kind === "button" && e.detail === button;

// Moves the cursor through `samples` on their schedule; a stop ends it between two motions.
async function glide(
  x: XHelper,
  samples: ReturnType<typeof motionSamples>,
  signal: AbortSignal | undefined,
): Promise<number | undefined> {
  const start = performance.now();
  let mono: number | undefined;
  for (const sample of samples) {
    const wait = sample.t - (performance.now() - start);
    if (wait > 0) await sleep(wait, undefined, { signal });
    signal?.throwIfAborted();
    ({ mono } = await x.call<{ mono: number }>("move", sample.at));
  }
  return mono;
}

// A drag lets go only over the window its drop point was in when it was approved: a window that
// opened or rose over that point since is refused. Popups that appeared during the drag, such as
// the drag's own icon, do not count.
async function checkDrop(x: XHelper, to: Point, expected: number): Promise<void> {
  const windows = await listWindows(x);
  const top = windowUnder(
    windows.filter((w) => !w.overrideRedirect || w.id === expected),
    to,
  );
  if ((top?.id ?? 0) !== expected) throw new DropChangedError();
}

// Lets go of a held button without dropping: Escape cancels the drag first, and the button comes up
// where the pointer is (xhelper's `cancel`). Taking it back to the start would draw the way back.
async function cancel(x: XHelper): Promise<void> {
  await x
    .call("cancel")
    .catch(() => x.call("release_all"))
    .catch(() => undefined);
}

// Press at the start, follow the path, let go at the end. A drag that is stopped or whose drop
// point changed is cancelled where it is.
async function drag(
  x: XHelper,
  req: InputRequest,
  input: Extract<Input, { kind: "drag" }>,
  armedMono: number,
  signal: AbortSignal | undefined,
  onPress: ((p: KeyProgress) => void | Promise<void>) | undefined,
): Promise<InputResult> {
  const button = BUTTONS[input.button];
  const mods = keysyms(input.mods ?? []);
  const samples = motionSamples([input.from, ...(input.path ?? []), input.to], input.durationMs);
  let held = false;
  try {
    const [press] = await withPress(x, buttonEvent(button), 1, async () => {
      const reply = await x.call("down", { ...input.from, button, mods });
      held = true;
      return reply;
    });
    const pressMono = (press as XEvent).mono;
    await onPress?.({ presses: 1, pressMono });
    await sleep(DRAG_PRESS_MS, undefined, { signal });
    await glide(x, samples, signal);
    await sleep(DRAG_DROP_MS, undefined, { signal });
    if (req.dropWindow !== undefined) await checkDrop(x, input.to, req.dropWindow);
    const [release] = await withRelease(
      x,
      buttonEvent(button),
      () => 1,
      async () => {
        const reply = await x.call("up", { ...input.to, button });
        held = false;
        return reply;
      },
    );
    return {
      pressMono,
      presses: [pressMono],
      releaseMono: (release as XEvent).mono,
      injector: req.injector,
      armedMono,
    };
  } finally {
    if (held) await cancel(x);
  }
}

// `signal` is the request's: a Stop closes it, held keys are released at once, and a repeat ends
// after the press in progress. `onPress` hears each press of a repeat, and a hold once it is down.
export async function inject(
  x: XHelper,
  req: InputRequest,
  injectors: Injectors = { xtest: true },
  signal?: AbortSignal,
  onPress?: (p: KeyProgress) => void | Promise<void>,
): Promise<InputResult> {
  signal?.throwIfAborted();
  const { input } = req;
  if (input.kind === "wait" || input.kind === "type")
    throw new UnsupportedInputError(`${input.kind} through /input`);
  const driver = req.injector === "driver" ? driverFor(injectors, input.kind) : undefined;
  const combo = input.kind === "key" ? keysyms(input.combo) : [];
  if (input.kind === "key" && input.repeat && input.holdMs)
    throw new RangeError("keys are either repeated or held");
  const mods =
    input.kind === "click" ||
    input.kind === "scroll" ||
    input.kind === "drag" ||
    input.kind === "down"
      ? keysyms(input.mods ?? [])
      : [];
  const { mono: armedMono } = await x.call<{ mono: number }>("arm");
  await activate(x, req.window, input.kind === "key");
  const injector: Injector = req.injector;

  if (input.kind === "drag") return drag(x, req, input, armedMono, signal, onPress);
  if (input.kind === "down") {
    const button = BUTTONS[input.button];
    const [press] = await withPress(x, buttonEvent(button), 1, () =>
      x.call("down", { ...input.at, button, mods }),
    );
    const pressMono = (press as XEvent).mono;
    return { pressMono, presses: [pressMono], injector, armedMono };
  }
  if (input.kind === "up") {
    const button = BUTTONS[input.button];
    if (req.dropWindow !== undefined)
      await checkDrop(x, input.at, req.dropWindow).catch(async (error) => {
        await cancel(x);
        throw error;
      });
    const [release] = await withRelease(
      x,
      buttonEvent(button),
      (reply) => (reply.released ? 1 : 0),
      () => x.call<{ released: boolean }>("up", { ...input.at, button }),
    );
    // A button that was not down has no release: the moment is the reply's.
    const mono = release?.mono ?? (await x.call<{ mono: number }>("ping")).mono;
    return {
      pressMono: mono,
      presses: [],
      ...(release ? { releaseMono: release.mono } : {}),
      injector,
      armedMono,
    };
  }

  if (input.kind === "click") {
    const button = BUTTONS[input.button];
    const releases: XEvent[] = [];
    const offRelease = x.onEvent((e) => {
      if (e.ev === "release" && e.kind === "button" && e.detail === button) releases.push(e);
    });
    try {
      const presses = await withPress(
        x,
        (e) => e.kind === "button" && e.detail === button,
        input.count,
        (): Promise<unknown> =>
          driver
            ? driver.click(req)
            : x.call("click", {
                x: input.at.x,
                y: input.at.y,
                button,
                count: input.count,
                holdMs: req.holdMs,
                mods,
              }),
      );
      await sleep(5);
      const first = presses[0] as XEvent;
      const release = releases.find((r) => r.mono >= first.mono);
      return {
        pressMono: first.mono,
        presses: presses.map((p) => p.mono),
        ...(release ? { releaseMono: release.mono } : {}),
        injector,
        armedMono,
      };
    } finally {
      offRelease();
    }
  }
  if (input.kind === "move") {
    if (!input.durationMs) {
      const { mono } = await x.call<{ mono: number }>("move", { x: input.to.x, y: input.to.y });
      return { pressMono: mono, presses: [], injector, armedMono };
    }
    const from = await x.call<Point>("pointer");
    const mono =
      (await glide(x, motionSamples([from, input.to], input.durationMs), signal)) ??
      (await x.call<{ mono: number }>("move", { x: input.to.x, y: input.to.y })).mono;
    return { pressMono: mono, presses: [], injector, armedMono };
  }
  if (input.kind === "scroll") {
    const notches = Math.abs(Math.trunc(input.dx)) + Math.abs(Math.trunc(input.dy));
    if (notches === 0) throw new RangeError("scroll needs at least one notch");
    const presses = await withPress(
      x,
      (e) => e.kind === "button" && e.detail >= 4 && e.detail <= 7,
      notches,
      () =>
        x.call("scroll", {
          x: input.at.x,
          y: input.at.y,
          dx: Math.trunc(input.dx),
          dy: Math.trunc(input.dy),
          mods,
        }),
      PRESS_TIMEOUT_MS + notches * 10,
    );
    return {
      pressMono: (presses[0] as XEvent).mono,
      presses: presses.map((p) => p.mono),
      injector,
      armedMono,
    };
  }
  if (input.holdMs) {
    try {
      const [press] = await withPress(x, lastKey, 1, () =>
        x.call<{ keycodes: number[] }>("hold", { combo, ms: input.holdMs }),
      );
      const pressMono = (press as XEvent).mono;
      await onPress?.({ presses: 1, pressMono });
      await sleep(input.holdMs, undefined, { signal });
      return { pressMono, presses: [pressMono], injector, armedMono };
    } finally {
      await x.call("release");
    }
  }
  // One helper call per press: a Stop reaches the helper between presses, and a release the
  // daemon sends waits behind one press at most.
  const presses: number[] = [];
  for (let i = 0; i < (input.repeat ?? 1); i++) {
    if (i > 0) await sleep(REPEAT_GAP_MS, undefined, { signal });
    signal?.throwIfAborted();
    const [press] = await withPress(x, lastKey, 1, () =>
      x.call<{ keycodes: number[] }>("keys", { combo }),
    );
    presses.push((press as XEvent).mono);
    await onPress?.({ presses: presses.length, pressMono: (press as XEvent).mono });
  }
  return { pressMono: presses[0] as number, presses, injector, armedMono };
}

// `signal` is the request's: a Stop closes the daemon's request, and typing ends at the next key.
export async function typeText(
  x: XHelper,
  req: TypeRequest,
  onProgress: (p: TypeProgress) => void | Promise<void>,
  injectors: Injectors = { xtest: true },
  signal?: AbortSignal,
): Promise<TypeResult> {
  signal?.throwIfAborted();
  const driver = req.injector === "driver" ? driverFor(injectors, "type") : undefined;
  const { mono: armedMono } = await x.call<{ mono: number }>("arm");
  signal?.throwIfAborted();
  await activate(x, req.window, true);
  signal?.throwIfAborted();
  const chars = [...req.text];
  if (driver) {
    signal?.throwIfAborted();
    // type_text delivers the whole string at the driver's own pace and withPress waits for that
    // call, so the one progress line follows the delivery: the whole count, stamped with the first
    // raw press (the keycap and the ring are timed from it).
    const [first] = await withPress(
      x,
      (e) => e.kind === "key",
      1,
      () => driver.type(req),
      PRESS_TIMEOUT_MS + chars.length * 50,
    );
    const pressMono = (first as XEvent).mono;
    await onProgress({
      count: chars.length,
      ...(req.masked ? {} : { chunk: req.text }),
      pressMono,
    });
    return {
      done: true,
      count: chars.length,
      firstPressMono: pressMono,
      injector: req.injector,
      armedMono,
    };
  }
  let count = 0;
  let firstPressMono: number | null = null;
  let chunk = "";
  for (const [i, ch] of chars.entries()) {
    signal?.throwIfAborted();
    const delay = i < req.pace.firstCount ? req.pace.firstMs : req.pace.restMs;
    if (delay > 0 && i > 0) await sleep(delay, undefined, { signal });
    signal?.throwIfAborted();
    const [press] = await withPress(
      x,
      (e) => e.kind === "key",
      1,
      () => x.call("char", { ch }),
    );
    count += 1;
    chunk += ch;
    firstPressMono ??= (press as XEvent).mono;
    const last = i === chars.length - 1;
    if (
      count <= req.pace.firstCount ||
      (count - req.pace.firstCount) % PROGRESS_EVERY === 0 ||
      last
    ) {
      await onProgress({
        count,
        ...(req.masked ? {} : { chunk }),
        pressMono: (press as XEvent).mono,
      });
      chunk = "";
    }
  }
  return { done: true, count, firstPressMono, injector: req.injector, armedMono };
}
