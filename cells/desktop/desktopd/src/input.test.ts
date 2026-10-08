import type { InputRequest, TypeProgress, TypeRequest } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import {
  ActivationError,
  inject,
  NoPressError,
  typeText,
  UnsupportedInputError,
  withPress,
} from "./input.ts";
import type { HelperWindow } from "./perception/hit-test.ts";
import type { XEvent, XHelper } from "./x/helper.ts";

interface Scripted {
  helper: XHelper;
  calls: { cmd: string; args: Record<string, unknown> }[];
  emit(e: XEvent): void;
}

function scripted(
  reply: (cmd: string, args: Record<string, unknown>, emit: (e: XEvent) => void) => object,
): Scripted {
  const listeners = new Set<(e: XEvent) => void>();
  const calls: Scripted["calls"] = [];
  const emit = (e: XEvent) => {
    for (const l of listeners) l(e);
  };
  // Below the scripted presses (500 and up), as a real arm precedes its press.
  let mono = 100;
  const helper: XHelper = {
    alive: true,
    async call(cmd, args = {}) {
      calls.push({ cmd, args });
      if (cmd === "ping" || cmd === "arm") {
        mono += 1;
        return { mono } as never;
      }
      return reply(cmd, args, emit) as never;
    },
    onEvent(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    async close() {},
  };
  return { helper, calls, emit };
}

const press = (kind: XEvent["kind"], detail: number, mono: number): XEvent => ({
  ev: "press",
  kind,
  detail,
  mono,
});
const click: InputRequest = {
  input: { kind: "click", button: "left", count: 1, at: { x: 10, y: 20 } },
  injector: "xtest",
  holdMs: 0,
};

const xwin = (id: number, over: Partial<HelperWindow> = {}): HelperWindow => ({
  id,
  pid: 2193,
  cls: "Gimp",
  title: `window ${id}`,
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  frame: [0, 0, 100, 100],
  active: false,
  overrideRedirect: false,
  transientFor: null,
  ...over,
});
// GIMP's image window (11), its colour dialog (21), an open menu over the image window (30) and
// an unrelated terminal (40).
const STACK = {
  menu: xwin(30, { overrideRedirect: true, transientFor: 11 }),
  dialog: xwin(21, { transientFor: 11 }),
  image: xwin(11),
  terminal: xwin(40, { cls: "Xfce4-terminal" }),
};

describe("withPress", () => {
  it("sees a press that lands before the reply", async () => {
    const s = scripted((_cmd, _args, emit) => {
      emit(press("button", 1, 5));
      return { button: 1, presses: 1 };
    });
    const hits = await withPress(
      s.helper,
      (e) => e.kind === "button",
      1,
      () => s.helper.call("click"),
    );
    expect(hits.map((h) => h.mono)).toEqual([5]);
  });

  it("waits up to the timeout for a press that lands after the reply", async () => {
    const s = scripted((_cmd, _args, emit) => {
      setTimeout(() => emit(press("key", 38, 7)), 20);
      return { keycode: 38 };
    });
    const hits = await withPress(
      s.helper,
      (e) => e.kind === "key",
      1,
      () => s.helper.call("char"),
      150,
    );
    expect(hits[0]?.mono).toBe(7);
  });

  it("fails loudly when no raw press arrives", async () => {
    const s = scripted(() => ({ button: 1, presses: 1 }));
    await expect(
      withPress(
        s.helper,
        () => true,
        1,
        () => s.helper.call("silent-click"),
        30,
      ),
    ).rejects.toThrow(NoPressError);
  });
});

describe("inject", () => {
  it("refuses to inject when the requested window cannot be activated", async () => {
    const s = scripted((cmd) =>
      cmd === "windows"
        ? { windows: [xwin(77), xwin(9, { active: true })], generation: 1 }
        : { active: 9, timedOut: true },
    );
    await expect(inject(s.helper, { ...click, window: 77 })).rejects.toThrow(/activate/);
    expect(s.calls.map((c) => c.cmd)).toEqual(["arm", "windows", "activate"]);
  });
  it("arms, activates the window when given, clicks, and returns the first raw press", async () => {
    const s = scripted((cmd, args, emit) => {
      if (cmd === "windows")
        return { windows: [xwin(77), xwin(9, { active: true })], generation: 1 };
      if (cmd === "activate") return { active: args.window, changed: true, waitedMs: 12 };
      emit(press("button", 1, 500));
      emit({ ev: "release", kind: "button", detail: 1, mono: 501 });
      return { button: 1, presses: 1 };
    });
    const res = await inject(s.helper, { ...click, window: 77 });
    expect(s.calls.map((c) => c.cmd)).toEqual(["arm", "windows", "activate", "click"]);
    expect(s.calls[3]?.args).toMatchObject({ x: 10, y: 20, button: 1, count: 1, holdMs: 0 });
    expect(res).toMatchObject({
      pressMono: 500,
      presses: [500],
      releaseMono: 501,
      injector: "xtest",
    });
    expect(res.armedMono).toBeLessThan(500);
  });

  describe("activation", () => {
    const run = (windows: HelperWindow[], req: InputRequest) => {
      const s = scripted((cmd, args, emit) => {
        if (cmd === "windows") return { windows, generation: 1 };
        if (cmd === "activate") return { active: args.window, changed: true, waitedMs: 3 };
        if (cmd === "click") emit(press("button", 1, 500));
        if (cmd !== "keys") return {};
        emit(press("key", 36, 500));
        return { keycodes: [36] };
      });
      return { s, done: inject(s.helper, req) };
    };
    const key: InputRequest = {
      input: { kind: "key", combo: ["Return"] },
      injector: "xtest",
      holdMs: 0,
    };
    const order = (s: Scripted) => s.calls.map((c) => c.cmd).filter((c) => c !== "arm");
    const { menu, dialog, image, terminal } = STACK;

    it("never activates the window a click on an open menu would close", async () => {
      // The menu's item lies over the image window; activating that would close the menu.
      const { s, done } = run([menu, { ...image, active: true }, terminal], {
        ...click,
        window: 30,
      });
      await done;
      expect(order(s)).toEqual(["windows", "click"]);
    });

    it("never activates a popup that names no parent window", async () => {
      // Chromium's menus are override-redirect windows without WM_TRANSIENT_FOR.
      const popup = xwin(31, { cls: "Chromium", overrideRedirect: true });
      for (const req of [
        { ...click, window: 31 },
        { ...key, window: 31 },
      ]) {
        const { s, done } = run([popup, { ...terminal, active: true }], req);
        await done;
        expect(order(s)).toEqual(["windows", req.input.kind === "key" ? "keys" : "click"]);
      }
    });

    it("never activates the active window or another window of its transient group", async () => {
      for (const target of [11, 21]) {
        const { s, done } = run([{ ...dialog, active: true }, image, terminal], {
          ...click,
          window: target,
        });
        await done;
        expect(order(s)).toEqual(["windows", "click"]);
      }
    });

    it("activates only when focus is known to be in an unrelated window", async () => {
      const unknown = run([dialog, image, terminal], { ...click, window: 11 });
      await unknown.done;
      expect(order(unknown.s)).toEqual(["windows", "click"]);
      const elsewhere = run([dialog, image, { ...terminal, active: true }], {
        ...click,
        window: 11,
      });
      await elsewhere.done;
      expect(order(elsewhere.s)).toEqual(["windows", "activate", "click"]);
    });

    it("moves the focus for keys to their window, even from another window of its group", async () => {
      const { s, done } = run([{ ...dialog, active: true }, image], { ...key, window: 11 });
      await done;
      expect(order(s)).toEqual(["windows", "activate", "keys"]);
    });

    it("refuses input for a window that is gone", async () => {
      const { s, done } = run([image, { ...terminal, active: true }], { ...click, window: 21 });
      await expect(done).rejects.toThrow(ActivationError);
      expect(order(s)).toEqual(["windows"]);
    });
  });

  it("maps buttons and double clicks and returns every press", async () => {
    let n = 0;
    const s = scripted((cmd, _args, emit) => {
      if (cmd !== "click") return {};
      emit(press("button", 3, 600 + n++));
      emit(press("button", 3, 700 + n++));
      return { button: 3, presses: 2 };
    });
    const res = await inject(s.helper, {
      ...click,
      input: { kind: "click", button: "right", count: 2, at: { x: 1, y: 1 } },
    });
    expect(res.presses).toEqual([600, 701]);
    expect(s.calls.find((c) => c.cmd === "click")?.args).toMatchObject({ button: 3, count: 2 });
  });

  it("presses key combos as keysyms and takes the last key's press time", async () => {
    const s = scripted((_cmd, _args, emit) => {
      emit(press("key", 37, 10));
      emit(press("key", 46, 12));
      return { keycodes: [37, 46] };
    });
    const res = await inject(s.helper, { ...click, input: { kind: "key", combo: ["ctrl", "L"] } });
    expect(s.calls.find((c) => c.cmd === "keys")?.args).toEqual({ combo: [0xffe3, 0x6c] });
    expect(res.pressMono).toBe(12);
    expect(res.presses).toEqual([12]);
  });

  it("times a shifted symbol from its own key, not from the Shift the helper adds", async () => {
    const s = scripted((_cmd, _args, emit) => {
      emit(press("key", 37, 10));
      emit(press("key", 50, 11));
      emit(press("key", 61, 12));
      return { keycodes: [37, 61] };
    });
    const res = await inject(s.helper, {
      ...click,
      input: { kind: "key", combo: ["ctrl", "Page_Up", "?"] },
    });
    expect(s.calls.find((c) => c.cmd === "keys")?.args).toEqual({ combo: [0xffe3, 0xff55, 0x3f] });
    expect(res.presses).toEqual([12]);
  });

  it("presses a repeated combo in one helper call and returns one press per repeat", async () => {
    const s = scripted((_cmd, args, emit) => {
      for (let i = 0; i < Number(args.repeat); i++) emit(press("key", 35, 20 + i));
      return { keycodes: [35] };
    });
    const res = await inject(s.helper, {
      ...click,
      input: { kind: "key", combo: ["bracketright"], repeat: 5 },
    });
    expect(s.calls.filter((c) => c.cmd === "keys").map((c) => c.args)).toEqual([
      { combo: [0x5d], repeat: 5 },
    ]);
    expect(res).toMatchObject({ pressMono: 20, presses: [20, 21, 22, 23, 24] });
  });

  it("refuses an unknown key before arming, naming the close ones", async () => {
    const s = scripted(() => ({}));
    await expect(
      inject(s.helper, { ...click, input: { kind: "key", combo: ["ctrl", "PageUpp"] } }),
    ).rejects.toThrow(/unknown key "PageUpp"; did you mean/);
    await expect(
      inject(s.helper, { ...click, input: { kind: "key", combo: ["a"], repeat: 2, holdMs: 5 } }),
    ).rejects.toThrow(RangeError);
    expect(s.calls).toHaveLength(0);
  });

  describe("held keys", () => {
    const held = (holdMs: number, opts: { silent?: boolean } = {}) => {
      const s = scripted((cmd, _args, emit) => {
        if (cmd === "hold") {
          if (!opts.silent) emit(press("key", 50, 30));
          return { keycodes: [50] };
        }
        if (cmd === "release") return { keycodes: [50] };
        return {};
      });
      const at: Record<string, number> = {};
      const call = s.helper.call.bind(s.helper);
      s.helper.call = (cmd, args, timeoutMs) => {
        at[cmd] = performance.now();
        return call(cmd, args, timeoutMs);
      };
      const req: InputRequest = {
        ...click,
        input: { kind: "key", combo: ["shift"], holdMs },
      };
      return { s, at, req };
    };

    it("keeps the keys down for their time, then releases them", async () => {
      const { s, at, req } = held(60);
      const res = await inject(s.helper, req);
      expect(s.calls.map((c) => c.cmd)).toEqual(["arm", "hold", "release"]);
      expect(s.calls[1]?.args).toEqual({ combo: [0xffe1], ms: 60 });
      expect((at.release as number) - (at.hold as number)).toBeGreaterThanOrEqual(55);
      expect(res.presses).toEqual([30]);
    });

    it("releases them at once when the request is stopped", async () => {
      const { s, at, req } = held(10_000);
      const stop = new AbortController();
      setTimeout(() => stop.abort(), 20);
      await expect(inject(s.helper, req, { xtest: true }, stop.signal)).rejects.toThrow(/abort/);
      expect(s.calls.map((c) => c.cmd)).toEqual(["arm", "hold", "release"]);
      expect((at.release as number) - (at.hold as number)).toBeLessThan(1000);
    });

    it("releases them when their press is never seen", async () => {
      const { s, req } = held(10_000, { silent: true });
      await expect(inject(s.helper, req)).rejects.toThrow(NoPressError);
      expect(s.calls.map((c) => c.cmd)).toEqual(["arm", "hold", "release"]);
    });
  });

  it("scrolls in notches and times the first notch", async () => {
    const s = scripted((_cmd, args, emit) => {
      for (let i = 0; i < Number(args.dy); i++) emit(press("button", 5, 20 + i));
      return { notches: args.dy };
    });
    const res = await inject(s.helper, {
      ...click,
      input: { kind: "scroll", at: { x: 5, y: 5 }, dx: 0, dy: 3 },
    });
    expect(res.pressMono).toBe(20);
    expect(res.presses).toHaveLength(3);
  });

  it("refuses drags, the driver injector until it exists, and anything but clicks through the driver", async () => {
    const s = scripted(() => ({}));
    await expect(
      inject(s.helper, {
        ...click,
        input: { kind: "drag", from: { x: 0, y: 0 }, to: { x: 9, y: 9 } },
      }),
    ).rejects.toThrow(UnsupportedInputError);
    await expect(inject(s.helper, { ...click, injector: "driver" })).rejects.toThrow(
      UnsupportedInputError,
    );
    const driver = { click: async () => {}, type: async () => {} };
    await expect(
      inject(
        s.helper,
        { ...click, input: { kind: "key", combo: ["ctrl", "s"] }, injector: "driver" },
        { xtest: true, driver },
      ),
    ).rejects.toThrow(/key through the driver injector/);
    await expect(
      inject(
        s.helper,
        {
          ...click,
          input: { kind: "scroll", at: { x: 5, y: 5 }, dx: 0, dy: 1 },
          injector: "driver",
        },
        { xtest: true, driver },
      ),
    ).rejects.toThrow(UnsupportedInputError);
    expect(s.calls.filter((c) => c.cmd === "arm")).toHaveLength(0);
  });

  it("delivers a click through the driver injector and still times it from the raw press", async () => {
    const s = scripted(() => ({}));
    const driver = {
      click: async () => {
        s.emit(press("button", 1, 41));
        s.emit({ ev: "release", kind: "button", detail: 1, mono: 90 });
      },
      type: async () => {},
    };
    const res = await inject(s.helper, { ...click, injector: "driver" }, { xtest: true, driver });
    expect(res).toMatchObject({ pressMono: 41, releaseMono: 90, injector: "driver" });
    expect(s.calls.map((c) => c.cmd)).toEqual(["arm"]);
  });
});

describe("typeText", () => {
  const pace = { firstMs: 0, firstCount: 60, restMs: 0 };
  it("does not inject the next character if cancelled during its pacing delay", async () => {
    const ac = new AbortController();
    const s = scripted((_cmd, _args, emit) => {
      emit(press("key", 30, 500));
      return { keycode: 30, mods: [] };
    });
    const typing = typeText(
      s.helper,
      { text: "ab", masked: false, pace: { ...pace, firstMs: 100 }, injector: "xtest" },
      () => {
        setTimeout(() => ac.abort(), 10);
      },
      { xtest: true },
      ac.signal,
    );
    await expect(typing).rejects.toThrow(/aborted/);
    expect(s.calls.filter((c) => c.cmd === "char")).toHaveLength(1);
  });
  it("moves the focus to the typing's window, even from another window of its group", async () => {
    const s = scripted((cmd, args, emit) => {
      if (cmd === "windows")
        return { windows: [{ ...STACK.dialog, active: true }, STACK.image], generation: 1 };
      if (cmd === "activate") return { active: args.window, changed: true, waitedMs: 3 };
      emit(press("key", 30, 500));
      return { keycode: 30, mods: [] };
    });
    await typeText(
      s.helper,
      { text: "a", masked: false, pace, injector: "xtest", window: 11 },
      () => {},
    );
    expect(s.calls.map((c) => c.cmd)).toEqual(["arm", "windows", "activate", "char"]);
  });
  it("refuses an already cancelled request before arming or activating", async () => {
    const s = scripted(() => ({}));
    const signal = AbortSignal.abort();
    await expect(
      typeText(
        s.helper,
        { text: "ab", masked: false, pace, injector: "xtest" },
        () => {},
        { xtest: true },
        signal,
      ),
    ).rejects.toThrow(/aborted/);
    expect(s.calls).toHaveLength(0);
  });
  it("types one character at a time, reports progress per key for the first 60 then every 8th, and masks at the source", async () => {
    let t = 0;
    const s = scripted((cmd, _args, emit) => {
      if (cmd === "char") {
        t += 1;
        emit(press("key", 30, t));
      }
      return { keycode: 30, mods: [] };
    });
    const text = "a".repeat(70);
    const progress: TypeProgress[] = [];
    const req: TypeRequest = { text, masked: false, pace, injector: "xtest" };
    const res = await typeText(s.helper, req, (p) => {
      progress.push(p);
    });
    expect(res).toMatchObject({ done: true, count: 70, firstPressMono: 1, injector: "xtest" });
    expect(progress.map((p) => p.count)).toEqual([
      ...Array.from({ length: 60 }, (_, i) => i + 1),
      68,
      70,
    ]);
    expect(progress[0]?.chunk).toBe("a");
    expect(progress[60]?.chunk).toBe("a".repeat(8));
    expect(progress.at(-1)?.chunk).toBe("aa");
    expect(s.calls.filter((c) => c.cmd === "char")).toHaveLength(70);
    expect(s.calls[0]?.cmd).toBe("arm");

    const masked: TypeProgress[] = [];
    await typeText(s.helper, { ...req, text: "hunter2", masked: true }, (p) => {
      masked.push(p);
    });
    expect(masked.every((p) => p.chunk === undefined)).toBe(true);
    expect(masked.at(-1)?.count).toBe(7);
    expect(JSON.stringify(s.calls.slice(-7))).toContain('"ch":"h"');
  });

  it("types through the driver as one string, reporting the first raw press and the final count", async () => {
    const s = scripted(() => ({}));
    const typed: string[] = [];
    const driver = {
      click: async () => {},
      type: async (req: TypeRequest) => {
        typed.push(req.text);
        s.emit(press("key", 43, 500));
        s.emit(press("key", 31, 540));
      },
    };
    const progress: TypeProgress[] = [];
    const res = await typeText(
      s.helper,
      { text: "hi", masked: false, pace, injector: "driver" },
      (p) => {
        progress.push(p);
      },
      { xtest: true, driver },
    );
    expect(typed).toEqual(["hi"]);
    expect(progress).toEqual([{ count: 2, chunk: "hi", pressMono: 500 }]);
    expect(res).toMatchObject({ done: true, count: 2, firstPressMono: 500, injector: "driver" });
    expect(s.calls.filter((c) => c.cmd === "char")).toHaveLength(0);
    await expect(
      typeText(s.helper, { text: "x", masked: false, pace, injector: "driver" }, () => {}),
    ).rejects.toThrow(UnsupportedInputError);
  });

  it("fails loudly on the first key without a raw press", async () => {
    const s = scripted(() => ({ keycode: 30, mods: [] }));
    await expect(
      typeText(s.helper, { text: "ab", masked: false, pace, injector: "xtest" }, () => {}),
    ).rejects.toThrow(NoPressError);
  });

  it("stops between characters once its signal aborts", async () => {
    const ac = new AbortController();
    let t = 0;
    const s = scripted((cmd, _args, emit) => {
      if (cmd === "char") {
        t += 1;
        emit(press("key", 30, t));
        if (t === 2) ac.abort();
      }
      return { keycode: 30, mods: [] };
    });
    const typing = typeText(
      s.helper,
      { text: "abcdef", masked: false, pace, injector: "xtest" },
      () => {},
      { xtest: true },
      ac.signal,
    );
    await expect(typing).rejects.toThrow(/aborted/);
    expect(s.calls.filter((c) => c.cmd === "char")).toHaveLength(2);
  });
});
