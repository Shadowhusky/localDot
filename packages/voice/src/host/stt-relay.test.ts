import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startFakeVoiced } from "./fake-voiced.ts";
import { attachVoiceGateway } from "./gateway.ts";
import { MAX_HELD_BYTES, relaySpeechInput } from "./stt-relay.ts";

const TOKEN = "v".repeat(43);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// voiced is found once the relay has taken `heldFirst` messages from the page.
async function gatewayTo(voicedHost: string | null, heldFirst = 0) {
  const server: Server = createServer();
  const detach = attachVoiceGateway(server, {
    authorize: () => true,
    tts: () => ({ handle: () => {}, close: () => {} }),
    stt: (browser) => {
      let arrived = 0;
      browser.on("message", () => arrived++);
      relaySpeechInput(browser, async () => {
        while (arrived < heldFirst) await new Promise((r) => setTimeout(r, 5));
        return voicedHost ? { host: voicedHost, token: TOKEN } : null;
      });
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
  const page = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/voice/stt`, [
    "localdot.v1",
  ]);
  const messages: Record<string, unknown>[] = [];
  const closed = new Promise<void>((resolve) => page.once("close", () => resolve()));
  page.on("message", (data) => messages.push(JSON.parse(data.toString())));
  cleanups.push(() => page.terminate());
  await new Promise((resolve) => page.once("open", resolve));
  return { page, messages, closed };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

describe("relaySpeechInput", () => {
  it("pipes control messages and audio to voiced, holding what arrives before it connects", async () => {
    const voiced = await startFakeVoiced(TOKEN);
    cleanups.push(voiced.close);
    const { page, messages } = await gatewayTo(voiced.host);
    page.send(JSON.stringify({ type: "listen", mode: "ptt" }));
    page.send(new Uint8Array(960));
    page.send(new Uint8Array(960));
    page.send(JSON.stringify({ type: "release" }));
    await until(() => messages.length === 2);
    expect(messages).toEqual([
      { type: "ready" },
      { type: "end", utterance: 1, text: "1920 bytes", lang: "en" },
    ]);
  });

  it("tells the page voice input is unavailable when voiced is not running, then closes", async () => {
    const { messages, closed } = await gatewayTo(null);
    await closed;
    expect(messages).toEqual([
      { type: "error", code: "unavailable", message: "voiced is not running" },
    ]);
  });

  it("drops only audio once its hold is full, never a control message", async () => {
    const voiced = await startFakeVoiced(TOKEN);
    cleanups.push(voiced.close);
    const { page, messages } = await gatewayTo(voiced.host, 4);
    page.send(JSON.stringify({ type: "listen", mode: "ptt" }));
    page.send(new Uint8Array(MAX_HELD_BYTES - 32));
    page.send(new Uint8Array(960));
    page.send(JSON.stringify({ type: "release" }));
    await until(() => messages.length === 2);
    expect(messages[1]).toEqual({
      type: "end",
      utterance: 1,
      text: `${MAX_HELD_BYTES - 32} bytes`,
      lang: "en",
    });
  });

  it("passes on voiced's own report when it gives up, adding nothing", async () => {
    const voiced = await startFakeVoiced(TOKEN, undefined, () => "fail");
    cleanups.push(voiced.close);
    const { page, messages, closed } = await gatewayTo(voiced.host);
    page.send(JSON.stringify({ type: "listen", mode: "handsfree" }));
    await closed;
    expect(messages).toEqual([
      { type: "error", code: "recognition_failed", message: "detector broke" },
    ]);
  });

  it("tells the page when voiced drops the connection, then closes", async () => {
    const voiced = await startFakeVoiced(TOKEN);
    const { page, messages, closed } = await gatewayTo(voiced.host);
    page.send(JSON.stringify({ type: "listen", mode: "handsfree" }));
    await until(() => messages.length === 1);
    await voiced.close();
    await closed;
    expect(messages).toEqual([
      { type: "ready" },
      { type: "error", code: "unavailable", message: "voiced closed the connection" },
    ]);
  });
});
