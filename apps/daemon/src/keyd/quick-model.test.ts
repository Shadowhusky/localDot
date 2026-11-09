import type { KeydRecord, ModelAdmissionWrite } from "@localdot/protocol";
import { normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { describe, expect, it, vi } from "vitest";
import { pricingOf, resolveRole } from "../agent/bindings.ts";
import { QuickModel } from "./quick-model.ts";

const AT = "2026-10-30T00:00:00Z";
const SURROGATE = `ld_llm_${"a".repeat(22)}_${"b".repeat(6)}`;
const keys: KeydRecord[] = [
  { id: "openai", kind: "llm", provider: "openai", createdAt: AT, updatedAt: AT },
];
const role = resolveRole(
  "fast",
  { provider: "openai", model: "gpt-6-luna", key: "openai" },
  normalizeCatalog(MODELS_DEV_FIXTURE, AT),
  keys,
);

function quick(answer: () => Promise<Response>) {
  const calls: string[] = [];
  const gate = { taskId: "", paused: true };
  const keyd = {
    openCell: vi.fn(async (req: { cellId: string; port: number; secrets: string[] }) => {
      calls.push(`open ${req.cellId}`);
      return {
        cellId: req.cellId,
        port: req.port,
        proxyToken: "t".repeat(43),
        surrogates: { openai: SURROGATE },
      };
    }),
    closeCell: vi.fn(async (id: string) => {
      calls.push(`close ${id}`);
      return true;
    }),
    beginPricedTask: vi.fn(async (_cell: string, taskId: string) => {
      gate.taskId = taskId;
    }),
    modelAdmission: vi.fn(async () => ({
      taskId: gate.taskId,
      generationId: "g".repeat(32),
      epoch: 1,
      paused: gate.paused,
      active: 0,
      retired: false,
    })),
    setModelAdmission: vi.fn(async (_cell: string, write: ModelAdmissionWrite) => {
      gate.paused = write.state === "paused";
      return {
        taskId: gate.taskId,
        generationId: write.generationId,
        epoch: 2,
        paused: gate.paused,
        active: 0,
        retired: false,
      };
    }),
    endTask: vi.fn(async () => {
      calls.push("end");
    }),
    cell: vi.fn(async (id: string) => ({
      cellId: id,
      role: "brain",
      port: 4788,
      task: { id: gate.taskId, limitUSD: 0.2, spentUSD: 0.07 },
    })),
  };
  const ports = { reserve: vi.fn(() => 4788), release: vi.fn() };
  const fetch = vi.fn(
    async (_url: string, _init: { body: string; headers: Record<string, string> }) => {
      calls.push("ask");
      return answer();
    },
  );
  return {
    model: new QuickModel({ keyd: keyd as never, ports, fetch: fetch as never }),
    keyd,
    ports,
    fetch,
    calls,
  };
}

const said = (text: string) =>
  new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text }] }] }), {
    status: 200,
  });

describe("a quick question before the task's brain starts", () => {
  it("asks the task's own model through a priced listener that holds only its key, thinking least", async () => {
    const q = quick(async () => said('{"title":"Lisbon trip"}'));
    const answer = await q.model.ask(role, "sys", "prompt", new AbortController().signal);
    expect(answer).toBe('{"title":"Lisbon trip"}');
    expect(q.keyd.openCell).toHaveBeenCalledWith({
      cellId: "quick-model",
      role: "brain",
      port: 4788,
      secrets: ["openai"],
    });
    expect(q.keyd.beginPricedTask).toHaveBeenCalledWith(
      "quick-model",
      expect.any(String),
      pricingOf([role]),
    );
    const [url, init] = q.fetch.mock.calls[0] ?? [];
    expect(url).toBe(`http://llm.ldot/${role.route}/responses`);
    expect(init?.headers.authorization).toBe(`Bearer ${SURROGATE}`);
    expect(JSON.parse(init?.body ?? "{}")).toMatchObject({
      model: "gpt-6-luna",
      instructions: "sys",
      input: [{ role: "user", content: [{ type: "input_text", text: "prompt" }] }],
      stream: true,
      reasoning: { effort: "none" },
    });
    expect(q.calls).toEqual([
      "close quick-model",
      "open quick-model",
      "ask",
      "end",
      "close quick-model",
    ]);
    expect(q.ports.release).toHaveBeenCalledWith(4788);
  });

  it("closes its listener when the model fails, and takes one question at a time", async () => {
    let fail = true;
    const q = quick(async () => (fail ? new Response("busy", { status: 529 }) : said("ok")));
    const first = q.model.ask(role, "sys", "a", new AbortController().signal);
    const second = q.model.ask(role, "sys", "b", new AbortController().signal);
    await expect(first).rejects.toThrow("529");
    fail = false;
    await expect(second).resolves.toBe("ok");
    expect(q.calls).toEqual([
      "close quick-model",
      "open quick-model",
      "ask",
      "end",
      "close quick-model",
      "close quick-model",
      "open quick-model",
      "ask",
      "end",
      "close quick-model",
    ]);
    expect(q.ports.release).toHaveBeenCalledTimes(2);
  });
});

describe("a side question's own listener", () => {
  const signal = new AbortController().signal;
  it("holds its model's key with only what is left of the limit, apart from quick questions", async () => {
    const q = quick(async () => said("{}"));
    const listener = await q.model.sideListener(role, 0.2, signal);
    expect(q.keyd.openCell).toHaveBeenCalledWith({
      cellId: "side-model-0",
      role: "brain",
      port: 4788,
      secrets: ["openai"],
    });
    expect(q.keyd.beginPricedTask).toHaveBeenCalledWith(
      "side-model-0",
      expect.any(String),
      pricingOf([role]),
      0.2,
    );
    expect(listener.binding.surrogate).toBe(SURROGATE);
    expect(listener.at).toEqual({ port: 4788, token: "t".repeat(43) });
    // A quick question beside it doesn't wait for it.
    await expect(q.model.ask(role, "s", "p", signal)).resolves.toBe("{}");
    await listener.close();
    expect(q.keyd.endTask).toHaveBeenCalledWith("side-model-0");
    expect(q.keyd.closeCell).toHaveBeenLastCalledWith("side-model-0");
  });
  it("takes a listener each, gives it back, and refuses a fifth at once", async () => {
    const q = quick(async () => said("{}"));
    const held = [];
    for (let n = 0; n < 4; n++) held.push(await q.model.sideListener(role, 0.2, signal));
    await expect(q.model.sideListener(role, 0.2, signal)).rejects.toThrow("too many");
    await held[0]?.close();
    await expect(q.model.sideListener(role, 0.2, signal)).resolves.toBeDefined();
  });
  it("gives its port back when it can't open", async () => {
    const q = quick(async () => said("{}"));
    q.keyd.beginPricedTask.mockRejectedValueOnce(new Error("no"));
    await expect(q.model.sideListener(role, 0.2, signal)).rejects.toThrow("no");
    expect(q.ports.release).toHaveBeenCalledWith(4788);
    await expect(q.model.sideListener(role, 0.2, signal)).resolves.toBeDefined();
  });
  it("says what keyd counted its model spending when it closes", async () => {
    const q = quick(async () => said("{}"));
    const listener = await q.model.sideListener(role, 0.2, signal);
    await expect(listener.close()).resolves.toBeCloseTo(0.07);
    expect(q.keyd.cell).toHaveBeenCalledWith("side-model-0");
    // Read before the task ends, while keyd still holds it.
    expect(q.keyd.cell.mock.invocationCallOrder[0]).toBeLessThan(
      q.keyd.endTask.mock.invocationCallOrder.at(-1) ?? 0,
    );
  });
  it("doesn't take another task's spending for its own", async () => {
    const q = quick(async () => said("{}"));
    q.keyd.cell.mockResolvedValueOnce({
      cellId: "side-model-0",
      role: "brain",
      port: 4788,
      task: { id: "someone-else", limitUSD: 1, spentUSD: 0.9 },
    });
    const listener = await q.model.sideListener(role, 0.2, signal);
    await expect(listener.close()).resolves.toBeUndefined();
  });
});
