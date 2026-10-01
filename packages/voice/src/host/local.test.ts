import { afterEach, describe, expect, it } from "vitest";
import { startFakeVoiced } from "./fake-voiced.ts";
import { LocalTts } from "./local.ts";

const TOKEN = "v".repeat(43);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function localWith(token: string) {
  const voiced = await startFakeVoiced(TOKEN);
  cleanups.push(voiced.close);
  const local = new LocalTts(async () => ({ host: voiced.host, token }), {
    frame: () => {},
    message: () => {},
  });
  cleanups.push(() => local.close());
  return { voiced, local };
}

const sentence = (id: number) => ({ id, text: "Hello there.", lang: "en" as const });

describe("LocalTts", () => {
  it("takes voiced refusing the handshake as the voice being unavailable", async () => {
    const { voiced, local } = await localWith("w".repeat(43));
    expect(await local.warm()).toBe(false);
    await expect(local.speak(sentence(1), new AbortController().signal)).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringMatching(/403/),
    });
    expect(voiced.received).toEqual([]);
  });

  it("sends nothing for a sentence cancelled while the first connection opens", async () => {
    const { voiced, local } = await localWith(TOKEN);
    const abort = new AbortController();
    const cancelled = local.speak(sentence(1), abort.signal);
    abort.abort();
    await cancelled;
    await local.speak(sentence(2), new AbortController().signal);
    expect(voiced.received).toEqual([{ type: "say", ...sentence(2) }]);
  });
});
