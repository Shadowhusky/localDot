import type { IncomingMessage } from "node:http";
import { qualityMessage } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { FULL_QUALITY, probeViewer, StreamTuning, sharedQuality } from "./stream-tuning.ts";

const AUTH = `Basic ${Buffer.from("localdot:streamtoken").toString("base64")}`;
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

const until = async (what: string, check: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

// Selkies' socket as the tuner meets it: records each connection's URL and messages, and can send
// one binary frame or drop every socket.
async function fakeSelkies() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const sockets: { url: string; auth: string | undefined; got: string[]; ws: WebSocket }[] = [];
  wss.on("connection", (ws, req: IncomingMessage) => {
    const entry = { url: req.url ?? "", auth: req.headers.authorization, got: [] as string[], ws };
    sockets.push(entry);
    ws.on("message", (data) => entry.got.push(String(data)));
  });
  stops.push(() => {
    for (const { ws } of sockets) ws.terminate();
    wss.close();
  });
  const { port } = wss.address() as { port: number };
  return {
    sockets,
    endpoint: { baseUrl: `http://127.0.0.1:${port}`, authorization: AUTH },
    got: () => sockets.flatMap((s) => s.got),
  };
}

function tuning(opts: ConstructorParameters<typeof StreamTuning>[0] = {}) {
  const applied: { framerate: number; crf: number }[] = [];
  const tuner = new StreamTuning({
    applyGapMs: 0,
    joinGapMs: 0,
    retryMs: { min: 20, max: 40 },
    onApply: (_id, quality) => applied.push(quality),
    ...opts,
  });
  stops.push(() => tuner.close());
  return { tuner, applied };
}

describe("sharedQuality", () => {
  it("runs at the most constrained visible viewer's wish", () => {
    expect(
      sharedQuality([
        { paused: false, report: { visible: true, framerate: 30, crf: 28 } },
        { paused: false, report: { visible: true, framerate: 45, crf: 34 } },
      ]),
    ).toEqual({ framerate: 30, crf: 34 });
  });

  it("asks nothing of a hidden page, a paused client or one that never said", () => {
    expect(
      sharedQuality([
        { paused: false, report: { visible: false } },
        { paused: true, report: { visible: true, framerate: 12, crf: 37 } },
        { paused: false },
      ]),
    ).toEqual(FULL_QUALITY);
  });
});

describe("StreamTuning", () => {
  it("opens no socket while every viewer takes full quality", async () => {
    const selkies = await fakeSelkies();
    const { tuner } = tuning();
    const viewer = tuner.join("cell", () => selkies.endpoint);
    expect(viewer.consume(qualityMessage({ visible: true, ...FULL_QUALITY }))).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(selkies.sockets).toHaveLength(0);
  });

  it("claims the display as Selkies' controller and sets frame rate and CRF with its live verbs", async () => {
    const selkies = await fakeSelkies();
    const { tuner, applied } = tuning();
    const phone = tuner.join("cell", () => selkies.endpoint);
    phone.consume(qualityMessage({ visible: true, framerate: 30, crf: 25 }));
    await until("the first settings", () => selkies.got().length >= 2);
    const [socket] = selkies.sockets;
    expect(socket?.url).toBe("/api/websockets");
    expect(socket?.auth).toBe(AUTH);
    expect(selkies.got()).toEqual([
      `SETTINGS,${JSON.stringify({ displayId: "primary", use_paint_over_quality: true })}`,
      "_arg_fps,30",
      "_crf,25",
    ]);
    phone.consume(qualityMessage({ visible: true, framerate: 30, crf: 31 }));
    await until("the CRF", () => selkies.got().length === 4);
    expect(selkies.got().at(-1)).toBe("_crf,31");
    expect(applied).toEqual([
      { framerate: 30, crf: 25 },
      { framerate: 30, crf: 31 },
    ]);
  });

  it("follows the most constrained visible viewer and goes back to full quality when it leaves or hides", async () => {
    const selkies = await fakeSelkies();
    const { tuner, applied } = tuning();
    const desktop = tuner.join("cell", () => selkies.endpoint);
    const phone = tuner.join("cell", () => selkies.endpoint);
    desktop.consume(qualityMessage({ visible: true, ...FULL_QUALITY }));
    phone.consume(qualityMessage({ visible: true, framerate: 30, crf: 28 }));
    await until("the phone's wish", () => applied.length === 1);
    expect(applied.at(-1)).toEqual({ framerate: 30, crf: 28 });
    phone.consume(qualityMessage({ visible: false }));
    await until("full quality", () => applied.length === 2);
    expect(applied.at(-1)).toEqual(FULL_QUALITY);
    phone.consume(qualityMessage({ visible: true, framerate: 24, crf: 31 }));
    await until("the phone again", () => applied.length === 3);
    expect(phone.consume("STOP_VIDEO")).toBe(false);
    await until("full quality while its video is paused", () => applied.length === 4);
    phone.consume("START_VIDEO");
    await until("the phone resumed", () => applied.length === 5);
    phone.leave();
    await until("full quality after it left", () => applied.length === 6);
    expect(applied.at(-1)).toEqual(FULL_QUALITY);
    expect(selkies.sockets).toHaveLength(1);
  });

  it("connects no sooner after a viewer than Selkies takes another connection from the daemon", async () => {
    const selkies = await fakeSelkies();
    const { tuner } = tuning({ joinGapMs: 150 });
    const joined = Date.now();
    tuner
      .join("cell", () => selkies.endpoint)
      .consume(qualityMessage({ visible: true, framerate: 30, crf: 25 }));
    await until("the tuner", () => selkies.sockets.length === 1);
    expect(Date.now() - joined).toBeGreaterThanOrEqual(140);
  });

  it("waits again for each viewer that connects before it does, and before each retry", async () => {
    const selkies = await fakeSelkies();
    const { tuner } = tuning({ joinGapMs: 150 });
    tuner
      .join("cell", () => selkies.endpoint)
      .consume(qualityMessage({ visible: true, framerate: 30, crf: 25 }));
    await new Promise((r) => setTimeout(r, 100));
    tuner.join("cell", () => selkies.endpoint);
    const joined = Date.now();
    await until("the tuner", () => selkies.sockets.length === 1);
    expect(Date.now() - joined).toBeGreaterThanOrEqual(140);
    await until("its settings", () => selkies.got().length === 3);
    selkies.sockets[0]?.ws.terminate();
    tuner.upgrading("cell");
    const upgrading = Date.now();
    await until("a second tuner", () => selkies.sockets.length === 2);
    expect(Date.now() - upgrading).toBeGreaterThanOrEqual(140);
  });

  it("spaces its changes however often the viewers change their minds", async () => {
    const selkies = await fakeSelkies();
    const { tuner, applied } = tuning({ applyGapMs: 150 });
    const viewer = tuner.join("cell", () => selkies.endpoint);
    viewer.consume(qualityMessage({ visible: true, framerate: 45, crf: 25 }));
    await until("the first change", () => applied.length === 1);
    const first = Date.now();
    viewer.consume(qualityMessage({ visible: true, framerate: 30, crf: 25 }));
    viewer.consume(qualityMessage({ visible: true, framerate: 24, crf: 28 }));
    await until("the second change", () => applied.length === 2);
    expect(Date.now() - first).toBeGreaterThanOrEqual(140);
    expect(applied.at(-1)).toEqual({ framerate: 24, crf: 28 });
  });

  it("passes on what is not a quality report and keeps a malformed one from the computer", async () => {
    const { tuner } = tuning();
    const viewer = tuner.join("cell", () => undefined);
    expect(viewer.consume("REQUEST_KEYFRAME")).toBe(false);
    expect(viewer.consume("_ld_q,{not json")).toBe(true);
    expect(viewer.consume('_ld_q,{"visible":true,"framerate":500,"crf":25}')).toBe(true);
  });

  it("pauses its own feed on an image that starts it with video on", async () => {
    const selkies = await fakeSelkies();
    const { tuner } = tuning();
    tuner
      .join("cell", () => selkies.endpoint)
      .consume(qualityMessage({ visible: true, framerate: 30, crf: 25 }));
    await until("the tuner", () => selkies.sockets.length === 1);
    selkies.sockets[0]?.ws.send(Buffer.from([4, 1, 0, 0]));
    selkies.sockets[0]?.ws.send(Buffer.from([4, 0, 0, 1]));
    await until("STOP_VIDEO", () => selkies.got().includes("STOP_VIDEO"));
    await new Promise((r) => setTimeout(r, 30));
    expect(selkies.got().filter((m) => m === "STOP_VIDEO")).toHaveLength(1);
  });

  it("reconnects a dropped socket and sets the wish again, since Selkies kept the old values", async () => {
    const selkies = await fakeSelkies();
    const { tuner } = tuning();
    tuner
      .join("cell", () => selkies.endpoint)
      .consume(qualityMessage({ visible: true, framerate: 30, crf: 28 }));
    await until("the tuner", () => selkies.got().length === 3);
    selkies.sockets[0]?.ws.terminate();
    await until("a second tuner", () => (selkies.sockets[1]?.got.length ?? 0) === 3);
    expect(selkies.sockets[1]?.got.slice(1)).toEqual(["_arg_fps,30", "_crf,28"]);
  });

  it("closes the socket of a computer that left ready", async () => {
    const selkies = await fakeSelkies();
    const { tuner } = tuning();
    tuner
      .join("cell", () => selkies.endpoint)
      .consume(qualityMessage({ visible: true, framerate: 30, crf: 28 }));
    await until("the tuner", () => selkies.got().length === 3);
    let closed = false;
    selkies.sockets[0]?.ws.once("close", () => {
      closed = true;
    });
    tuner.drop("cell");
    await until("the close", () => closed);
    await new Promise((r) => setTimeout(r, 80));
    expect(selkies.sockets).toHaveLength(1);
  });
});

describe("probeViewer", () => {
  it("tells the client its stream's round trip, and how long a ping has gone unanswered", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((r) => wss.once("listening", r));
    const { port } = wss.address() as { port: number };
    const accepted = new Promise<WebSocket>((r) => wss.once("connection", r));
    const viewer = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong: false });
    let answering = true;
    viewer.on("ping", (data) => {
      if (answering) viewer.pong(data);
    });
    const trips: number[] = [];
    viewer.on("message", (data) => {
      const message = JSON.parse(String(data));
      expect(message).toMatchObject({ type: "stream_stats", displayId: "primary" });
      trips.push(message.stats.rtt_ms);
    });
    const relay = await accepted;
    const stop = probeViewer(relay, 20);
    stops.push(() => {
      stop();
      viewer.terminate();
      wss.close();
    });
    await until("a round trip", () => trips.length >= 3);
    expect(trips.every((ms) => ms >= 0 && ms < 100)).toBe(true);
    answering = false;
    await until("a growing wait", () => (trips.at(-1) ?? 0) >= 300);
  });
});
