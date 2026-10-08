import { describe, expect, it, vi } from "vitest";
import { BrowserControl } from "./control.ts";
import type { BrowserGeometrySnapshot } from "./geometry.ts";
import { BrowserInput, type BrowserInputOptions } from "./input.ts";
import type { BrowserNative } from "./native.ts";
import type { NativeEvent } from "./native-schema.ts";
import type { BrowserDocument } from "./targets.ts";

const identity = {
  browserCellId: "01J00000000000000000000001",
  parentCellId: "01J00000000000000000000002",
  instance: "11111111-1111-4111-8111-111111111111",
};
const owner = { sessionId: "01J00000000000000000000003", generation: 1 };
const permit = { ...identity, revision: 1, requestId: "01J00000000000000000000004", owner };
const click = { input: { kind: "click", at: { x: 100, y: 150 }, button: "left", count: 1 } };
const typing = { text: "Hello中文", masked: false, pace: { firstCount: 0, firstMs: 0, restMs: 0 } };

async function setup(scale: 1 | 2 = 2) {
  const control = new BrowserControl({
    ...identity,
    clearSelections: async () => {},
    secretPages: async () => [],
    reload: async () => {},
  });
  await control.set({ ...permit, holder: "agent" });
  const abort = new AbortController();
  const document = Object.freeze({ tabId: "tab", revision: 1, frame: false });
  const state = {
    focus: "page" as "page" | "chrome" | "unknown",
    secret: false,
    protectedNode: false,
    stale: false,
    hit: 10,
    frame: "root",
    rawEvents: true,
    contentX: 20 * scale,
    revision: 1,
  };
  const hooks = new Map<string, () => void | Promise<void>>();
  const counts = new Map<string, number>();
  const checkpoint = async (name: string) => {
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    await hooks.get(`${name}:${count}`)?.();
  };
  const check = vi.fn((_document: BrowserDocument) => {
    if (state.stale) throw new Error("private stale cause");
  });
  const geometry = {
    read: vi.fn(async (tabId: string): Promise<BrowserGeometrySnapshot> => {
      await checkpoint("geometry");
      if (tabId !== "tab") throw new Error("foreign tab");
      return {
        document:
          state.revision === document.revision
            ? document
            : Object.freeze({ ...document, revision: state.revision }),
        content: [state.contentX, 100 * scale, 1000 * scale, 600 * scale],
        factor: scale * 1.25,
        width: 800,
        height: 480,
        scrollX: 0,
        scrollY: 12000,
        focus: state.focus,
      };
    }),
    point: vi.fn((snapshot: BrowserGeometrySnapshot, pointX: number, pointY: number) => {
      if (pointX < 0 || pointY < 0 || pointX >= snapshot.width || pointY >= snapshot.height)
        throw new Error("outside page");
      return {
        native: {
          x: Math.round(snapshot.content[0] + pointX * snapshot.factor),
          y: Math.round(snapshot.content[1] + pointY * snapshot.factor),
        },
        screenshot: { x: 100, y: 150 },
        document: { x: Math.round(pointX), y: Math.round(pointY + snapshot.scrollY) },
      };
    }),
  };
  const commands: { name: string; args: Record<string, unknown> }[] = [];
  const listeners = new Set<(event: Readonly<NativeEvent>) => void>();
  let clock = 100;
  const emit = (kind: "key" | "button", detail: number) => {
    if (!state.rawEvents) return;
    for (const ev of ["press", "release"] as const) {
      const event = { ev, kind, detail, mono: ++clock } as NativeEvent;
      for (const listener of listeners) listener(event);
    }
  };
  const nativeCommand = vi.fn(async (name: string, args: Record<string, unknown>) => {
    commands.push({ name, args });
    await checkpoint(`native.${name}`);
    if (name === "arm" || name === "ping") return { mono: clock };
    if (name === "settle")
      return { changed: [[2, 4, 40, 50]], lastChange: clock, quiet: true, noVisibleChange: false };
    if (name === "move") return { mono: ++clock };
    if (name === "pointer") return { x: 40, y: 220 };
    if (name === "cancel") return { buttons: 1, escaped: true };
    if (name === "down" || name === "up") {
      const event = {
        ev: name === "down" ? "press" : "release",
        kind: "button",
        detail: Number(args.button),
        mono: ++clock,
      } as NativeEvent;
      if (state.rawEvents) for (const listener of listeners) listener(event);
      return name === "down" ? { button: args.button } : { button: args.button, released: true };
    }
    if (name === "click" || name === "userClick") {
      for (let count = 0; count < Number(args.count); count += 1)
        emit("button", Number(args.button));
      return { button: args.button, presses: args.count };
    }
    if (name === "scroll") {
      const count = Math.abs(Number(args.dx)) + Math.abs(Number(args.dy));
      for (let position = 0; position < count; position += 1) emit("button", 4);
      return { notches: count };
    }
    if (name === "keys" || name === "userKeys") {
      emit("key", 30);
      return { keycodes: [30] };
    }
    if (name === "char") {
      emit("key", 31);
      return { keycode: 31, mods: [] };
    }
    throw new Error("unexpected native command");
  });
  const command = vi.fn(async (_document: BrowserDocument, method: string, _params: unknown) => {
    await checkpoint(method);
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
    if (method === "DOM.getNodeForLocation")
      return { backendNodeId: state.hit, frameId: state.frame };
    throw new Error("unexpected CDP command");
  });
  const onFatal = vi.fn();
  const options: BrowserInputOptions = {
    control,
    targets: { check, command },
    geometry,
    secrets: {
      inspect: vi.fn(async () => {
        await checkpoint("inspect");
        return { filled: false, nodeIds: state.protectedNode ? [10] : [] };
      }),
      secretFocused: vi.fn(async () => {
        await checkpoint("focused");
        return state.secret;
      }),
    },
    native: {
      command: nativeCommand as unknown as BrowserNative["command"],
      onEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    scale,
    onFatal,
  };
  const input = new BrowserInput(options);
  const effects = () => commands.filter((entry) => entry.name !== "arm");
  const progress = vi.fn();
  return {
    input,
    control,
    abort,
    state,
    hooks,
    geometry,
    command,
    options,
    nativeCommand,
    commands,
    effects,
    onFatal,
    listeners,
    check,
    progress,
  };
}

describe("browser drags", () => {
  const drag = (more: object = {}) => ({
    input: {
      kind: "drag",
      from: { x: 100, y: 150 },
      to: { x: 300, y: 250 },
      path: [{ x: 200, y: 200 }],
      button: "left",
      mods: ["shift"],
      durationMs: 100,
      ...more,
    },
  });
  // Model pixel → native pixel in the fixture's geometry at scale 2.
  const native = (x: number, y: number) => ({
    x: Math.round(40 + ((x * 2 - 40) / 2.5) * 2.5),
    y: Math.round(200 + ((y * 2 - 200) / 2.5) * 2.5),
  });

  it("presses at the start, follows every point inside the checked page and lets go at the end", async () => {
    const peer = await setup();
    const result = await peer.input.inject(permit, "tab", drag(), peer.abort.signal);
    const effects = peer.effects();
    expect(effects[0]).toEqual({
      name: "down",
      args: { ...native(100, 150), button: 1, mods: ["Shift_L"] },
    });
    expect(effects.at(-1)).toEqual({ name: "up", args: { ...native(300, 250), button: 1 } });
    const moves = effects.filter((e) => e.name === "move").map((e) => e.args);
    expect(moves.length).toBeGreaterThanOrEqual(5);
    expect(moves).toContainEqual(native(200, 200));
    expect(moves.at(-1)).toEqual(native(300, 250));
    expect(
      peer.command.mock.calls.filter(([, method]) => method === "DOM.getNodeForLocation"),
    ).toHaveLength(4);
    expect(result.presses).toEqual([result.pressMono]);
    await peer.control.close();
  });

  it.each([
    drag({ to: { x: 1279, y: 250 } }),
    drag({ path: [{ x: 5, y: 5 }] }),
    drag({ mods: ["Alt"] }),
    drag({ button: "back" }),
    drag({ durationMs: 10_001 }),
    drag({ path: Array.from({ length: 63 }, () => ({ x: 200, y: 200 })) }),
  ])(
    "refuses a drag outside the page or out of bounds before any native input %#",
    async (request) => {
      const peer = await setup();
      await expect(peer.input.inject(permit, "tab", request, peer.abort.signal)).rejects.toThrow();
      expect(peer.effects()).toHaveLength(0);
      await peer.control.close();
    },
  );

  it("refuses a drag onto a protected field before any native input", async () => {
    const peer = await setup();
    peer.hooks.set("inspect:2", () => {
      peer.state.protectedNode = true;
    });
    await expect(peer.input.inject(permit, "tab", drag(), peer.abort.signal)).rejects.toThrow(
      "secret",
    );
    expect(peer.effects()).toHaveLength(0);
    await peer.control.close();
  });

  it("is cancelled where it is when it is stopped part-way, never moving back to the start", async () => {
    const peer = await setup();
    peer.hooks.set("native.move:3", () => peer.abort.abort());
    await expect(peer.input.inject(permit, "tab", drag(), peer.abort.signal)).rejects.toThrow(
      "aborted",
    );
    expect(peer.effects().at(-1)).toEqual({ name: "cancel", args: {} });
    expect(peer.effects().filter((e) => e.name === "up")).toEqual([]);
    await peer.control.close();
  });

  it("is cancelled before its drop when the page moved", async () => {
    const peer = await setup();
    peer.hooks.set("geometry:6", () => {
      peer.state.contentX += 2;
    });
    await expect(peer.input.inject(permit, "tab", drag(), peer.abort.signal)).rejects.toThrow(
      "target",
    );
    expect(peer.effects().at(-1)).toEqual({ name: "cancel", args: {} });
    expect(peer.effects().filter((e) => e.name === "up")).toEqual([]);
    await peer.control.close();
  });

  it("refuses a drag whose page changed between reading its drop and its own snapshot", async () => {
    const peer = await setup();
    peer.hooks.set("geometry:5", () => {
      peer.state.revision = 2;
    });
    await expect(peer.input.inject(permit, "tab", drag(), peer.abort.signal)).rejects.toThrow(
      "target",
    );
    expect(peer.effects()).toHaveLength(0);
    await peer.control.close();
  });

  it("glides a move with a duration from where the pointer is", async () => {
    const peer = await setup();
    await peer.input.inject(
      permit,
      "tab",
      { input: { kind: "move", to: { x: 300, y: 250 }, durationMs: 100 } },
      peer.abort.signal,
    );
    const moves = peer.effects().filter((e) => e.name === "move");
    expect(peer.effects()[0]?.name).toBe("pointer");
    expect(moves.length).toBeGreaterThanOrEqual(5);
    expect(moves.at(-1)?.args).toEqual(native(300, 250));
    await peer.control.close();
  });
});

describe("guarded browser input", () => {
  it("allows browser shortcuts and modifiers only through a completed manual grant", async () => {
    const f = await setup();
    await expect(
      f.input.inject(
        permit,
        "tab",
        { input: { kind: "key", combo: ["ctrl", "l"] } },
        f.abort.signal,
      ),
    ).rejects.toThrow();
    expect(f.effects()).toEqual([]);
    const { owner: _, ...user } = { ...permit, revision: 2 };
    await f.control.set({ ...user, holder: "user" });
    await f.input.manual(user, { kind: "key", combo: ["ctrl", "l"] }, f.abort.signal);
    await f.input.manual(
      user,
      {
        kind: "click",
        at: { x: 99.9, y: 100.1 },
        button: "left",
        count: 1,
        mods: ["alt", "super"],
      },
      f.abort.signal,
    );
    expect(f.effects()).toEqual([
      { name: "userKeys", args: { combo: ["Control_L", "l"] } },
      {
        name: "userClick",
        args: { x: 99, y: 100, button: 1, count: 1, holdMs: 0, mods: ["Alt_L", "Super_L"] },
      },
    ]);
  });
  it("delivers the entire manual wheel range in bounded native batches", async () => {
    const f = await setup();
    const { owner: _, ...user } = { ...permit, revision: 2 };
    await f.control.set({ ...user, holder: "user" });
    const result = await f.input.manual(
      user,
      { kind: "scroll", at: { x: 100, y: 100 }, dx: 32, dy: -32 },
      f.abort.signal,
    );
    expect(f.effects()).toEqual([
      { name: "scroll", args: { x: 100, y: 100, dx: 30, dy: -30 } },
      { name: "scroll", args: { x: 100, y: 100, dx: 2, dy: -2 } },
    ]);
    expect(result.kind === "input" && result.receipt.presses).toHaveLength(64);
  });
  it("types manual bilingual secrets with native receipts and no page inspection or progress", async () => {
    const f = await setup();
    const { owner: _, ...user } = { ...permit, revision: 2 };
    await f.control.set({ ...user, holder: "user" });
    f.state.secret = true;
    f.state.focus = "chrome";
    const result = await f.input.manual(user, { kind: "text", text: "密碼A🦊" }, f.abort.signal);
    expect(result).toMatchObject({
      kind: "text",
      receipt: { count: 4, done: true, injector: "xtest" },
    });
    expect(JSON.stringify(result)).not.toContain("密碼");
    expect(f.effects().map((effect) => effect.args.ch)).toEqual(["密", "碼", "A", "🦊"]);
    expect(f.geometry.read).not.toHaveBeenCalled();
    expect(f.command).not.toHaveBeenCalled();
    expect(f.options.secrets.secretFocused).not.toHaveBeenCalled();
    expect(f.progress).not.toHaveBeenCalled();
    await expect(
      f.input.manual(permit, { kind: "text", text: "x" }, f.abort.signal),
    ).rejects.toThrow();
  });

  it.each([1, 2] as const)(
    "keeps manual points in physical display pixels at scale %s",
    async (scale) => {
      const f = await setup(scale);
      const { owner: _, ...user } = { ...permit, revision: 2 };
      await f.control.set({ ...user, holder: "user" });
      const at = { x: 1280 * scale - 1, y: 800 * scale - 1 };
      await f.input.manual(user, { ...click.input, at }, f.abort.signal);
      expect(f.effects()).toEqual([
        { name: "userClick", args: { ...at, button: 1, count: 1, mods: [], holdMs: 0 } },
      ]);
      expect(f.geometry.point).not.toHaveBeenCalled();
      await expect(
        f.input.manual(user, { ...click.input, at: { ...at, x: at.x + 1 } }, f.abort.signal),
      ).rejects.toThrow();
      expect(f.effects()).toHaveLength(1);
    },
  );

  it("captures manual input inertly and cancels before native dispatch on handback", async () => {
    const f = await setup();
    const { owner: _, ...user } = { ...permit, revision: 2 };
    await f.control.set({ ...user, holder: "user" });
    const getter = vi.fn(() => "secret");
    await expect(
      f.input.manual(
        user,
        {
          kind: "text",
          get text() {
            return getter();
          },
        },
        f.abort.signal,
      ),
    ).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    let returning: Promise<unknown> | undefined;
    f.hooks.set("native.arm:1", () => {
      returning = f.control.set({ ...permit, revision: 3, holder: "agent" });
    });
    await expect(
      f.input.manual(user, { kind: "text", text: "secret" }, f.abort.signal),
    ).rejects.toThrow();
    await returning;
    expect(f.effects()).toEqual([]);
    expect(f.progress).not.toHaveBeenCalled();
  });
  it("returns native timing and settled device geometry under the current grant", async () => {
    const f = await setup();
    expect(await f.input.timing(permit, "tab", { kind: "clock" }, f.abort.signal)).toEqual({
      mono: 100,
    });
    expect(
      await f.input.timing(permit, "tab", { kind: "settle", request: {} }, f.abort.signal),
    ).toEqual({
      changed: [{ x: 2, y: 4, w: 40, h: 50 }],
      lastChangeMono: 100,
      quiet: true,
      noVisibleChange: false,
    });
    expect(f.nativeCommand).toHaveBeenLastCalledWith(
      "settle",
      { quietMs: 250, firstMs: 1500, timeoutMs: 3000 },
      expect.any(AbortSignal),
    );
  });
  it.each(["clock", "settle"] as const)(
    "cancels pending %s on takeover without releasing a stale result",
    async (kind) => {
      const f = await setup();
      f.hooks.set(`native.${kind === "clock" ? "ping" : "settle"}:1`, () => {
        void f.control.set({
          ...identity,
          requestId: "01J00000000000000000000005",
          revision: 2,
          holder: "user",
        });
      });
      await expect(
        f.input.timing(
          permit,
          "tab",
          kind === "clock" ? { kind } : { kind, request: {} },
          f.abort.signal,
        ),
      ).rejects.toThrow("aborted");
    },
  );
  it("rejects unbounded settle and foreign timing permits before native dispatch", async () => {
    const f = await setup();
    await expect(
      f.input.timing(
        permit,
        "tab",
        { kind: "settle", request: { timeoutMs: 30001 } },
        f.abort.signal,
      ),
    ).rejects.toThrow("Browser input refused");
    await expect(
      f.input.timing({ ...permit, revision: 0 }, "tab", { kind: "clock" }, f.abort.signal),
    ).rejects.toThrow();
    expect(f.commands).toEqual([]);
  });
  it.each([1, 2] as const)(
    "maps screenshot clicks to native and long document coordinates at scale %s",
    async (scale) => {
      const peer = await setup(scale);
      const result = await peer.input.inject(permit, "tab", click, peer.abort.signal);
      expect(peer.effects()).toEqual([
        {
          name: "click",
          args: { x: 100 * scale, y: 150 * scale, button: 1, count: 1, holdMs: 0, mods: [] },
        },
      ]);
      expect(peer.command).toHaveBeenCalledWith(
        expect.anything(),
        "DOM.getNodeForLocation",
        { x: 64, y: 12040, includeUserAgentShadowDOM: false, ignorePointerEventsNone: false },
        expect.anything(),
      );
      expect(result).toEqual({
        armedMono: 100,
        pressMono: 101,
        presses: [101],
        releaseMono: 102,
        injector: "xtest",
      });
      expect(peer.listeners.size).toBe(0);
      await peer.control.close();
    },
  );

  it.each([
    { kind: "move", to: { x: 100, y: 150 } },
    { kind: "scroll", at: { x: 100, y: 150 }, dx: 1, dy: -2 },
    { kind: "key", combo: ["Ctrl", "a"] },
  ])("performs permitted $kind with native timing", async (input) => {
    const peer = await setup();
    const result = await peer.input.inject(permit, "tab", { input }, peer.abort.signal);
    expect(peer.effects()).toHaveLength(1);
    expect(result.pressMono).toBeGreaterThanOrEqual(result.armedMono);
    expect(result.presses).toHaveLength(input.kind === "scroll" ? 3 : input.kind === "key" ? 1 : 0);
    await peer.control.close();
  });

  it("types Unicode and exposes counts and timing without text even when unmasked", async () => {
    const peer = await setup();
    const result = await peer.input.type(permit, "tab", typing, peer.abort.signal, peer.progress);
    expect(peer.effects().map((entry) => entry.args.ch)).toEqual([...typing.text]);
    expect(result).toEqual({
      done: true,
      count: 7,
      firstPressMono: 101,
      armedMono: 100,
      injector: "xtest",
    });
    expect(peer.progress).toHaveBeenCalledWith({ count: 7, pressMono: 113 });
    expect(JSON.stringify(peer.progress.mock.calls)).not.toContain("chunk");
    expect(peer.options.secrets.secretFocused).toHaveBeenCalledTimes(7);
    await peer.control.close();
  });

  it.each([
    "native.arm:1",
    "geometry:1",
    "Page.getFrameTree:1",
    "inspect:1",
    "DOM.getNodeForLocation:1",
    "geometry:2",
    "DOM.getNodeForLocation:2",
  ])("stops pointer dispatch when takeover occurs at %s", async (boundary) => {
    const peer = await setup();
    let transition: Promise<unknown> | undefined;
    peer.hooks.set(boundary, () => {
      transition = peer.control.set({
        ...identity,
        revision: 2,
        requestId: "01J00000000000000000000005",
        holder: "user",
      });
    });
    await expect(peer.input.inject(permit, "tab", click, peer.abort.signal)).rejects.toThrow(
      "aborted",
    );
    expect(peer.effects()).toHaveLength(0);
    await transition;
    expect(peer.control.holder).toBe("user");
  });

  it.each(["geometry:1", "focused:1", "geometry:2"])(
    "stops keyboard dispatch after request abort at %s",
    async (boundary) => {
      const peer = await setup();
      peer.hooks.set(boundary, () => peer.abort.abort());
      await expect(
        peer.input.type(permit, "tab", typing, peer.abort.signal, peer.progress),
      ).rejects.toThrow("aborted");
      expect(peer.effects()).toHaveLength(0);
      await peer.control.close();
    },
  );

  it.each(["chrome", "unknown"] as const)("refuses keyboard focus on %s", async (focus) => {
    const peer = await setup();
    peer.state.focus = focus;
    await expect(
      peer.input.type(permit, "tab", typing, peer.abort.signal, peer.progress),
    ).rejects.toThrow("focus");
    expect(peer.effects()).toHaveLength(0);
  });

  it.each(["secret", "focus", "abort"])(
    "halts remaining characters when %s changes during progress",
    async (change) => {
      const peer = await setup();
      await expect(
        peer.input.type(
          permit,
          "tab",
          { ...typing, pace: { firstCount: 1, firstMs: 0, restMs: 1 } },
          peer.abort.signal,
          () => {
            if (change === "secret") peer.state.secret = true;
            if (change === "focus") peer.state.focus = "chrome";
            if (change === "abort") peer.abort.abort();
          },
        ),
      ).rejects.toThrow();
      expect(peer.effects()).toHaveLength(1);
      await peer.control.close();
    },
  );

  it.each(["secret", "foreign-frame", "changed-hit", "changed-geometry", "stale"])(
    "refuses %s pointer targets before effect",
    async (mode) => {
      const peer = await setup();
      if (mode === "secret") peer.state.protectedNode = true;
      if (mode === "foreign-frame") peer.state.frame = "child";
      if (mode === "changed-hit")
        peer.hooks.set("DOM.getNodeForLocation:2", () => {
          peer.state.hit = 11;
        });
      if (mode === "changed-geometry")
        peer.hooks.set("geometry:2", () => {
          peer.state.contentX += 2;
        });
      if (mode === "stale")
        peer.hooks.set("inspect:1", () => {
          peer.state.stale = true;
        });
      await expect(peer.input.inject(permit, "tab", click, peer.abort.signal)).rejects.toThrow();
      expect(peer.effects()).toHaveLength(0);
    },
  );

  it("does not interleave or queue a second action", async () => {
    const peer = await setup();
    const gate = Promise.withResolvers<void>();
    peer.hooks.set("geometry:1", () => gate.promise);
    const first = peer.input.inject(permit, "tab", click, peer.abort.signal);
    await expect(peer.input.inject(permit, "tab", click, peer.abort.signal)).rejects.toThrow(
      "busy",
    );
    gate.resolve();
    await first;
    expect(peer.effects()).toHaveLength(1);
    await peer.control.close();
  });

  it("close aborts a pending action, waits for its lease, and prevents a future action", async () => {
    const peer = await setup();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    peer.hooks.set("geometry:1", () => {
      entered.resolve();
      return gate.promise;
    });
    const action = peer.input.inject(permit, "tab", click, peer.abort.signal);
    const refusal = expect(action).rejects.toThrow("aborted");
    await entered.promise;
    let finished = false;
    const close = peer.input.close().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    gate.resolve();
    await refusal;
    await close;
    await peer.control.close();
    expect(peer.effects()).toHaveLength(0);
    await expect(peer.input.inject(permit, "tab", click, peer.abort.signal)).rejects.toThrow(
      "closed",
    );
  });

  it.each([
    { input: { kind: "key", combo: ["Ctrl", "l"] } },
    { input: { kind: "key", combo: ["F12"] } },
    { input: { kind: "scroll", at: { x: 100, y: 150 }, dx: 0, dy: 0 } },
    { ...click, window: 99 },
    { ...click, injector: "driver" },
    { input: { ...click.input, at: { x: 1280, y: 150 } } },
    { input: { ...click.input, mods: ["Alt"] } },
    { input: { ...click.input, count: 4 } },
  ])(
    "rejects invalid or privileged requests without touching the native helper %#",
    async (request) => {
      const peer = await setup();
      await expect(peer.input.inject(permit, "tab", request, peer.abort.signal)).rejects.toThrow();
      expect(peer.commands).toHaveLength(0);
    },
  );

  it("refuses plain screenshot coordinates that point into browser chrome", async () => {
    const peer = await setup();
    await expect(
      peer.input.inject(
        permit,
        "tab",
        { input: { ...click.input, at: { x: 100, y: 50 } } },
        peer.abort.signal,
      ),
    ).rejects.toThrow();
    expect(peer.effects()).toHaveLength(0);
  });

  it.each(["accessor", "proxy"])(
    "does not invoke an untrusted %s during request admission",
    async (mode) => {
      const peer = await setup();
      const invoked = vi.fn(() => click.input);
      const request =
        mode === "accessor"
          ? Object.defineProperty({}, "input", { enumerable: true, get: invoked })
          : new Proxy(click, { get: invoked });
      await expect(peer.input.inject(permit, "tab", request, peer.abort.signal)).rejects.toThrow(
        "request",
      );
      expect(invoked).not.toHaveBeenCalled();
      expect(peer.commands).toHaveLength(0);
    },
  );

  it("refuses a stale permit and a foreign tab", async () => {
    const peer = await setup();
    await expect(
      peer.input.inject({ ...permit, revision: 2 }, "tab", click, peer.abort.signal),
    ).rejects.toThrow();
    expect(peer.commands).toHaveLength(0);
    await expect(peer.input.inject(permit, "foreign", click, peer.abort.signal)).rejects.toThrow();
    expect(peer.effects()).toHaveLength(0);
  });

  it.each(["\0", "\ud800", "\u007f"])(
    "refuses invalid typing characters before arming %#",
    async (text) => {
      const peer = await setup();
      await expect(
        peer.input.type(permit, "tab", { ...typing, text }, peer.abort.signal, peer.progress),
      ).rejects.toThrow("request");
      expect(peer.commands).toHaveLength(0);
    },
  );

  it("does not echo a private exception from a progress callback and releases its lease", async () => {
    const peer = await setup();
    await expect(
      peer.input.type(permit, "tab", typing, peer.abort.signal, () => {
        throw new Error("do-not-expose-typing-content");
      }),
    ).rejects.toThrow(/^Browser input refused: unavailable$/u);
    await peer.control.close();
    expect(peer.listeners.size).toBe(0);
  });

  it("Stop releases the action lease even when a progress consumer never settles", async () => {
    const peer = await setup();
    const entered = Promise.withResolvers<void>();
    const forever = new Promise<void>(() => {});
    const action = peer.input.type(
      permit,
      "tab",
      { ...typing, pace: { firstCount: 1, firstMs: 0, restMs: 0 } },
      peer.abort.signal,
      () => {
        entered.resolve();
        return forever;
      },
    );
    const refusal = expect(action).rejects.toThrow("aborted");
    await entered.promise;
    const closing = peer.control.close();
    await refusal;
    await closing;
    expect(peer.effects()).toHaveLength(1);
    expect(peer.control.holder).toBe("user");
    expect(peer.listeners.size).toBe(0);
  });

  it("waits for a live progress consumer before continuing valid typing", async () => {
    const peer = await setup();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const action = peer.input.type(
      permit,
      "tab",
      { ...typing, text: "ab", pace: { firstCount: 1, firstMs: 0, restMs: 0 } },
      peer.abort.signal,
      (progress) => {
        if (progress.count === 1) {
          entered.resolve();
          return gate.promise;
        }
      },
    );
    await entered.promise;
    expect(peer.effects()).toHaveLength(1);
    gate.resolve();
    await expect(action).resolves.toMatchObject({ done: true, count: 2 });
    expect(peer.effects()).toHaveLength(2);
    await peer.control.close();
  });

  it("does not claim delivery without raw native press evidence and closes the owner", async () => {
    const peer = await setup();
    peer.state.rawEvents = false;
    await expect(peer.input.inject(permit, "tab", click, peer.abort.signal)).rejects.toThrow(
      "delivery",
    );
    expect(peer.onFatal).toHaveBeenCalledOnce();
    expect(peer.listeners.size).toBe(0);
    await expect(peer.input.inject(permit, "tab", click, peer.abort.signal)).rejects.toThrow(
      "closed",
    );
    await peer.control.close();
  });
});
