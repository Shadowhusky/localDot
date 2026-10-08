import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import sharp from "sharp";

type LanguageModelV4Prompt = Parameters<MockLanguageModelV4["doStream"]>[0]["prompt"];

export interface Frame {
  width: number;
  height: number;
  // RGBA, row-major.
  data: Uint8Array;
}

export interface ScreenWindow {
  cls: string;
  title: string;
  // Model pixels (1280x800).
  rect: { x: number; y: number; w: number; h: number };
}

export interface ToolOutcome {
  name: string;
  ok: boolean;
  text: string;
}

export interface OracleView {
  turn: number;
  frame: Frame | undefined;
  results: ToolOutcome[];
  windows: ScreenWindow[];
  // Inputs the simulated user completed after the product handed the screen over.
  handoffs: number;
}

export interface DesktopFacts {
  windows: ScreenWindow[];
  handoffs: number;
}

export type OracleCall = readonly [name: string, input: Record<string, unknown>];
export type Policy = (view: OracleView) => OracleCall[] | Promise<OracleCall[]>;

export function pixel(frame: Frame, x: number, y: number): [number, number, number] {
  const i = (Math.round(y) * frame.width + Math.round(x)) * 4;
  return [frame.data[i] ?? 0, frame.data[i + 1] ?? 0, frame.data[i + 2] ?? 0];
}

function fileBytes(part: { data: unknown }): Buffer | undefined {
  const data = part.data as { type?: string; data?: unknown };
  if (data?.type !== "data") return undefined;
  if (typeof data.data === "string") return Buffer.from(data.data, "base64");
  if (data.data instanceof Uint8Array) return Buffer.from(data.data);
  return undefined;
}

async function newestFrame(prompt: LanguageModelV4Prompt): Promise<Frame | undefined> {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i];
    if (message?.role !== "user") continue;
    for (let j = message.content.length - 1; j >= 0; j--) {
      const part = message.content[j];
      if (part?.type !== "file" || !String(part.mediaType).startsWith("image")) continue;
      const bytes = fileBytes(part);
      if (!bytes) continue;
      const { data, info } = await sharp(bytes)
        .resize(1280, 800, { fit: "fill" })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return { width: info.width, height: info.height, data };
    }
  }
  return undefined;
}

function lastResults(prompt: LanguageModelV4Prompt): ToolOutcome[] {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i];
    if (message?.role === "assistant") return [];
    if (message?.role !== "tool") continue;
    return message.content.flatMap((part) => {
      if (part.type !== "tool-result") return [];
      const output = part.output as { type: string; value: unknown };
      const text =
        typeof output.value === "string"
          ? output.value
          : Array.isArray(output.value)
            ? output.value
                .map((v: { type?: string; text?: string }) => (v.type === "text" ? v.text : ""))
                .join("\n")
            : "";
      return [{ name: part.toolName, ok: !output.type.startsWith("error"), text }];
    });
  }
  return [];
}

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 0, text: 0, reasoning: undefined },
};

// A model whose every turn is the policy's answer to what it was just shown: the newest
// screenshot, the previous turn's tool results and the desktop's window list at that frame.
export function oracleModel(policy: Policy, facts: () => DesktopFacts) {
  let turn = 0;
  const seen: OracleView[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const view: OracleView = {
        turn: turn++,
        frame: await newestFrame(options.prompt),
        results: lastResults(options.prompt),
        ...facts(),
      };
      seen.push({ ...view, frame: undefined });
      const calls = await policy(view);
      const chunks: Record<string, unknown>[] = calls.length
        ? [
            ...calls.map(([toolName, input], i) => ({
              type: "tool-call",
              toolCallId: `oracle-${view.turn}-${i}`,
              toolName,
              input: JSON.stringify(input),
            })),
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ]
        : [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "No further steps." },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ];
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
  });
  return { model, seen };
}
