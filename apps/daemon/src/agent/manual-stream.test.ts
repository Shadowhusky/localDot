import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANUAL_STREAM_CLOSE, type ManualStreamInput, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { DesktopdClient } from "../desktopd/client.ts";
import { FakeDesktopd } from "../desktopd/testing/fake-desktopd.ts";
import { EventLog } from "../event-log.ts";
import { WS_TOKEN_PREFIX } from "../guard.ts";
import { attachUpgradeRouter, WS_PROTOCOL } from "../upgrade-router.ts";
import type { ManualDesktop, ManualDesktopSource } from "./manual-input.ts";
import { ManualStream, manualStreamRoute } from "./manual-stream.ts";
import { AgentSession } from "./session.ts";

const TOKEN = "m".repeat(43);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});

async function setup(screen: { clicksOnly?: boolean; confirms?: boolean; user?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "localdot-manual-stream-")),
    log = new EventLog(home),
    id = log.createSession("Synthetic direct control"),
    session = new AgentSession(id, ulid(), "Synthetic task", log);
  session.beginBrain();
  // dot hands the computer over, or the user takes it themselves.
  if (screen.user) session.takeControl();
  const outcome = screen.user
    ? Promise.resolve({ by: "user" as const })
    : session.takeover("login", "Sample login").catch(() => ({ by: "stop" as const }));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const requestId = session.pendingTakeover;
  if (!requestId || session.manualControl !== "ready") throw new Error("missing takeover fixture");
  const fake = new FakeDesktopd({
    type: (body) => ({
      progress: [],
      result: {
        done: true,
        count: [...(body as { text: string }).text].length,
        firstPressMono: 1,
        armedMono: 0,
        injector: "xtest",
      },
    }),
  });
  const client = new DesktopdClient(
    { baseUrl: "http://owned-desktop.invalid", token: fake.token },
    fake.fetchImpl,
  );
  const desktop = vi.fn<ManualDesktopSource>(
    (): ManualDesktop => ({
      screen: { w: 2560, h: 1600 },
      client,
      prepare: async () => {},
      check: () => {},
      release: () => {},
      ...(screen.clicksOnly
        ? {}
        : {
            letGo: async () => {
              await client.release();
            },
          }),
      ...(screen.confirms
        ? {
            confirm: async () => {
              await client.release();
            },
          }
        : {}),
    }),
  );
  const server: Server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  attachUpgradeRouter(server, { port, token: TOKEN }, [
    manualStreamRoute({ session: (key) => (key === id ? session : undefined), manual: desktop }),
  ]);
  const sockets: WebSocket[] = [];
  const open = (
    path = `/api/agent/sessions/${id}/takeover/${requestId}/stream`,
    protocols = [WS_PROTOCOL, `${WS_TOKEN_PREFIX}${TOKEN}`],
  ) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, {
      origin: `http://127.0.0.1:${port}`,
    });
    ws.on("error", () => {});
    sockets.push(ws);
    return ws;
  };
  cleanup.push(async () => {
    for (const ws of sockets) ws.terminate();
    session.stop();
    await outcome;
    await session.toolsSettled();
    await new Promise((resolve) => server.close(resolve));
    log.close();
    rmSync(home, { force: true, recursive: true });
  });
  return { session, id, requestId, fake, desktop, log, open, outcome };
}

const opened = (ws: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_request, response) =>
      reject(new Error(String(response.statusCode))),
    );
    ws.once("error", reject);
  });
const refusal = (ws: WebSocket) =>
  new Promise<number>((resolve) => {
    ws.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    ws.once("open", () => resolve(101));
  });
const closed = (ws: WebSocket) =>
  new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
const acked = (ws: WebSocket, done: number) =>
  new Promise<void>((resolve) => {
    const listen = (data: unknown) => {
      if ((JSON.parse(String(data)) as { done: number }).done < done) return;
      ws.off("message", listen);
      resolve();
    };
    ws.on("message", listen);
  });
const send = (ws: WebSocket, inputs: ManualStreamInput[]) => {
  for (const input of inputs) ws.send(JSON.stringify(input));
};
const typing = (text: string): ManualStreamInput[] =>
  [...text].map((ch) => ({ kind: "text", text: ch }));

// What reached the desktop, with the typing calls the stream joined read back as one run each.
function received(fake: FakeDesktopd) {
  const out: (string | object)[] = [];
  for (const call of fake.calls) {
    const body = call.body as { text?: string; input?: object } | null;
    if (call.path === "/type") {
      const last = out.length - 1;
      if (typeof out[last] === "string") out[last] += body?.text ?? "";
      else out.push(body?.text ?? "");
    } else out.push(call.path === "/input" ? (body?.input ?? {}) : call.path);
  }
  return out;
}

describe("the user's direct control stream", () => {
  it("opens only for the takeover the user holds, with the install token", async () => {
    const f = await setup();
    expect(await refusal(f.open(undefined, [WS_PROTOCOL]))).toBe(403);
    expect(await refusal(f.open(`/api/agent/sessions/${f.id}/takeover/${ulid()}/stream`))).toBe(
      409,
    );
    expect(
      await refusal(f.open(`/api/agent/sessions/${ulid()}/takeover/${f.requestId}/stream`)),
    ).toBe(404);
    expect(await refusal(f.open(`/api/agent/sessions/${f.id}/takeover/nope/stream`))).toBe(400);
    expect(await f.session.handback(f.requestId, undefined)).toBe(true);
    // dot has the computer again: nothing the stream could carry would be the user's.
    expect(await refusal(f.open())).toBe(409);
    expect(f.desktop).not.toHaveBeenCalled();
    expect(f.fake.calls).toEqual([]);
  });

  it("delivers typing, keys and clicks in the order they were made", async () => {
    const f = await setup(),
      ws = f.open();
    await opened(ws);
    const inputs: ManualStreamInput[] = [
      { kind: "click", at: { x: 400, y: 300 }, button: "left", count: 1 },
      ...typing("user@example.test"),
      { kind: "key", combo: ["tab"] },
      ...typing("pass word!"),
      { kind: "key", combo: ["enter"] },
    ];
    const done = acked(ws, inputs.length);
    send(ws, inputs);
    await done;
    expect(received(f.fake)).toEqual([
      { kind: "click", at: { x: 400, y: 300 }, button: "left", count: 1 },
      "user@example.test",
      { kind: "key", combo: ["tab"] },
      "pass word!",
      { kind: "key", combo: ["enter"] },
    ]);
    for (const call of f.fake.calls.filter((call) => call.path === "/type"))
      expect(call.body).toMatchObject({ masked: true });
    expect(f.session.manualControl).toBe("ready");
  });

  it("keeps what the user types out of the journal, the inbox and any log, and notes only that they typed", async () => {
    const f = await setup(),
      ws = f.open(),
      sentinel = "synthetic-password 中文🙂";
    const logged = [vi.spyOn(console, "log"), vi.spyOn(console, "error")];
    await opened(ws);
    const done = acked(ws, [...sentinel].length);
    send(ws, typing(sentinel));
    await done;
    expect(received(f.fake)).toEqual([sentinel]);
    expect(await f.session.handback(f.requestId, undefined)).toBe(true);
    const events = f.log.read(f.id);
    expect(JSON.stringify(events)).not.toContain("synthetic-password");
    expect(events.find((event) => event.type === "takeover.end")?.data).toEqual({
      requestId: f.requestId,
      by: "user",
      typed: true,
    });
    expect(f.session.inboxSequence).toBe(0);
    for (const spy of logged)
      expect(JSON.stringify(spy.mock.calls)).not.toContain("synthetic-password");
  });

  it("joins queued text and moves with no button down, but follows every move of a drag", async () => {
    const f = await setup(),
      acks: string[] = [];
    const stream = new ManualStream(f.session, f.requestId, f.desktop, {
      send: (data) => acks.push(data),
      close: () => {},
    });
    const at = (x: number) => ({ x, y: 10 });
    const inputs: ManualStreamInput[] = [
      ...typing("abc"),
      { kind: "move", at: at(1) },
      { kind: "move", at: at(2) },
      { kind: "move", at: at(3) },
      { kind: "down", at: at(3), button: "left" },
      { kind: "move", at: at(4) },
      { kind: "move", at: at(5) },
      { kind: "up", at: at(5), button: "left" },
      { kind: "up", at: at(5), button: "left" },
    ];
    for (const input of inputs) stream.push(input);
    await vi.waitFor(() => expect(acks.at(-1)).toBe(JSON.stringify({ done: inputs.length })));
    expect(f.fake.calls.filter((call) => call.path === "/type")).toHaveLength(1);
    expect(received(f.fake)).toEqual([
      "abc",
      { kind: "move", to: at(3) },
      { kind: "down", at: at(3), button: "left" },
      { kind: "move", to: at(4) },
      { kind: "move", to: at(5) },
      { kind: "up", at: at(5), button: "left" },
    ]);
    expect(f.session.manualControl).toBe("ready");
  });

  it("lets go of a held button before the hand-back gives dot the computer", async () => {
    const f = await setup(),
      ws = f.open();
    await opened(ws);
    const down = acked(ws, 1);
    send(ws, [{ kind: "down", at: { x: 50, y: 60 }, button: "left" }]);
    await down;
    expect(f.session.manualControl).toBe("busy");
    const end = closed(ws);
    expect(await f.session.handback(f.requestId, undefined)).toBe(true);
    expect(received(f.fake)).toEqual([
      { kind: "down", at: { x: 50, y: 60 }, button: "left" },
      "/release",
    ]);
    expect(f.fake.buttons.size).toBe(0);
    expect(await end).toBe(MANUAL_STREAM_CLOSE.changed);
  });

  it("holds the hand-back of control the user took until a held button is let go", async () => {
    const f = await setup({ user: true }),
      client = new DesktopdClient(
        { baseUrl: "http://owned-desktop.invalid", token: f.fake.token },
        f.fake.fetchImpl,
      ),
      letting = Promise.withResolvers<void>(),
      acks: string[] = [];
    const slow = vi.fn<ManualDesktopSource>(
      (): ManualDesktop => ({
        screen: { w: 2560, h: 1600 },
        client,
        prepare: async () => {},
        check: () => {},
        release: () => {},
        letGo: async () => {
          await letting.promise;
          await client.release();
        },
      }),
    );
    const stream = new ManualStream(f.session, f.requestId, slow, {
      send: (data) => acks.push(data),
      close: () => {},
    });
    stream.push({ kind: "down", at: { x: 50, y: 60 }, button: "left" });
    await vi.waitFor(() => expect(acks).toEqual([JSON.stringify({ done: 1 })]));
    let returned: boolean | undefined;
    const handing = f.session.handback(f.requestId, undefined).then((ok) => {
      returned = ok;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(returned).toBeUndefined();
    expect(f.session.controlHeld).toBe(true);
    expect(f.log.read(f.id).some((event) => event.type === "takeover.end")).toBe(false);
    letting.resolve();
    await handing;
    expect(returned).toBe(true);
    expect(received(f.fake)).toEqual([
      { kind: "down", at: { x: 50, y: 60 }, button: "left" },
      "/release",
    ]);
    expect(f.fake.buttons.size).toBe(0);
    expect(f.session.controlHeld).toBe(false);
  });

  it("keeps what the user typed out of dot's note when they took the computer themselves", async () => {
    const f = await setup({ user: true }),
      ws = f.open(),
      sentinel = "synthetic-password 中文🙂";
    await opened(ws);
    const done = acked(ws, [...sentinel].length);
    send(ws, typing(sentinel));
    await done;
    expect(await f.session.handback(f.requestId, undefined)).toBe(true);
    const inbox = await f.session.inbox(0, 0, undefined, f.session.beginBrain());
    expect(inbox.items.map((item) => item.kind)).toEqual(["steer"]);
    expect(JSON.stringify(inbox.items)).not.toContain("synthetic-password");
    const events = f.log.read(f.id);
    expect(JSON.stringify(events)).not.toContain("synthetic-password");
    expect(events.some((event) => event.type === "message.user")).toBe(false);
    expect(events.find((event) => event.type === "takeover.end")?.data).toEqual({
      requestId: f.requestId,
      by: "user",
      typed: true,
    });
  });

  it("lets go when the socket closes, and Stop cuts a held button too", async () => {
    const f = await setup(),
      ws = f.open();
    await opened(ws);
    const down = acked(ws, 1);
    send(ws, [{ kind: "down", at: { x: 5, y: 6 }, button: "right" }]);
    await down;
    ws.close();
    await vi.waitFor(() => expect(f.session.manualControl).toBe("ready"));
    expect(received(f.fake)).toEqual([
      { kind: "down", at: { x: 5, y: 6 }, button: "right" },
      "/release",
    ]);

    const again = f.open();
    await opened(again);
    const held = acked(again, 1);
    send(again, [{ kind: "down", at: { x: 7, y: 8 }, button: "left" }]);
    await held;
    const end = closed(again);
    f.session.stop();
    await f.session.toolsSettled();
    expect(received(f.fake).at(-1)).toBe("/release");
    expect(await end).toBe(MANUAL_STREAM_CLOSE.changed);
  });

  it("turns a press and release into one click on a screen that takes clicks only", async () => {
    const f = await setup({ clicksOnly: true }),
      ws = f.open();
    await opened(ws);
    const inputs: ManualStreamInput[] = [
      { kind: "move", at: { x: 1, y: 1 } },
      { kind: "down", at: { x: 30, y: 40 }, button: "left", mods: ["shift"] },
      { kind: "move", at: { x: 31, y: 41 } },
      { kind: "up", at: { x: 31, y: 41 }, button: "left" },
      { kind: "scroll", at: { x: 30, y: 40 }, dx: 0, dy: 2, mods: ["ctrl"] },
    ];
    const done = acked(ws, inputs.length);
    send(ws, inputs);
    await done;
    expect(received(f.fake)).toEqual([
      { kind: "click", at: { x: 30, y: 40 }, button: "left", count: 1, mods: ["shift"] },
      { kind: "scroll", at: { x: 30, y: 40 }, dx: 0, dy: 2 },
    ]);
    // A press the user holds for a moment still clicks once it is let go.
    const pressed = acked(ws, inputs.length + 1);
    send(ws, [{ kind: "down", at: { x: 9, y: 9 }, button: "right" }]);
    await pressed;
    const released = acked(ws, inputs.length + 2);
    send(ws, [{ kind: "up", at: { x: 9, y: 9 }, button: "right" }]);
    await released;
    expect(received(f.fake).at(-1)).toEqual({
      kind: "click",
      at: { x: 9, y: 9 },
      button: "right",
      count: 1,
    });
  });

  it("fences control until Stop when typing cannot be confirmed", async () => {
    const f = await setup(),
      ws = f.open();
    f.fake.script.type = () => ({
      progress: [],
      result: { done: true, count: 1, firstPressMono: 1, armedMono: 0, injector: "xtest" },
    });
    await opened(ws);
    const end = closed(ws);
    send(ws, [{ kind: "text", text: "partial 中文" }]);
    expect(await end).toBe(MANUAL_STREAM_CLOSE.uncertain);
    expect(f.session.manualControl).toBe("unconfirmed");
    expect(await f.session.handback(f.requestId, undefined)).toBe(false);
    expect(await refusal(f.open())).toBe(409);
    f.session.stop();
    await f.session.toolsSettled();
    // Some of it may have landed, so the takeover's end says the user typed.
    expect(f.log.read(f.id).find((event) => event.type === "takeover.end")?.data).toEqual({
      requestId: f.requestId,
      by: "stop",
      typed: true,
    });
  });

  it("settles a click the computer could not confirm, then takes input and hands back", async () => {
    const f = await setup({ confirms: true }),
      ws = f.open(),
      click = { kind: "click", at: { x: 40, y: 50 }, button: "left", count: 1 } as const;
    f.fake.script.input = () => ({ status: 504, body: "1 press(es) not seen" });
    await opened(ws);
    const end = closed(ws);
    send(ws, [click]);
    expect(await end).toBe(MANUAL_STREAM_CLOSE.uncertain);
    await vi.waitFor(() => expect(f.session.manualControl).toBe("ready"));
    expect(received(f.fake)).toEqual([click, "/release"]);
    f.fake.script.input = undefined;
    const again = f.open();
    await opened(again);
    const done = acked(again, 1);
    send(again, [{ kind: "key", combo: ["enter"] }]);
    await done;
    expect(await f.session.handback(f.requestId, undefined)).toBe(true);
  });

  it("lets input already on its way land when the page's socket drops just before hand-back", async () => {
    const f = await setup(),
      entered = Promise.withResolvers<AbortSignal | undefined>(),
      lands = Promise.withResolvers<void>();
    const slow = vi.fn<ManualDesktopSource>(
      (): ManualDesktop => ({
        screen: { w: 2560, h: 1600 },
        client: {
          input: async () => {
            throw new Error("unexpected input");
          },
          type: (request: { text: string }, _progress: unknown, signal?: AbortSignal) => {
            entered.resolve(signal);
            return new Promise((resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
              void lands.promise.then(() =>
                resolve({
                  done: true,
                  count: [...request.text].length,
                  firstPressMono: 1,
                  armedMono: 0,
                  injector: "xtest",
                }),
              );
            });
          },
        } as unknown as ManualDesktop["client"],
        prepare: async () => {},
        check: () => {},
        release: () => {},
        letGo: async () => {},
      }),
    );
    const stream = new ManualStream(f.session, f.requestId, slow, {
      send: () => {},
      close: () => {},
    });
    stream.push({ kind: "text", text: "424242" });
    const signal = await entered.promise;
    // The page lost its socket (hidden, or reconnecting), so its own drain cannot see this input.
    stream.end(1000, "closed");
    const back = f.session.handback(f.requestId, undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signal?.aborted).toBe(false);
    lands.resolve();
    expect(await back).toBe(true);
    expect(f.session.manualControl).toBeUndefined();
    expect(f.log.read(f.id).find((event) => event.type === "takeover.end")?.data).toEqual({
      requestId: f.requestId,
      by: "user",
      typed: true,
    });
  });

  it("closes as soon as hand-back or Stop ends the user's control, and nothing sent after it lands", async () => {
    for (const ending of ["handback", "stop"] as const) {
      const f = await setup(),
        closes: number[] = [];
      const stream = new ManualStream(f.session, f.requestId, f.desktop, {
        send: () => {},
        close: (code) => closes.push(code),
      });
      if (ending === "handback")
        expect(await f.session.handback(f.requestId, undefined)).toBe(true);
      else f.session.stop();
      // The page may not have heard yet: its socket closes without waiting for more input.
      await vi.waitFor(() => expect(closes).toEqual([MANUAL_STREAM_CLOSE.changed]));
      stream.push({ kind: "text", text: "late" });
      stream.push({ kind: "key", combo: ["enter"] });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(f.desktop).not.toHaveBeenCalled();
      expect(f.fake.calls).toEqual([]);
    }
  });

  it("hands back cleanly when it cuts short a pointer moving with nothing held", async () => {
    const f = await setup(),
      closes: number[] = [],
      started = Promise.withResolvers<void>();
    const hanging = vi.fn<ManualDesktopSource>(
      (): ManualDesktop => ({
        screen: { w: 2560, h: 1600 },
        client: {
          input: (_request: unknown, signal?: AbortSignal) => {
            started.resolve();
            return new Promise((_resolve, reject) =>
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
            );
          },
          type: async () => {
            throw new Error("unexpected typing");
          },
        } as unknown as ManualDesktop["client"],
        prepare: async () => {},
        check: () => {},
        release: () => {},
        letGo: async () => {},
      }),
    );
    const stream = new ManualStream(f.session, f.requestId, hanging, {
      send: () => {},
      close: (code) => closes.push(code),
    });
    stream.push({ kind: "move", at: { x: 10, y: 20 } });
    await started.promise;
    expect(await f.session.handback(f.requestId, undefined)).toBe(true);
    expect(closes).toEqual([MANUAL_STREAM_CLOSE.changed]);
    expect(f.session.manualControl).not.toBe("unconfirmed");
  });

  it("closes on anything but one input per message, before it reaches the computer", async () => {
    const f = await setup();
    for (const raw of [
      "not json",
      JSON.stringify({ kind: "text", text: "x", masked: false }),
      JSON.stringify({ kind: "key", combo: ["ctrl"], holdMs: 500 }),
      JSON.stringify([{ kind: "text", text: "x" }]),
    ]) {
      const ws = f.open();
      await opened(ws);
      const end = closed(ws);
      ws.send(raw);
      expect(await end).toBe(MANUAL_STREAM_CLOSE.invalid);
    }
    expect(f.fake.calls).toEqual([]);
    expect(f.session.manualControl).toBe("ready");
  });
});
