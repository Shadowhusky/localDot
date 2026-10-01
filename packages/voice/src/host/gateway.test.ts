import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { decodeAudioFrame } from "../wire.ts";
import { startFakeVoiced } from "./fake-voiced.ts";
import { attachVoiceGateway, isLocalPage, parseTtsClientMessage } from "./gateway.ts";
import { LocalTts } from "./local.ts";
import { TtsRouter } from "./router.ts";

const TOKEN = "v".repeat(43);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function gatewayTo(voicedHost: string | null) {
  const server: Server = createServer();
  const detach = attachVoiceGateway(server, {
    authorize: (request) => request.headers.origin === "http://127.0.0.1:4753",
    tts: (out) => {
      const local = new LocalTts(
        async () => (voicedHost ? { host: voicedHost, token: TOKEN } : null),
        out,
      );
      return new TtsRouter({ order: ["local"], providers: { local }, out });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        detach();
        server.close(() => resolve());
      }),
  );
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function browser(url: string, origin = "http://127.0.0.1:4753") {
  const socket = new WebSocket(`${url}/voice/tts`, ["localdot.v1"], { origin });
  const frames: { id: number; seq: number; pcm: number[] }[] = [];
  const messages: Record<string, unknown>[] = [];
  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      const frame = decodeAudioFrame(new Uint8Array(data as Buffer));
      if (frame) frames.push({ id: frame.id, seq: frame.seq, pcm: [...frame.pcm] });
    } else messages.push(JSON.parse(data.toString()));
  });
  cleanups.push(() => socket.terminate());
  return {
    socket,
    frames,
    messages,
    opened: new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    }),
  };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

describe("voice gateway", () => {
  it("relays a sentence to voiced and its audio, end and track back to the page", async () => {
    const voiced = await startFakeVoiced(TOKEN);
    cleanups.push(voiced.close);
    const page = browser(await gatewayTo(voiced.host));
    await page.opened;
    page.socket.send(JSON.stringify({ type: "say", id: 7, text: "Hello there.", lang: "en" }));
    await until(() => page.messages.some((m) => m.type === "track"));
    expect(page.frames).toEqual([
      { id: 7, seq: 0, pcm: [1, 2, 3] },
      { id: 7, seq: 1, pcm: [4, 5] },
    ]);
    expect(page.messages).toEqual([
      { type: "ready", voice: "stock" },
      { type: "end", id: 7, samples: 5 },
      { type: "track", id: 7, lang: "en", visemes: [{ t: 0, shape: "A" }] },
    ]);
    expect(voiced.received).toEqual([{ type: "say", id: 7, text: "Hello there.", lang: "en" }]);
  });

  it("refuses a page from another origin", async () => {
    const page = browser(await gatewayTo(null), "http://evil.example");
    await expect(page.opened).rejects.toThrow(/403/);
  });

  it("tells the page the voice is offline when voiced is not running", async () => {
    const page = browser(await gatewayTo(null));
    await page.opened;
    page.socket.send(JSON.stringify({ type: "say", id: 1, text: "Anyone?", lang: "en" }));
    await until(() => page.messages.length === 2);
    expect(page.messages.map((m) => `${m.type}:${m.code}`)).toEqual([
      "notice:voice_offline",
      "error:unavailable",
    ]);
  });

  it("passes a refusal from voiced on as voice offline, and recovers when voiced speaks again", async () => {
    let mode: "unavailable" | "speak" = "unavailable";
    const voiced = await startFakeVoiced(TOKEN, () => mode);
    cleanups.push(voiced.close);
    const page = browser(await gatewayTo(voiced.host));
    await page.opened;
    page.socket.send(JSON.stringify({ type: "say", id: 1, text: "First.", lang: "en" }));
    await until(() => page.messages.some((m) => m.type === "error"));
    expect(page.messages.map((m) => m.type)).toEqual(["ready", "notice", "error"]);
    mode = "speak";
    page.socket.send(JSON.stringify({ type: "say", id: 2, text: "Second.", lang: "en" }));
    await until(() => page.messages.some((m) => m.type === "end"));
    expect(page.frames.map((f) => f.id)).toEqual([2, 2]);
  });

  it("treats voiced dropping the connection as voice offline, then reconnects for the next sentence", async () => {
    let mode: "hang-up" | "speak" = "hang-up";
    const voiced = await startFakeVoiced(TOKEN, () => mode);
    cleanups.push(voiced.close);
    const page = browser(await gatewayTo(voiced.host));
    await page.opened;
    page.socket.send(JSON.stringify({ type: "say", id: 1, text: "First.", lang: "en" }));
    await until(() => page.messages.some((m) => m.type === "error"));
    mode = "speak";
    page.socket.send(JSON.stringify({ type: "say", id: 2, text: "Second.", lang: "en" }));
    await until(() => page.messages.some((m) => m.type === "end"));
    expect(page.messages.filter((m) => m.type === "notice").map((m) => m.code)).toEqual([
      "voice_offline",
    ]);
    expect(page.frames.map((f) => f.id)).toEqual([2, 2]);
  });

  it("forwards a cancel to voiced while a sentence is still being spoken", async () => {
    const voiced = await startFakeVoiced(TOKEN, () => "stall");
    cleanups.push(voiced.close);
    const page = browser(await gatewayTo(voiced.host));
    await page.opened;
    page.socket.send(JSON.stringify({ type: "say", id: 1, text: "Long story.", lang: "en" }));
    await until(() => page.frames.length === 1);
    page.socket.send(JSON.stringify({ type: "cancel" }));
    await until(() => voiced.received.length === 2);
    expect(voiced.received).toEqual([
      { type: "say", id: 1, text: "Long story.", lang: "en" },
      { type: "cancel" },
    ]);
  });
});

describe("parseTtsClientMessage", () => {
  it("accepts a well-formed say or cancel and nothing else", () => {
    expect(parseTtsClientMessage('{"type":"say","id":3,"text":"Hi.","lang":"ja"}')).toEqual({
      type: "say",
      id: 3,
      text: "Hi.",
      lang: "ja",
    });
    expect(parseTtsClientMessage('{"type":"cancel"}')).toEqual({ type: "cancel" });
    for (const bad of [
      '{"type":"say","id":-1,"text":"Hi.","lang":"en"}',
      '{"type":"say","id":1,"text":"  ","lang":"en"}',
      `{"type":"say","id":1,"text":"${"a".repeat(401)}","lang":"en"}`,
      '{"type":"say","id":1,"text":"Hi.","lang":"fr"}',
      "nope",
      "[]",
    ]) {
      expect(parseTtsClientMessage(bad)).toBeNull();
    }
  });
});

describe("isLocalPage", () => {
  it("accepts only the dev page's own host and origin", () => {
    const req = (host: string, origin?: string) => ({ headers: { host, origin } }) as never;
    expect(isLocalPage(req("127.0.0.1:4753", "http://127.0.0.1:4753"), 4753)).toBe(true);
    expect(isLocalPage(req("localhost:4753", "http://localhost:4753"), 4753)).toBe(true);
    expect(isLocalPage(req("127.0.0.1:4753"), 4753)).toBe(false);
    expect(isLocalPage(req("evil.example:4753", "http://127.0.0.1:4753"), 4753)).toBe(false);
    expect(isLocalPage(req("127.0.0.1:4753", "http://evil.example"), 4753)).toBe(false);
  });
});
