import { normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { expect, it, vi } from "vitest";
import { ModelCatalog } from "./model-catalog.ts";

const surrogate = `ld_key_${"a".repeat(22)}_${"b".repeat(6)}`;
const support = { supported: true };
function fixture() {
  const keyd = {
    secrets: vi.fn(async () => [
      { id: "claude", kind: "llm", provider: "anthropic", createdAt: "2026-10-20" },
    ]),
    closeCell: vi.fn(async () => true),
    endTask: vi.fn(async () => {}),
    beginPricedTask: vi.fn(
      async (_cell: string, _task: string, _pricing: unknown, _budget: number) => {},
    ),
    modelAdmission: vi.fn(async () => ({
      taskId: keyd.beginPricedTask.mock.calls[0]?.[1],
      generationId: "a".repeat(32),
      epoch: 1,
      paused: true,
      active: 0,
      retired: false,
    })),
    setModelAdmission: vi.fn(
      async (_id: string, input: { taskId: string; generationId: string }) => ({
        ...input,
        epoch: 2,
        paused: false,
        active: 0,
        retired: false,
      }),
    ),
    openCell: vi.fn(async () => ({
      port: 4770,
      proxyToken: "t".repeat(43),
      surrogates: { claude: surrogate },
    })),
  };
  const ports = { reserve: vi.fn(() => 4770), release: vi.fn() };
  const fetch = vi.fn(async () =>
    Response.json({
      data: [
        {
          id: "claude-sonnet-5-5",
          capabilities: {
            effort: {
              supported: true,
              low: support,
              medium: support,
              high: support,
              max: support,
              xhigh: support,
            },
            thinking: {
              supported: true,
              types: { adaptive: support, enabled: { supported: false } },
            },
          },
        },
      ],
    }),
  );
  const service = new ModelCatalog({ keyd: keyd as never, ports, fetch: fetch as never });
  const catalog = normalizeCatalog(MODELS_DEV_FIXTURE, new Date().toISOString());
  return { keyd, ports, fetch, service, catalog };
}
it("checks model metadata only through a short-lived keyd listener and cleans it up", async () => {
  const f = fixture();
  const catalog = await f.service.enrich(f.catalog, undefined, new AbortController().signal);
  expect(f.fetch).toHaveBeenCalledWith(
    "http://llm.ldot/claude/models?limit=100",
    expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ "x-api-key": surrogate }),
      redirect: "error",
    }),
  );
  expect(catalog.providers.anthropic?.models["claude-sonnet-5-5"]?.controls?.efforts).toContain(
    "max",
  );
  expect(f.keyd.endTask).toHaveBeenCalledWith("model-catalog");
  expect(f.keyd.closeCell).toHaveBeenLastCalledWith("model-catalog");
  expect(f.ports.release).toHaveBeenCalledWith(4770);
  expect(JSON.stringify(catalog)).not.toContain(surrogate);
});
it("preserves verified controls during a provider outage and still releases resources", async () => {
  const f = fixture();
  const previous = await f.service.enrich(f.catalog, undefined, new AbortController().signal);
  f.fetch.mockRejectedValueOnce(new Error("offline"));
  const next = normalizeCatalog(MODELS_DEV_FIXTURE, new Date().toISOString());
  await f.service.enrich(next, previous, new AbortController().signal);
  expect(next.providers.anthropic?.models["claude-sonnet-5-5"]?.controls).toEqual(
    previous.providers.anthropic?.models["claude-sonnet-5-5"]?.controls,
  );
  expect(f.ports.release).toHaveBeenCalledTimes(2);
});
it("does not contact custom or unrelated keys and tolerates unavailable keyd", async () => {
  const f = fixture();
  f.keyd.secrets.mockRejectedValueOnce(new Error("offline"));
  await f.service.enrich(f.catalog, undefined, new AbortController().signal);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.ports.reserve).not.toHaveBeenCalled();
});

it("does not fetch when the metadata owner cannot be opened", async () => {
  const f = fixture();
  f.keyd.setModelAdmission.mockRejectedValueOnce(new Error("owner changed"));
  await f.service.enrich(f.catalog, undefined, new AbortController().signal);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.ports.release).toHaveBeenCalled();
  expect(f.keyd.beginPricedTask).toHaveBeenCalledWith(
    "model-catalog",
    expect.any(String),
    expect.objectContaining({ v: 1 }),
    0,
  );
});
