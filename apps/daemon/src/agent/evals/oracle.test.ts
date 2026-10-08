import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { oracleModel } from "./oracle.ts";

const facts = () => ({ windows: [], handoffs: 0 });

async function streamed(model: ReturnType<typeof oracleModel>["model"]) {
  const { stream } = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Go." }] }],
  } as never);
  const chunks: { type: string; toolName?: string; input?: string; delta?: string }[] = [];
  for await (const chunk of stream as AsyncIterable<(typeof chunks)[number]>) chunks.push(chunk);
  return chunks;
}

describe("oracleModel", () => {
  it("streams the policy's calls as tool calls", async () => {
    const { model, seen } = oracleModel(
      () => [
        ["computer", { action: "key", text: "ctrl+s" }],
        ["done", { summary: "Saved." }],
      ],
      facts,
    );
    const chunks = await streamed(model);
    expect(chunks.filter((c) => c.type === "tool-call")).toMatchObject([
      { toolName: "computer", input: JSON.stringify({ action: "key", text: "ctrl+s" }) },
      { toolName: "done", input: JSON.stringify({ summary: "Saved." }) },
    ]);
    expect(seen).toHaveLength(1);
  });

  it("says there is nothing more to do when the policy has no call", async () => {
    const { model } = oracleModel(() => [], facts);
    const chunks = await streamed(model);
    expect(chunks.filter((c) => c.type === "text-delta").map((c) => c.delta)).toEqual([
      "No further steps.",
    ]);
  });

  it("answers a summary request instead of throwing", async () => {
    const { model } = oracleModel(() => [["done", { summary: "x" }]], facts);
    const { text } = await generateText({ model, prompt: "Summarise the task so far." });
    expect(text).toBe("No further steps.");
  });
});
