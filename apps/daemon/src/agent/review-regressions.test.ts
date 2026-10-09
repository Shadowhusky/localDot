import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RememberInput, ulid } from "@localdot/protocol";
import { normalizeCatalog } from "@localdot/providers";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRole } from "./bindings.ts";
import { MemoryStore } from "./memory.ts";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function memoryFixture() {
  const home = mkdtempSync(join(tmpdir(), "localdot-task7-review-"));
  homes.push(home);
  return { home, memory: new MemoryStore(home) };
}
describe("review regression boundaries", () => {
  it("rejects a surrogate-half replacement without poisoning memory recovery", () => {
    const { home, memory } = memoryFixture();
    memory.apply(ulid(), "USER.md", "append", "- Emoji: 😀");
    const before = memory.read("USER.md");
    const oldHistory = readdirSync(join(home, "memory/.history"));
    const oldBytes = readFileSync(join(home, "memory/USER.md"));
    const input = RememberInput.parse({
      file: "USER.md",
      op: "replace",
      text: "X",
      old_text: "\ud83d",
    });
    expect(() => memory.apply(ulid(), "USER.md", input.op, input.text, input.old_text)).toThrow();
    expect(readdirSync(join(home, "memory/.history"))).toEqual(oldHistory);
    expect(readFileSync(join(home, "memory/USER.md"))).toEqual(oldBytes);
    expect.soft(readdirSync(join(home, "memory"))).not.toContain(".pending.json");
    expect.soft(() => memory.read("USER.md")).not.toThrow();
    expect.soft(() => new MemoryStore(home)).not.toThrow();
    if (!readdirSync(join(home, "memory")).includes(".pending.json"))
      expect(memory.read("USER.md")).toBe(before);
  });
  it("preserves valid supplementary characters in a complete replacement", () => {
    const { memory } = memoryFixture();
    memory.apply(ulid(), "USER.md", "append", "- Emoji: 😀");
    memory.apply(ulid(), "USER.md", "replace", "😎", "😀");
    expect(memory.read("USER.md")).toContain("😎");
  });
  it("requires a manual pair for Other even when the public catalog contains a generic compatible namespace", () => {
    const at = "2026-10-03T00:00:00Z";
    const catalog = normalizeCatalog(
      {
        "openai-compatible": {
          models: { custom: { id: "custom", tool_call: true, cost: { input: 1, output: 2 } } },
        },
      },
      at,
    );
    const key = {
      id: "custom-gateway",
      kind: "llm" as const,
      provider: "openai-compatible" as const,
      baseURL: "https://unrelated.example/v1",
      createdAt: at,
      updatedAt: at,
    };
    expect(() =>
      resolveRole(
        "main",
        { provider: "openai-compatible", model: "custom", key: key.id },
        catalog,
        [key],
      ),
    ).toThrow(/price/);
  });
  it("uses the manual Other price even when a generic compatible catalog namespace is priced", () => {
    const at = "2026-10-03T00:00:00Z";
    const catalog = normalizeCatalog(
      {
        "openai-compatible": {
          models: { custom: { id: "custom", tool_call: true, cost: { input: 1, output: 2 } } },
        },
      },
      at,
    );
    const key = {
      id: "custom-gateway",
      kind: "llm" as const,
      provider: "openai-compatible" as const,
      baseURL: "https://unrelated.example/v1",
      createdAt: at,
      updatedAt: at,
    };
    const price = { inputUSDPerMTok: 3, outputUSDPerMTok: 4 };
    expect(
      resolveRole(
        "main",
        { provider: "openai-compatible", model: "custom", key: key.id, price },
        catalog,
        [key],
      ).model,
    ).toMatchObject(price);
  });
});
