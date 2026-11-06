import type { KeydRecord, ModelAdmissionWrite } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { KeyModels, listedModels } from "./key-models.ts";

const AT = "2026-11-01T00:00:00Z";
const SURROGATE = `ld_llm_${"a".repeat(22)}_${"b".repeat(6)}`;
const key: KeydRecord = {
  id: "cdx",
  kind: "llm",
  provider: "openai-compatible",
  baseURL: "https://relay.example/v1",
  createdAt: AT,
  updatedAt: AT,
};

function reader(answer: () => Promise<Response>) {
  const gate = { taskId: "", paused: true };
  const keyd = {
    openCell: vi.fn(async (req: { cellId: string; port: number; secrets: string[] }) => ({
      cellId: req.cellId,
      port: req.port,
      proxyToken: "t".repeat(43),
      surrogates: { cdx: SURROGATE },
    })),
    closeCell: vi.fn(async () => true),
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
    endTask: vi.fn(async () => {}),
  };
  const ports = { reserve: vi.fn(() => 4788), release: vi.fn() };
  const fetch = vi.fn(async (_url: string, _init: { headers: Record<string, string> }) => answer());
  return {
    models: new KeyModels({ keyd: keyd as never, ports, fetch: fetch as never }),
    keyd,
    ports,
    fetch,
  };
}

describe("a key's own list of models", () => {
  it("reads the list through a listener holding only that key, and closes it", async () => {
    const r = reader(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "gpt-6.1-terra" }, { id: "gpt-6.1-sol" }] })),
    );
    await expect(r.models.list(key, new AbortController().signal)).resolves.toEqual([
      { id: "gpt-6.1-sol" },
      { id: "gpt-6.1-terra" },
    ]);
    expect(r.keyd.openCell).toHaveBeenCalledWith(
      expect.objectContaining({ cellId: "key-models", secrets: ["cdx"] }),
    );
    const [url, init] = r.fetch.mock.calls[0] ?? [];
    expect(url).toBe("http://llm.ldot/cdx/models");
    expect(init?.headers.authorization).toBe(`Bearer ${SURROGATE}`);
    expect(r.keyd.endTask).toHaveBeenCalled();
    expect(r.ports.release).toHaveBeenCalledWith(4788);
  });

  it("says when the endpoint keeps no list", async () => {
    const r = reader(async () => new Response("nope", { status: 404 }));
    await expect(r.models.list(key, new AbortController().signal)).rejects.toThrow("answered 404");
    expect(r.keyd.closeCell).toHaveBeenCalledTimes(2);
  });

  it("reads each usual shape, leaving out what can't be a model ID", () => {
    expect(
      listedModels({ data: [{ id: "a", display_name: "A one" }, { id: "b c" }, "x"] }),
    ).toEqual([{ id: "a", name: "A one" }, { id: "x" }]);
    expect(listedModels({ models: [{ name: "models/gemini-3" }] })).toEqual([{ id: "gemini-3" }]);
    expect(listedModels("nothing")).toEqual([]);
  });
});
