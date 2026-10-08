import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserControl } from "./control.ts";
import type { BrowserGeometrySnapshot, BrowserPoint } from "./geometry.ts";
import { BROWSER_INPUT_TIMEOUT_MS, BrowserInput, type BrowserInputOptions } from "./input.ts";
import { BrowserNative } from "./native.ts";
import type { BrowserDocument } from "./targets.ts";

const identity = {
  browserCellId: "01J00000000000000000000001",
  parentCellId: "01J00000000000000000000002",
  instance: "00000000-0000-4000-8000-000000000001",
};
const owner = { sessionId: "01J00000000000000000000003", generation: 1 };
const permit = { ...identity, owner, revision: 1, requestId: "01J00000000000000000000004" };
const click = { input: { kind: "click", at: { x: 200, y: 200 }, button: "left", count: 1 } };
const text = { text: "ab", masked: false, pace: { firstCount: 1, firstMs: 0, restMs: 0 } };
type Request = { id: number; cmd: string; [key: string]: unknown };
const retirement: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const retire of retirement.splice(0)) await retire();
  vi.useRealTimers();
});

async function fixture() {
  const control = new BrowserControl({
    ...identity,
    clearSelections: async () => {},
    secretPages: async () => [],
    reload: async () => {},
  });
  await control.set({ ...permit, holder: "agent" });
  const output = new PassThrough();
  const requests: Request[] = [];
  const requestsSeen = new Map<string, ReturnType<typeof Promise.withResolvers<Request>>>();
  let clock = 100;
  let responder: ((request: Request) => void) | undefined;
  const send = (message: object) => output.write(`${JSON.stringify(message)}\n`);
  const reply = (request: Request, value: object) => send({ id: request.id, ok: true, ...value });
  const event = (kind: "key" | "button", detail: number, mono = ++clock) => {
    send({ ev: "press", kind, detail, mono });
    send({ ev: "release", kind, detail, mono: mono + 0.1 });
  };
  const respond = (request: Request) => {
    if (request.cmd === "arm") reply(request, { mono: clock });
    else if (request.cmd === "click") {
      for (let n = 0; n < Number(request.count); n++) event("button", Number(request.button));
      reply(request, { button: request.button, presses: request.count });
    } else if (request.cmd === "scroll") {
      const count = Math.abs(Number(request.dx)) + Math.abs(Number(request.dy));
      for (let n = 0; n < count; n++) event("button", 4);
      reply(request, { notches: count });
    } else if (request.cmd === "move") reply(request, { mono: ++clock });
    else if (request.cmd === "char") {
      event("key", 38);
      reply(request, { keycode: 38, mods: [] });
    } else if (request.cmd === "keys") {
      event("key", 38);
      reply(request, { keycodes: (request.combo as string[]).map(() => 38) });
    } else throw new Error("unexpected private fixture command");
  };
  const inputPipe = new Writable({
    write(chunk, _encoding, complete) {
      const request: Request = JSON.parse(chunk.toString());
      requests.push(request);
      requestsSeen.get(request.cmd)?.resolve(request);
      if (responder) responder(request);
      else respond(request);
      complete();
    },
  });
  const nativeFatal = vi.fn(() => {
    void control.close();
  });
  const native = new BrowserNative({ input: inputPipe, output, scale: 2, onFatal: nativeFatal });
  send({ ev: "ready", mono: 100 });
  await native.ready;
  const document: BrowserDocument = Object.freeze({ tabId: "tab", revision: 1, frame: false });
  const state = {
    stale: false,
    focus: "page" as "page" | "chrome" | "unknown",
    secret: false,
    protected: false,
    backend: 30,
    frame: "root",
  };
  const hooks = new Map<string, () => void | Promise<void>>();
  const counts = new Map<string, number>();
  const step = async (name: string) => {
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    await hooks.get(`${name}:${count}`)?.();
  };
  const check = (doc: BrowserDocument) => {
    if (doc !== document || state.stale) throw new Error("private stale witness");
  };
  const geometry: BrowserInputOptions["geometry"] = {
    read: async (tabId) => {
      await step("geometry");
      if (tabId !== "tab") throw new Error("foreign tab");
      const snapshot: BrowserGeometrySnapshot = {
        document,
        content: [0, 200, 2560, 1400],
        factor: 2,
        width: 1280,
        height: 700,
        scrollX: 0,
        scrollY: 12000,
        focus: state.focus,
      };
      return snapshot;
    },
    point: (snapshot, x, y) => {
      check(snapshot.document);
      if (x < 0 || y < 0 || x >= snapshot.width || y >= snapshot.height) throw new Error("outside");
      const point: BrowserPoint = {
        screenshot: { x, y: y + 100 },
        native: { x: x * 2, y: y * 2 + 200 },
        document: { x: Math.round(x), y: Math.round(y + 12000) },
      };
      return point;
    },
  };
  const options: BrowserInputOptions = {
    control,
    native,
    geometry,
    scale: 2,
    targets: {
      check,
      command: async (doc, method) => {
        check(doc);
        await step(method);
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
        if (method === "DOM.getNodeForLocation")
          return { backendNodeId: state.backend, frameId: state.frame };
        throw new Error("unexpected CDP command");
      },
    },
    secrets: {
      inspect: async () => {
        await step("inspect");
        return { filled: false, nodeIds: state.protected ? [30] : [] };
      },
      secretFocused: async () => {
        await step("focused");
        return state.secret;
      },
    },
    onFatal: vi.fn(() => {
      void control.close();
      native.close();
    }),
  };
  const input = new BrowserInput(options);
  const requestSignal = new AbortController();
  const effects = () => requests.filter((request) => request.cmd !== "arm");
  retirement.push(async () => {
    await input.close();
    native.close();
    await control.close();
  });
  return {
    input,
    native,
    control,
    nativeFatal,
    options,
    state,
    hooks,
    requests,
    requestSignal,
    effects,
    respond,
    reply,
    event,
    respondWith(value: (request: Request) => void) {
      responder = value;
    },
    seen(command: string) {
      const wait = Promise.withResolvers<Request>();
      requestsSeen.set(command, wait);
      return wait.promise;
    },
    takeover: () =>
      control.set({
        ...identity,
        revision: 2,
        requestId: "01J00000000000000000000005",
        holder: "user",
      }),
  };
}

describe("independent BrowserInput permit and effect boundary", () => {
  it("P1 real native framing positive: mapped click and two characters have exact raw evidence", async () => {
    const f = await fixture();
    const clicked = await f.input.inject(permit, "tab", click, f.requestSignal.signal);
    expect(f.effects()[0]).toMatchObject({ cmd: "click", x: 400, y: 400 });
    expect(clicked.presses).toEqual([101]);
    const progress = vi.fn();
    const typed = await f.input.type(permit, "tab", text, f.requestSignal.signal, progress);
    expect(typed).toMatchObject({ done: true, count: 2, firstPressMono: 102 });
    expect(
      f
        .effects()
        .filter((r) => r.cmd === "char")
        .map((r) => r.ch),
    ).toEqual(["a", "b"]);
    expect(progress.mock.calls).toEqual([
      [{ count: 1, pressMono: 102 }],
      [{ count: 2, pressMono: 103 }],
    ]);
    expect(f.nativeFatal).not.toHaveBeenCalled();
  });

  it.each([
    "root-accessor",
    "nested-proxy",
    "array-accessor",
    "array-extra",
    "hidden",
    "symbol",
    "permit-accessor",
  ])("B1 inert admission rejects %s without invoking attacker code or arming", async (mode) => {
    const f = await fixture();
    const invoked = vi.fn(() => "Control_L");
    let raw: unknown = structuredClone(click);
    let authority: unknown = structuredClone(permit);
    if (mode === "root-accessor")
      raw = Object.defineProperty({}, "input", { enumerable: true, get: invoked });
    if (mode === "nested-proxy")
      raw = {
        input: new Proxy(click.input, {
          get: invoked,
          ownKeys: () => {
            invoked();
            return [];
          },
        }),
      };
    if (mode === "array-accessor")
      raw = {
        input: {
          kind: "key",
          combo: Object.defineProperty(["Ctrl", "a"], "0", { enumerable: true, get: invoked }),
        },
      };
    if (mode === "array-extra")
      raw = { input: { kind: "key", combo: Object.assign(["Ctrl", "a"], { extra: "x" }) } };
    if (mode === "hidden") Object.defineProperty(raw, "hidden", { value: 1 });
    if (mode === "symbol") Object.assign(raw as object, { [Symbol("private")]: 1 });
    if (mode === "permit-accessor")
      authority = Object.defineProperty({}, "owner", { enumerable: true, get: invoked });
    await expect(f.input.inject(authority, "tab", raw, f.requestSignal.signal)).rejects.toThrow(
      "request",
    );
    expect(invoked).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
  });

  it("B2 snapshots caller text, pace, and authority before the first await", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const hold = Promise.withResolvers<void>();
    f.hooks.set("geometry:1", () => {
      entered.resolve();
      return hold.promise;
    });
    const raw = structuredClone(text);
    const authority = structuredClone(permit);
    const pending = f.input.type(authority, "tab", raw, f.requestSignal.signal, () => {});
    await entered.promise;
    raw.text = "changed";
    raw.pace.restMs = 1000;
    authority.owner.generation = 99;
    hold.resolve();
    await expect(pending).resolves.toMatchObject({ done: true, count: 2 });
    expect(f.effects().map((r) => r.ch)).toEqual(["a", "b"]);
  });

  it.each(["DOM.getNodeForLocation:2", "geometry:2"])(
    "B3 final pointer boundary %s revokes before native dispatch",
    async (boundary) => {
      const f = await fixture();
      let transitioned: Promise<unknown> | undefined;
      f.hooks.set(boundary, () => {
        transitioned = f.takeover();
      });
      await expect(f.input.inject(permit, "tab", click, f.requestSignal.signal)).rejects.toThrow(
        "aborted",
      );
      await transitioned;
      expect(f.effects()).toEqual([]);
      expect(f.control.holder).toBe("user");
    },
  );

  it("B4 stale document after final hit cannot publish an input", async () => {
    const f = await fixture();
    f.hooks.set("DOM.getNodeForLocation:2", () => {
      f.state.stale = true;
    });
    const outcome = await f.input.inject(permit, "tab", click, f.requestSignal.signal).then(
      () => "delivered",
      () => "refused",
    );
    expect(f.effects()).toEqual([]);
    expect(outcome).toBe("refused");
  });

  it("B5 a progress consumer cannot reenter or queue an action; original owner can finish", async () => {
    const f = await fixture();
    const nested: Promise<unknown>[] = [];
    await f.input.type(permit, "tab", text, f.requestSignal.signal, () => {
      nested.push(
        expect(f.input.inject(permit, "tab", click, f.requestSignal.signal)).rejects.toThrow(
          "busy",
        ),
      );
    });
    await Promise.all(nested);
    expect(f.effects().map((r) => r.cmd)).toEqual(["char", "char"]);
  });

  it("B6 takeover during a pending real native character fences and drains without a lease cycle", async () => {
    const f = await fixture();
    const charSeen = f.seen("char");
    f.respondWith((r) => {
      if (r.cmd !== "char") f.respond(r);
    });
    const pending = f.input.type(permit, "tab", text, f.requestSignal.signal, () => {});
    const refused = expect(pending).rejects.toThrow("aborted");
    await charSeen;
    const changing = f.takeover();
    expect(f.control.holder).toBe("user");
    expect(f.native.alive).toBe(false);
    const denied = expect(changing).rejects.toThrow("locked");
    await refused;
    await denied;
    await f.input.close();
    expect(f.nativeFatal).toHaveBeenCalledOnce();
    expect(f.effects()).toHaveLength(1);
  });

  it.each(["old", "wrong-key", "missing-second-click"])(
    "B7 %s raw evidence never counts as current delivery",
    async (mode) => {
      const f = await fixture();
      f.respondWith((r) => {
        if (r.cmd !== "click") return f.respond(r);
        f.event("button", mode === "wrong-key" ? 2 : 1, mode === "old" ? 99 : 101);
        f.reply(r, { button: 1, presses: r.count });
      });
      const raw = structuredClone(click);
      if (mode === "missing-second-click") raw.input.count = 2;
      await expect(f.input.inject(permit, "tab", raw, f.requestSignal.signal)).rejects.toThrow(
        "delivery",
      );
      expect(f.effects()).toHaveLength(1);
      expect(f.options.onFatal).toHaveBeenCalledOnce();
      expect(f.control.holder).toBe("user");
    },
  );

  it("P2 delayed raw native evidence after acknowledgement remains a valid positive", async () => {
    const f = await fixture();
    f.respondWith((r) => {
      if (r.cmd !== "click") return f.respond(r);
      f.reply(r, { button: 1, presses: 1 });
      setTimeout(() => f.event("button", 1, 101), 5);
    });
    await expect(
      f.input.inject(permit, "tab", click, f.requestSignal.signal),
    ).resolves.toMatchObject({ presses: [101] });
    expect(f.options.onFatal).not.toHaveBeenCalled();
  });

  it("B8 secret focus appearing after first progress prevents a second physical character", async () => {
    const f = await fixture();
    const outcome = await f.input
      .type(permit, "tab", text, f.requestSignal.signal, () => {
        f.state.secret = true;
      })
      .then(
        () => "delivered",
        (error) => error.message,
      );
    expect(f.effects().map((r) => r.ch)).toEqual(["a"]);
    expect(outcome).toContain("secret");
  });

  it("B9 pending progress cannot defeat the total action deadline", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const entered = Promise.withResolvers<void>();
    const pending = f.input.type(permit, "tab", text, f.requestSignal.signal, () => {
      entered.resolve();
      return new Promise<void>(() => {});
    });
    const refused = expect(pending).rejects.toThrow("aborted");
    await entered.promise;
    await vi.advanceTimersByTimeAsync(BROWSER_INPUT_TIMEOUT_MS);
    await refused;
    await f.control.close();
    expect(f.effects()).toHaveLength(1);
  });

  it.each(["physical-close", "request-abort"])(
    "B10 late progress resolution after %s never sends remaining text",
    async (mode) => {
      const f = await fixture();
      const entered = Promise.withResolvers<void>();
      const hold = Promise.withResolvers<void>();
      const pending = f.input.type(permit, "tab", text, f.requestSignal.signal, () => {
        entered.resolve();
        return hold.promise;
      });
      const refused = expect(pending).rejects.toThrow("aborted");
      await entered.promise;
      const closing =
        mode === "physical-close" ? f.input.close() : Promise.resolve(f.requestSignal.abort());
      await refused;
      await closing;
      hold.resolve();
      await Promise.resolve();
      expect(f.effects().map((r) => r.ch)).toEqual(["a"]);
    },
  );
});
