import { type GenerateOptions, type StreamChunk, ToolCallId } from "@deepseek-ai/dsh-llm";
import {
  type AssistantContent,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  streamText,
  tool,
} from "ai";

// Native DSH histories retain the exact AI SDK response for provider-specific
// reasoning signatures. Tool observations remain ordinary untrusted tool content.
export async function* harnessModel(
  options: GenerateOptions,
  model: LanguageModel,
  usage: (input: number, output: number) => void,
): AsyncIterable<StreamChunk> {
  const names = new Map<string, string>();
  const messages: ModelMessage[] = [];
  const instructions: string[] = options.system ? [options.system] : [];
  for (const message of options.messages) {
    for (const part of message.content)
      if (part.type === "tool-call") names.set(part.id, part.name);
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (message.role === "system") {
      if (text) instructions.push(text);
      continue;
    }
    if (message.role === "assistant") {
      const replay = message.source.replayState as
        | { response?: { kind?: string; messages?: ModelMessage[] } }
        | undefined;
      if (
        replay?.response?.kind === "localdot-ai-sdk-v1" &&
        Array.isArray(replay.response.messages)
      ) {
        messages.push(...replay.response.messages);
        continue;
      }
      messages.push({
        role: "assistant",
        content: message.content.flatMap<Exclude<AssistantContent, string>[number]>((part) => {
          if (part.type === "text") return [{ type: "text" as const, text: part.text }];
          if (part.type === "tool-call")
            return [
              {
                type: "tool-call" as const,
                toolCallId: String(part.id),
                toolName: part.name,
                input: JSON.parse(part.arguments),
              },
            ];
          return [];
        }),
      });
    } else if (message.role === "tool") {
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: String(message.toolCallId),
            toolName: names.get(message.toolCallId) ?? "unknown",
            output: { type: message.isError ? "error-text" : "text", value: text },
          },
        ],
      });
    } else if (text) messages.push({ role: "user", content: text });
  }
  const stream = streamText({
    model,
    messages,
    ...(instructions.length ? { system: instructions.join("\n\n") } : {}),
    tools: Object.fromEntries(
      (options.tools ?? []).map((schema) => [
        schema.name,
        tool({
          description: schema.description,
          inputSchema: jsonSchema(schema.parameters as never),
        }),
      ]),
    ),
    abortSignal: options.signal,
    maxRetries: 0,
    maxOutputTokens: options.maxTokens,
  });
  // Use the same streaming transport as the parent. Compatible Responses gateways
  // can support streaming requests while rejecting the non-streaming endpoint shape.
  const [text, toolCalls, response, totalUsage] = await Promise.all([
    stream.text,
    stream.toolCalls,
    stream.response,
    stream.totalUsage,
  ]);
  const result = { text, toolCalls, response };
  usage(totalUsage.inputTokens ?? 0, totalUsage.outputTokens ?? 0);
  let index = 0;
  if (result.text) {
    yield { type: "block-start", index, blockType: "text" };
    yield { type: "text-delta", index, text: result.text };
    yield { type: "block-end", index: index++, block: { type: "text", text: result.text } };
  }
  for (const call of result.toolCalls) {
    const id = ToolCallId(call.toolCallId),
      args = JSON.stringify(call.input);
    yield { type: "block-start", index, blockType: "tool-call" };
    yield { type: "tool-call-delta", index, id, name: call.toolName, argumentsDelta: args };
    yield {
      type: "block-end",
      index: index++,
      block: { type: "tool-call", id, name: call.toolName, arguments: args },
    };
  }
  yield {
    type: "finish",
    reason: { kind: result.toolCalls.length ? "tool-calls" : "stop" },
    replayState: {
      response: {
        kind: "localdot-ai-sdk-v1",
        // SDK objects contain optional undefined fields; native journals require
        // lossless JSON values. Normalize the wire representation without changing
        // any defined provider metadata or signed reasoning strings.
        messages: JSON.parse(
          JSON.stringify(
            result.response.messages.filter((message) => message.role === "assistant"),
          ),
        ),
      },
    },
  };
}
