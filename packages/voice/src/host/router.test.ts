import { describe, expect, it } from "vitest";
import type { TtsServerMessage } from "../wire.ts";
import {
  type Budget,
  ProviderError,
  type ProviderKind,
  providerOrder,
  type Sentence,
  type TtsOutput,
  type TtsProvider,
  TtsRouter,
} from "./router.ts";

type Behaviour = (sentence: Sentence, signal: AbortSignal) => Promise<void>;

class FakeProvider implements TtsProvider {
  readonly spoken: number[] = [];
  readonly kind: ProviderKind;
  readonly #behaviour: Behaviour;
  constructor(kind: ProviderKind, behaviour: Behaviour = async () => {}) {
    this.kind = kind;
    this.#behaviour = behaviour;
  }
  async speak(sentence: Sentence, signal: AbortSignal): Promise<void> {
    await this.#behaviour(sentence, signal);
    this.spoken.push(sentence.id);
  }
  close(): void {}
}

const fails =
  (code: "unavailable" | "synthesis_failed", audioSent = false) =>
  async () => {
    throw new ProviderError(code, "boom", audioSent);
  };

const collect = () => {
  const messages: TtsServerMessage[] = [];
  const out: TtsOutput = { frame: () => {}, message: (m) => messages.push(m) };
  return { messages, out };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const say = (id: number, text = "Hello there.") => ({
  type: "say" as const,
  id,
  text,
  lang: "en" as const,
});

describe("providerOrder", () => {
  it("puts the chosen voice first, then local, then the opted-in Azure fallback", () => {
    expect(providerOrder("local", "none")).toEqual(["local"]);
    expect(providerOrder("local", "azure")).toEqual(["local", "azure"]);
    expect(providerOrder("azure", "none")).toEqual(["azure", "local"]);
    expect(providerOrder("elevenlabs", "azure")).toEqual(["elevenlabs", "local", "azure"]);
    expect(providerOrder("off", "azure")).toEqual([]);
  });
});

describe("TtsRouter", () => {
  it("speaks with the local voice and says nothing else when it works", async () => {
    const { messages, out } = collect();
    const local = new FakeProvider("local");
    const router = new TtsRouter({ order: ["local"], providers: { local }, out });
    router.handle(say(1));
    router.handle(say(2));
    await settle();
    expect(local.spoken).toEqual([1, 2]);
    expect(messages).toEqual([]);
  });

  it("falls back to Azure when the local voice is down, with one notice", async () => {
    const { messages, out } = collect();
    const azure = new FakeProvider("azure");
    const router = new TtsRouter({
      order: ["local", "azure"],
      providers: { local: new FakeProvider("local", fails("unavailable")), azure },
      out,
    });
    router.handle(say(1));
    router.handle(say(2));
    await settle();
    expect(azure.spoken).toEqual([1, 2]);
    expect(messages).toEqual([
      { type: "notice", code: "cloud_fallback", message: expect.any(String) },
    ]);
  });

  it("returns to the local voice when a cloud voice fails or its budget is spent", async () => {
    const { messages, out } = collect();
    const local = new FakeProvider("local");
    let allowed = true;
    const budget: Budget = { allows: () => allowed, record: () => {} };
    const failing = new TtsRouter({
      order: ["elevenlabs", "local"],
      providers: { elevenlabs: new FakeProvider("elevenlabs", fails("synthesis_failed")), local },
      out,
      budget,
    });
    failing.handle(say(1));
    await settle();
    allowed = false;
    const spent = new TtsRouter({
      order: ["azure", "local"],
      providers: { azure: new FakeProvider("azure"), local },
      out,
      budget,
    });
    spent.handle(say(2));
    await settle();
    expect(local.spoken).toEqual([1, 2]);
    expect(messages.map((m) => (m.type === "notice" ? m.code : m.type))).toEqual([
      "cloud_failed",
      "budget_reached",
    ]);
  });

  it("records what a cloud voice spoke against its budget", async () => {
    const { out } = collect();
    const recorded: string[] = [];
    const budget: Budget = {
      allows: () => true,
      record: (kind, text) => recorded.push(`${kind}:${text}`),
    };
    const router = new TtsRouter({
      order: ["azure", "local"],
      providers: { azure: new FakeProvider("azure") },
      out,
      budget,
    });
    router.handle(say(1, "你好。"));
    await settle();
    expect(recorded).toEqual(["azure:你好。"]);
  });

  it("goes quiet with one notice and an error per sentence when no voice works", async () => {
    const { messages, out } = collect();
    const router = new TtsRouter({
      order: ["local"],
      providers: { local: new FakeProvider("local", fails("unavailable")) },
      out,
    });
    router.handle(say(1));
    router.handle(say(2));
    await settle();
    expect(messages).toEqual([
      { type: "notice", code: "voice_offline", message: expect.any(String) },
      { type: "error", id: 1, code: "unavailable", message: expect.any(String) },
      { type: "error", id: 2, code: "unavailable", message: expect.any(String) },
    ]);
  });

  it("tells the page again when the voice goes offline after it came back", async () => {
    const { messages, out } = collect();
    let up = false;
    const local = new FakeProvider("local", async () => {
      if (!up) throw new ProviderError("unavailable", "boom");
    });
    const router = new TtsRouter({ order: ["local"], providers: { local }, out });
    router.handle(say(1));
    await settle();
    up = true;
    router.handle(say(2));
    await settle();
    up = false;
    router.handle(say(3));
    await settle();
    expect(local.spoken).toEqual([2]);
    expect(messages).toEqual([
      { type: "notice", code: "voice_offline", message: expect.any(String) },
      { type: "error", id: 1, code: "unavailable", message: expect.any(String) },
      { type: "notice", code: "voice_offline", message: expect.any(String) },
      { type: "error", id: 3, code: "unavailable", message: expect.any(String) },
    ]);
  });

  it("does not switch voices mid-sentence once audio went out", async () => {
    const { messages, out } = collect();
    const azure = new FakeProvider("azure");
    const router = new TtsRouter({
      order: ["local", "azure"],
      providers: { local: new FakeProvider("local", fails("synthesis_failed", true)), azure },
      out,
    });
    router.handle(say(1));
    await settle();
    expect(azure.spoken).toEqual([]);
    expect(messages).toEqual([{ type: "error", id: 1, code: "synthesis_failed", message: "boom" }]);
  });

  it("cancels the sentence in progress and drops the queue", async () => {
    const { out } = collect();
    let aborted = false;
    const local = new FakeProvider(
      "local",
      (_s, signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          }),
        ),
    );
    const router = new TtsRouter({ order: ["local"], providers: { local }, out });
    router.handle(say(1));
    router.handle(say(2));
    router.handle({ type: "cancel" });
    await settle();
    expect(aborted).toBe(true);
    expect(local.spoken).toEqual([1]);
  });
});
