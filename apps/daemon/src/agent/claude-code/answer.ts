import type { Options, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { ModelOptions, PremiumSpeed } from "@localdot/protocol";
import { servedSpeed } from "@localdot/providers";
import { z } from "zod";
import { claudeCodeAnswerOptions } from "./options.ts";
import type { ClaudeCodeLaunch } from "./setup.ts";

export interface ClaudeCodeReply {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly speed?: PremiumSpeed;
}
export type ClaudeCodeAnswer = (
  system: string,
  prompt: string,
  signal: AbortSignal,
) => Promise<ClaudeCodeReply>;
export interface ClaudeCodeAnswerDeps {
  query(params: { prompt: string; options: Options }): AsyncIterable<unknown> & { close(): void };
  // The user's own signed-in Claude Code.
  launch(): Promise<ClaudeCodeLaunch>;
  spawn(options: SpawnOptions): SpawnedProcess;
}

const Init = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("init"),
  tools: z.array(z.string()),
});
const Assistant = z.looseObject({
  type: z.literal("assistant"),
  message: z.looseObject({ content: z.array(z.looseObject({ type: z.string() })) }),
});
const Result = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number().int().nonnegative().nullish(),
      cache_read_input_tokens: z.number().int().nonnegative().nullish(),
      cache_creation_input_tokens: z.number().int().nonnegative().nullish(),
      output_tokens: z.number().int().nonnegative().nullish(),
      speed: z.string().nullish(),
    })
    .optional(),
  fast_mode_state: z.string().optional(),
});

// A fast model on the user's Claude Code plan, asked one question at a time: a process of its own
// with no tools, MCP servers or saved session, which ends with its answer. The launch is read once
// per task; a sign-out since then fails the question, never reaches a tool.
export function claudeCodeAnswer(
  deps: ClaudeCodeAnswerDeps,
  fast: { model: string; options?: ModelOptions },
): ClaudeCodeAnswer {
  let launched: Promise<ClaudeCodeLaunch> | undefined;
  return async (system, prompt, signal) => {
    signal.throwIfAborted();
    launched ??= deps.launch().catch((error: unknown) => {
      launched = undefined;
      throw error;
    });
    const launch = await launched;
    signal.throwIfAborted();
    const abort = new AbortController();
    const stop = () => abort.abort();
    signal.addEventListener("abort", stop, { once: true });
    const query = deps.query({
      prompt,
      options: claudeCodeAnswerOptions({
        launch,
        model: fast.model,
        modelOptions: fast.options,
        instructions: system,
        abort,
        spawn: deps.spawn,
      }),
    });
    try {
      for await (const message of query) {
        signal.throwIfAborted();
        if (Init.safeParse(message).data?.tools.length)
          throw new Error("Claude Code offered tools to a question.");
        if (
          Assistant.safeParse(message).data?.message.content.some((block) =>
            block.type.endsWith("tool_use"),
          )
        )
          throw new Error("Claude Code tried to use a tool.");
        const result = Result.safeParse(message);
        if (!result.success) continue;
        const { subtype, is_error, result: text, usage, fast_mode_state } = result.data;
        if (subtype !== "success" || is_error || text === undefined)
          throw new Error("Claude Code couldn't answer.");
        const speed = servedSpeed(usage?.speed) ?? (fast_mode_state === "on" ? "fast" : undefined);
        return {
          text,
          inputTokens:
            (usage?.input_tokens ?? 0) +
            (usage?.cache_read_input_tokens ?? 0) +
            (usage?.cache_creation_input_tokens ?? 0),
          outputTokens: usage?.output_tokens ?? 0,
          ...(speed ? { speed } : {}),
        };
      }
      throw new Error("Claude Code ended without an answer.");
    } finally {
      signal.removeEventListener("abort", stop);
      query.close();
      abort.abort();
    }
  };
}
