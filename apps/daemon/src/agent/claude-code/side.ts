import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { ModelOptions } from "@localdot/protocol";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ModelAnswerError } from "../safety/judge-model.ts";
import type { SideGo, SideModel } from "../side/agent.ts";
import { SIDE_TOOL_NAMES, type SideResult } from "../side/tools.ts";
import type { ClaudeCodeAnswerDeps } from "./answer.ts";
import { claudeCodeSideOptions } from "./options.ts";

export const SIDE_SERVER = "localdot-side";
const PREFIX = `mcp__${SIDE_SERVER}__`;
export const SIDE_TOOLS: readonly string[] = Object.freeze(
  SIDE_TOOL_NAMES.map((name) => `${PREFIX}${name}`),
);
export const onlySideTools: CanUseTool = async (name, input, { mcpServer }) =>
  SIDE_TOOLS.includes(name) && mcpServer?.source === "sdk" && mcpServer.name === SIDE_SERVER
    ? { behavior: "allow", updatedInput: input }
    : { behavior: "deny", message: "A side question can only read, with its own tools." };

const Assistant = z.looseObject({
  type: z.literal("assistant"),
  message: z.looseObject({
    id: z.string().optional(),
    content: z.array(z.looseObject({ type: z.string(), name: z.string().optional() })),
    usage: z
      .looseObject({
        input_tokens: z.number().int().nonnegative().nullish(),
        cache_read_input_tokens: z.number().int().nonnegative().nullish(),
        cache_creation_input_tokens: z.number().int().nonnegative().nullish(),
        output_tokens: z.number().int().nonnegative().nullish(),
      })
      .optional(),
  }),
});
const Result = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
});

function asCallResult(result: SideResult) {
  return {
    content: [
      { type: "text" as const, text: result.text },
      ...(result.images ?? []).map((image) => ({
        type: "image" as const,
        data: image.data,
        mimeType: image.mediaType,
      })),
    ],
    isError: !result.ok,
  };
}

// The side agent's tools, served inside the daemon, in a process of the question's own: the plan's
// model reads through these and nothing else, and the task's own Claude Code never hears of it.
function sideServer(go: SideGo) {
  const instance = new McpServer(
    { name: SIDE_SERVER, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  instance.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: go.tools.offered().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.schema as { type: "object" },
    })),
  }));
  instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    asCallResult(
      await go.tools.call(
        request.params.name,
        request.params.arguments ?? {},
        AbortSignal.any([go.signal, extra.signal]),
      ),
    ),
  );
  return { type: "sdk" as const, name: SIDE_SERVER, instance };
}

// A model on the user's Claude Code plan. A plan's limits are its own: when it refuses, the reason
// is the plan's, and the question goes to the next model.
export function claudeCodeSideModel(
  deps: ClaudeCodeAnswerDeps,
  quick: { model: string; options?: ModelOptions },
  role: SideModel["role"],
): SideModel {
  return {
    provider: "claude-code",
    model: quick.model,
    role,
    tools: true,
    images: true,
    plan: true,
    run: async (go) => {
      go.signal.throwIfAborted();
      const launch = await deps.launch();
      go.signal.throwIfAborted();
      const abort = new AbortController();
      const stop = () => abort.abort();
      go.signal.addEventListener("abort", stop, { once: true });
      const query = deps.query({
        prompt: go.prompt,
        options: claudeCodeSideOptions({
          launch,
          model: quick.model,
          modelOptions: quick.options,
          instructions: go.system,
          abort,
          spawn: deps.spawn,
          serverName: SIDE_SERVER,
          server: sideServer(go),
          canUseTool: onlySideTools,
          maxTurns: go.turns,
        }),
      });
      const counted = new Set<string>();
      try {
        for await (const message of query) {
          go.signal.throwIfAborted();
          const said = Assistant.safeParse(message).data?.message;
          if (said) {
            for (const block of said.content)
              if (block.type.endsWith("tool_use") && !SIDE_TOOLS.includes(block.name ?? ""))
                throw new ModelAnswerError(undefined, "Claude Code tried to use a tool of its own");
            const text = said.content
              .map((block) => (block.type === "text" ? String(block.text ?? "") : ""))
              .join("");
            go.note(text);
            if (said.usage && !(said.id && counted.has(said.id))) {
              if (said.id) counted.add(said.id);
              go.used({
                inputTokens:
                  (said.usage.input_tokens ?? 0) +
                  (said.usage.cache_read_input_tokens ?? 0) +
                  (said.usage.cache_creation_input_tokens ?? 0),
                outputTokens: said.usage.output_tokens ?? 0,
              });
            }
          }
          if (go.tools.finished) return;
          const ended = Result.safeParse(message).data;
          if (!ended) continue;
          if (ended.subtype === "error_max_turns") return;
          if (ended.subtype !== "success" || ended.is_error)
            throw new ModelAnswerError(
              undefined,
              ended.result?.trim() || "Claude Code couldn't answer",
            );
          return;
        }
      } finally {
        go.signal.removeEventListener("abort", stop);
        query.close();
        abort.abort();
      }
    },
  };
}
