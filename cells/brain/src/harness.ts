import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LlmRuntime, {
  createUserMessage,
  type GenerateOptions,
  LlmAdapter,
  type StreamChunk,
  ToolCallId,
} from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SessionProjections from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import type { ToolResult } from "@localdot/protocol";

export interface HarnessStep {
  text: string;
  calls: { id: string; name: string; input: unknown }[];
}

export interface HarnessHost {
  sessionId: string;
  task: string;
  signal: AbortSignal;
  request(signal: AbortSignal): Promise<HarnessStep | undefined>;
  execute(id: string, signal: AbortSignal): Promise<{ result: ToolResult; conclude: boolean }>;
  stopping(signal: AbortSignal): Promise<boolean>;
}

/**
 * DSH owns step scheduling, serial tool dispatch, turn completion and cancellation.
 * localDot owns the durable, multimodal provider transcript and inbox. The adapter
 * deliberately uses that host context (including signed provider replay blocks),
 * not a second independently compacted copy of the conversation. DSH's session is
 * a process-local orchestration log, not the user's persisted conversation.
 *
 * Only core plugins are mounted: no stock shell, provider credentials, telemetry,
 * session uploader or filesystem persistence. Every action still crosses keyd /
 * the daemon's existing permission and computer ownership boundaries.
 */
export async function driveHarness(host: HarnessHost): Promise<void> {
  host.signal.throwIfAborted();
  const ctx = new Context();
  let failure: unknown;
  const fail = (error: unknown) => {
    failure ??= error;
  };
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjections);
    await ctx.plugin(SystemPrompt, { personaPrefix: "" });
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
    const registered = new Set<string>();
    const register = (name: string) => {
      if (registered.has(name)) return;
      ctx.tools.register({
        name,
        description: "localDot daemon tool; schema and policy are enforced by the host adapter.",
        // Native provider tools have provider-owned schemas. The host validates
        // their decoded call and the daemon validates again before any action.
        parameters: { type: "object", additionalProperties: true },
        output: {
          schema: { type: "object", additionalProperties: true },
          render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
        },
        async execute(_args, exec) {
          if (failure) throw failure;
          try {
            const { result, conclude } = await host.execute(exec.callId, exec.signal);
            if (conclude) exec.concludeTurn();
            // Frames stay in the host transcript. Do not retain a duplicate base64
            // screenshot for every step in the orchestration log.
            return {
              ok: result.ok,
              content: result.content.map((part) =>
                part.type === "image" ? { type: "text", text: `[frame ${part.frameId}]` } : part,
              ),
            };
          } catch (error) {
            // DSH normalizes tool exceptions. A failed durable write / transport
            // must nevertheless fail the host, never silently start another step.
            fail(error);
            throw error;
          }
        },
      });
      registered.add(name);
    };
    class HostAdapter extends LlmAdapter {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (failure) throw failure;
        const signal = AbortSignal.any([host.signal, options.signal ?? host.signal]);
        const step = await host.request(signal);
        signal.throwIfAborted();
        let index = 0;
        if (step?.text) {
          yield { type: "block-start", index, blockType: "text" };
          yield { type: "text-delta", index, text: step.text };
          yield { type: "block-end", index: index++, block: { type: "text", text: step.text } };
        }
        for (const call of step?.calls ?? []) {
          register(call.name);
          const id = ToolCallId(call.id);
          const args = JSON.stringify(
            call.input !== null && typeof call.input === "object" && !Array.isArray(call.input)
              ? call.input
              : {},
          );
          yield { type: "block-start", index, blockType: "tool-call" };
          yield { type: "tool-call-delta", index, id, name: call.name, argumentsDelta: args };
          yield {
            type: "block-end",
            index: index++,
            block: {
              type: "tool-call",
              id,
              name: call.name,
              arguments: args,
            },
          };
        }
        yield { type: "finish", reason: { kind: step?.calls.length ? "tool-calls" : "stop" } };
      }
    }
    ctx.llm.registerAdapter(["localdot"], new HostAdapter());
    const handle = await ctx.agents.create({
      sessionId: SessionId(host.sessionId),
      signal: host.signal,
      agentOptions: { provider: "localdot", model: "configured" },
      setup(scope) {
        scope.on("agent/error", ({ error }) => fail(error));
        scope.on("agent/turn-stopping", async ({ agent, signal }) => {
          if (failure || host.signal.aborted) return;
          if (await host.stopping(signal))
            agent.steer(
              createUserMessage({
                content: [{ type: "text", text: "Continue with the updated localDot context." }],
                source: { kind: "user" },
              }),
            );
        });
      },
    });
    const abort = () => handle.agent.cancel({ kind: "user" });
    host.signal.addEventListener("abort", abort, { once: true });
    try {
      host.signal.throwIfAborted();
      handle.agent.followup(
        createUserMessage({
          content: [{ type: "text", text: host.task }],
          source: { kind: "user" },
        }),
      );
      await handle.agent.whenIdle();
      host.signal.throwIfAborted();
      if (failure) throw failure;
    } finally {
      host.signal.removeEventListener("abort", abort);
      await handle.dispose();
    }
  } finally {
    await ctx.fiber.dispose();
  }
}
