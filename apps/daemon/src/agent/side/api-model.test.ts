import type { KeydRecord } from "@localdot/protocol";
import { normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { describe, expect, it, vi } from "vitest";
import { resolveRole } from "../bindings.ts";
import type { SideGo } from "./agent.ts";
import { apiSideModel, type SideListener } from "./api-model.ts";

const AT = "2026-11-01T00:00:00Z";
const keys: KeydRecord[] = [
  { id: "anthropic", kind: "llm", provider: "anthropic", createdAt: AT, updatedAt: AT },
];
const catalog = normalizeCatalog(MODELS_DEV_FIXTURE, AT);
const role = resolveRole(
  "fast",
  { provider: "anthropic", model: "claude-haiku-4-5-20251001", key: "anthropic" },
  catalog,
  keys,
);
const SURROGATE = `ld_ant_${"a".repeat(22)}_${"b".repeat(6)}`;

function go(more: Partial<SideGo> = {}) {
  const used = vi.fn();
  const notes: string[] = [];
  let finished: unknown;
  const call = vi.fn(async (name: string, input: unknown) => {
    if (name === "finish") finished = input;
    return { ok: true, text: `result of ${name}` };
  });
  const value = {
    system: "S",
    prompt: "P",
    signal: new AbortController().signal,
    leftUSD: 0.2,
    turns: 10,
    used,
    note: (text: string) => notes.push(text),
    tools: {
      offered: () => [{ name: "finish", description: "d", schema: { type: "object" } }],
      call,
      get finished() {
        return finished as never;
      },
    },
    ...more,
  } as unknown as SideGo;
  return { go: value, used, notes, call };
}
function listener(close = vi.fn(async (): Promise<number | undefined> => undefined)) {
  return {
    close,
    open: vi.fn(
      async (): Promise<SideListener> => ({
        binding: {
          client: "anthropic",
          model: role.model.id,
          route: role.route,
          surrogate: SURROGATE,
          provider: "anthropic",
        } as SideListener["binding"],
        at: { port: 4788, token: "t" },
        close,
      }),
    ),
  };
}
const turn = (content: unknown[], input = 100, output = 10) =>
  Response.json({ content, usage: { input_tokens: input, output_tokens: output } });

describe("a model billed per token", () => {
  it("opens a listener with only what's left of the limit, and always closes it", async () => {
    const l = listener();
    const fetch = vi.fn(async () =>
      turn([{ type: "tool_use", id: "c", name: "finish", input: { status: "found" } }]),
    );
    const side = apiSideModel(role, "fast", l.open, fetch as never);
    const asked = go();
    await side.run(asked.go);
    expect(l.open).toHaveBeenCalledWith(role, 0.2, asked.go.signal);
    expect(l.close).toHaveBeenCalledOnce();
    const failing = apiSideModel(
      role,
      "fast",
      l.open,
      vi.fn(async () => {
        throw new Error("down");
      }) as never,
    );
    await expect(failing.run(go().go)).rejects.toThrow("down");
    expect(l.close).toHaveBeenCalledTimes(2);
  });

  it("says what it can do from the catalog", () => {
    const l = listener();
    expect(apiSideModel(role, "fast", l.open)).toMatchObject({
      provider: "anthropic",
      model: role.model.id,
      role: "fast",
      tools: role.model.toolCall,
      images: role.model.vision,
    });
  });

  it("reads until finish, counting each call's cost at the catalog's price", async () => {
    const l = listener();
    const replies = [
      turn([{ type: "tool_use", id: "a", name: "read_log", input: {} }]),
      turn([{ type: "tool_use", id: "b", name: "finish", input: { status: "found" } }]),
    ];
    const fetch = vi.fn(async () => replies.shift() as Response);
    const asked = go();
    await apiSideModel(role, "fast", l.open, fetch as never).run(asked.go);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(asked.call.mock.calls.map((c) => c[0])).toEqual(["read_log", "finish"]);
    const usd = (100 * role.model.inputUSDPerMTok + 10 * role.model.outputUSDPerMTok) / 1e6;
    expect(asked.used).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 10, usd });
    expect(asked.used).toHaveBeenCalledTimes(2);
  });

  it("asks once for a result when it only talks, then leaves its words as a note", async () => {
    const l = listener();
    const fetch = vi.fn(async () => turn([{ type: "text", text: "It paid, I think." }]));
    const asked = go();
    await apiSideModel(role, "fast", l.open, fetch as never).run(asked.go);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(asked.notes).toContain("It paid, I think.");
    expect(asked.call).not.toHaveBeenCalled();
    const [, init] = fetch.mock.calls[1] as unknown as [string, { body: string }];
    const second = JSON.parse(init.body);
    expect(second.messages.at(-1).content).toContain("call finish");
  });

  it("stops after its turns when a model never finishes", async () => {
    const l = listener();
    const fetch = vi.fn(async () =>
      turn([{ type: "tool_use", id: "a", name: "shell", input: { command: "ls" } }]),
    );
    const asked = go({ turns: 3 });
    await apiSideModel(role, "fast", l.open, fetch as never).run(asked.go);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(l.close).toHaveBeenCalledOnce();
  });

  it("counts what keyd says it spent when the reply gave no usage", async () => {
    const l = listener(vi.fn(async () => 0.2));
    const fetch = vi.fn(async () =>
      Response.json({
        content: [{ type: "tool_use", id: "c", name: "finish", input: { status: "found" } }],
      }),
    );
    const asked = go();
    await apiSideModel(role, "fast", l.open, fetch as never).run(asked.go);
    const usd = asked.used.mock.calls.reduce((sum, [usage]) => sum + (usage.usd ?? 0), 0);
    expect(usd).toBeCloseTo(0.2);
  });

  it("counts a call that was cut short, by what keyd says it spent", async () => {
    const l = listener(vi.fn(async () => 0.05));
    const fetch = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    const asked = go();
    await expect(
      apiSideModel(role, "fast", l.open, fetch as never).run(asked.go),
    ).rejects.toThrow();
    const usd = asked.used.mock.calls.reduce((sum, [usage]) => sum + (usage.usd ?? 0), 0);
    expect(usd).toBeCloseTo(0.05);
  });

  it("adds only what keyd counted beyond what the replies said", async () => {
    const l = listener(vi.fn(async () => 0.15));
    const fetch = vi.fn(async () =>
      turn([{ type: "tool_use", id: "c", name: "finish", input: { status: "found" } }], 0, 0),
    );
    const asked = go();
    const priced = {
      ...role,
      model: { ...role.model, inputUSDPerMTok: 1_000_000, outputUSDPerMTok: 0 },
    };
    fetch.mockImplementationOnce(async () =>
      Response.json({
        content: [{ type: "tool_use", id: "c", name: "finish", input: { status: "found" } }],
        usage: { input_tokens: 0.1, output_tokens: 0 },
      }),
    );
    await apiSideModel(priced, "fast", l.open, fetch as never).run(asked.go);
    const usd = asked.used.mock.calls.reduce((sum, [usage]) => sum + (usage.usd ?? 0), 0);
    expect(usd).toBeCloseTo(0.15);
  });

  it("never counts less than the replies said", async () => {
    const l = listener(vi.fn(async () => 0));
    const fetch = vi.fn(async () =>
      turn([{ type: "tool_use", id: "c", name: "finish", input: { status: "found" } }]),
    );
    const asked = go();
    await apiSideModel(role, "fast", l.open, fetch as never).run(asked.go);
    expect(asked.used).toHaveBeenCalledTimes(1);
  });

  it("gives a flat plan no money to count and no limit to keyd", async () => {
    const l = listener();
    const flat = { ...role, flat: true as const };
    const fetch = vi.fn(async () =>
      turn([{ type: "tool_use", id: "c", name: "finish", input: { status: "found" } }]),
    );
    const asked = go();
    await apiSideModel(flat, "fast", l.open, fetch as never).run(asked.go);
    expect(l.open).toHaveBeenCalledWith(flat, undefined, asked.go.signal);
    expect(asked.used).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 10, usd: 0 });
  });
});
