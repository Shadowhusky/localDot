import type { Lang } from "../lang.ts";
import type { NoticeCode, TtsClientMessage, TtsErrorCode, TtsServerMessage } from "../wire.ts";

export type ProviderKind = "local" | "azure" | "elevenlabs";
export type CloudKind = Exclude<ProviderKind, "local">;
export type OutputSetting = ProviderKind | "off";
export type FallbackSetting = "azure" | "none";

export interface Sentence {
  id: number;
  text: string;
  lang: Lang;
}

export interface TtsOutput {
  frame(bytes: Uint8Array): void;
  message(message: TtsServerMessage): void;
}

export interface TtsProvider {
  readonly kind: ProviderKind;
  // Resolves once the sentence's audio has all been sent; rejects with a ProviderError.
  speak(sentence: Sentence, signal: AbortSignal): Promise<void>;
  close(): void;
}

export class ProviderError extends Error {
  readonly code: TtsErrorCode;
  readonly audioSent: boolean;

  constructor(code: TtsErrorCode, message: string, audioSent = false) {
    super(message);
    this.code = code;
    this.audioSent = audioSent;
  }
}

export interface Budget {
  allows(kind: CloudKind, text: string): boolean;
  record(kind: CloudKind, text: string): void;
}

export const UNLIMITED: Budget = { allows: () => true, record: () => {} };

// The configured voice first, the local voice next, and Azure last when it is the opted-in fallback.
export function providerOrder(output: OutputSetting, fallback: FallbackSetting): ProviderKind[] {
  if (output === "off") return [];
  const order: ProviderKind[] = output === "local" ? ["local"] : [output, "local"];
  if (fallback === "azure" && !order.includes("azure")) order.push("azure");
  return order;
}

export interface RouterOptions {
  order: ProviderKind[];
  providers: Partial<Record<ProviderKind, TtsProvider>>;
  out: TtsOutput;
  budget?: Budget;
}

// One browser connection's sentences, spoken one after another by the first voice that works.
export class TtsRouter {
  readonly #options: RouterOptions;
  readonly #budget: Budget;
  readonly #noticed = new Set<NoticeCode>();
  #queue: Sentence[] = [];
  #abort: AbortController | null = null;
  #running = false;

  constructor(options: RouterOptions) {
    this.#options = options;
    this.#budget = options.budget ?? UNLIMITED;
  }

  handle(message: TtsClientMessage): void {
    if (message.type === "cancel") {
      this.#queue = [];
      this.#abort?.abort();
      return;
    }
    this.#queue.push({ id: message.id, text: message.text, lang: message.lang });
    if (!this.#running) void this.#drain();
  }

  close(): void {
    this.#queue = [];
    this.#abort?.abort();
    for (const provider of Object.values(this.#options.providers)) provider?.close();
  }

  async #drain(): Promise<void> {
    this.#running = true;
    for (let sentence = this.#queue.shift(); sentence; sentence = this.#queue.shift()) {
      this.#abort = new AbortController();
      await this.#speak(sentence, this.#abort.signal);
    }
    this.#abort = null;
    this.#running = false;
  }

  async #speak(sentence: Sentence, signal: AbortSignal): Promise<void> {
    const { order, providers, out } = this.#options;
    for (const [index, kind] of order.entries()) {
      const provider = providers[kind];
      if (!provider) continue;
      if (kind !== "local" && !this.#budget.allows(kind, sentence.text)) {
        this.#notice("budget_reached", `The ${kind} budget for this month is used up.`);
        continue;
      }
      try {
        await provider.speak(sentence, signal);
        // The page drops its offline note once the voice is back, so a later outage needs a new one.
        this.#noticed.delete("voice_offline");
        if (kind !== "local") this.#budget.record(kind, sentence.text);
        return;
      } catch (error) {
        if (signal.aborted) return;
        const failure =
          error instanceof ProviderError
            ? error
            : new ProviderError("synthesis_failed", String(error));
        if (failure.audioSent) {
          out.message({
            type: "error",
            id: sentence.id,
            code: failure.code,
            message: failure.message,
          });
          return;
        }
        const next = order.slice(index + 1).some((k) => providers[k]);
        if (kind !== "local")
          this.#notice("cloud_failed", `The ${kind} voice failed: ${failure.message}`);
        else if (next)
          this.#notice("cloud_fallback", "The local voice is unavailable; using the cloud voice.");
      }
    }
    if (order.length > 0) this.#notice("voice_offline", "Voice offline: replies stay as text.");
    out.message({
      type: "error",
      id: sentence.id,
      code: "unavailable",
      message: "no voice is available",
    });
  }

  #notice(code: NoticeCode, message: string): void {
    if (this.#noticed.has(code)) return;
    this.#noticed.add(code);
    this.#options.out.message({ type: "notice", code, message });
  }
}
