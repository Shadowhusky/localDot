import { setTimeout as sleep } from "node:timers/promises";
import type {
  Injector,
  InputRequest,
  InputResult,
  TypeProgress,
  TypeRequest,
  TypeResult,
} from "@localdot/protocol";
import type { XEvent, XHelper } from "./x/helper.ts";
import { keyName } from "./x/keys.ts";

export const PRESS_TIMEOUT_MS = 150;
const PROGRESS_EVERY = 8;
const BUTTONS = { left: 1, middle: 2, right: 3 } as const;

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

async function activate(x: XHelper, window: number | undefined): Promise<void> {
  if (window === undefined) return;
  const result = await x.call<{ active: number; timedOut?: boolean }>("activate", { window });
  if (result.timedOut || result.active !== window) throw new ActivationError(window);
}

// The subscription opens before the helper call, so a raw press that lands before the reply is
// still seen; resolves with the first `count` matching presses or fails loudly (Review Focus 2).
export async function withPress(
  x: XHelper,
  match: (e: XEvent) => boolean,
  count: number,
  act: () => Promise<unknown>,
  timeoutMs = PRESS_TIMEOUT_MS,
): Promise<XEvent[]> {
  const hits: XEvent[] = [];
  let done!: () => void;
  const complete = new Promise<void>((resolve) => {
    done = resolve;
  });
  const off = x.onEvent((e) => {
    if (e.ev === "press" && match(e)) {
      hits.push(e);
      if (hits.length >= count) done();
    }
  });
  try {
    await act();
    if (hits.length < count) {
      const ac = new AbortController();
      const timeout = sleep(timeoutMs, undefined, { signal: ac.signal }).then(
        () => false,
        () => true,
      );
      const arrived = complete.then(() => true);
      const ok = await Promise.race([arrived, timeout]);
      ac.abort();
      if (!ok) throw new NoPressError(`${count} press(es)`);
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

export async function inject(
  x: XHelper,
  req: InputRequest,
  injectors: Injectors = { xtest: true },
): Promise<InputResult> {
  const { input } = req;
  if (input.kind === "drag") throw new UnsupportedInputError("drag");
  if (input.kind === "wait" || input.kind === "type")
    throw new UnsupportedInputError(`${input.kind} through /input`);
  const driver = req.injector === "driver" ? driverFor(injectors, input.kind) : undefined;
  const { mono: armedMono } = await x.call<{ mono: number }>("arm");
  await activate(x, req.window);
  const injector: Injector = req.injector;

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
        () =>
          driver
            ? driver.click(req)
            : x.call("click", {
                x: input.at.x,
                y: input.at.y,
                button,
                count: input.count,
                holdMs: req.holdMs,
                mods: (input.mods ?? []).map(keyName),
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
    const { mono } = await x.call<{ mono: number }>("move", { x: input.to.x, y: input.to.y });
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
  const combo = input.combo.map(keyName);
  const presses = await withPress(
    x,
    (e) => e.kind === "key",
    combo.length,
    () => x.call("keys", { combo }),
  );
  return {
    pressMono: (presses.at(-1) as XEvent).mono,
    presses: presses.map((p) => p.mono),
    injector,
    armedMono,
  };
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
  await activate(x, req.window);
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
