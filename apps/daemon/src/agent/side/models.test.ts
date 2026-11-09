import type { KeydRecord } from "@localdot/protocol";
import { normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { describe, expect, it, vi } from "vitest";
import { resolveRole } from "../bindings.ts";
import type { SideModel } from "./agent.ts";
import { sideModels } from "./models.ts";

const AT = "2026-11-01T00:00:00Z";
const catalog = normalizeCatalog(MODELS_DEV_FIXTURE, AT);
const keys: KeydRecord[] = [
  { id: "anthropic", kind: "llm", provider: "anthropic", createdAt: AT, updatedAt: AT },
];
const LOCAL = { provider: "lmstudio", model: "qwen/qwen3.8-27b" };
const CLOUD = { provider: "anthropic", model: "claude-haiku-4-5-20251001", key: "anthropic" };
const role = (as: "main" | "fast" | "local", choice: typeof CLOUD | typeof LOCAL) =>
  resolveRole(as, choice as never, catalog, keys);
const api = vi.fn(
  (r: { providerId: string; model: { id: string } }, side: SideModel["role"]): SideModel => ({
    provider: r.providerId,
    model: r.model.id,
    role: side,
    tools: true,
    images: false,
    run: async () => {},
  }),
);
const plan = vi.fn(
  (quick: { model: string }, side: SideModel["role"]): SideModel => ({
    provider: "claude-code",
    model: quick.model,
    role: side,
    tools: true,
    images: true,
    plan: true,
    run: async () => {},
  }),
);
const names = (models: SideModel[]) => models.map((m) => `${m.role}:${m.provider}`);

describe("who a side question may go to", () => {
  it("goes only to the models that run this task, never another one set up in Settings", () => {
    const local = sideModels({ kind: "api", roles: [role("main", LOCAL)] }, { api, plan });
    expect(names(local)).toEqual(["main:lmstudio"]);
  });

  it("keeps a task whose main model is local on local models, leaving out a cloud fast model", () => {
    const local = sideModels(
      { kind: "api", roles: [role("main", LOCAL), role("fast", CLOUD)] },
      { api, plan },
    );
    expect(names(local)).toEqual(["main:lmstudio"]);
  });

  it("goes from the fast model to the main one the user chose for this task", () => {
    const both = sideModels(
      {
        kind: "api",
        roles: [role("main", CLOUD), role("fast", { ...CLOUD, model: "claude-sonnet-5-5" })],
      },
      { api, plan },
    );
    expect(names(both)).toEqual(["fast:anthropic", "main:anthropic"]);
  });

  it("lets a task in the cloud use a local fast model", () => {
    const models = sideModels(
      { kind: "api", roles: [role("main", CLOUD), role("fast", LOCAL)] },
      { api, plan },
    );
    expect(names(models)).toEqual(["fast:lmstudio", "main:anthropic"]);
  });

  it("ends with the task's own local model, which takes nothing off this Mac", () => {
    const models = sideModels(
      { kind: "api", roles: [role("main", CLOUD), role("local", LOCAL)] },
      { api, plan },
    );
    expect(names(models)).toEqual(["main:anthropic", "other:lmstudio"]);
  });

  it("gives a ChatGPT task nobody: its one Codex process is the task's", () => {
    expect(sideModels({ kind: "chatgpt" }, { api, plan })).toEqual([]);
  });

  it("keeps a Claude Code task on its plan's own models", () => {
    const models = sideModels(
      {
        kind: "claude-code",
        fast: { model: "haiku" },
        quick: [{ model: "haiku" }, { model: "sonnet" }],
      },
      { api, plan },
    );
    expect(names(models)).toEqual(["fast:claude-code", "main:claude-code"]);
  });

  describe("a custom endpoint", () => {
    const CUSTOM = { provider: "openai-compatible", model: "llama.cpp-local", key: "box" };
    const custom = (as: "main" | "fast") =>
      ({ ...role(as, CLOUD), role: as, providerId: "openai-compatible", keyId: "box" }) as never;
    const run = (endpoint: string | undefined) =>
      names(
        sideModels(
          { kind: "api", roles: [custom("main"), role("fast", CLOUD)] },
          { api, plan, endpointOf: () => endpoint },
        ),
      );
    it.each([
      "http://127.0.0.1:8080/v1",
      "http://127.8.9.10/v1",
      "http://localhost:1235/v1",
      "http://llama.local/v1",
      "http://10.0.0.4/v1",
      "http://172.16.5.1/v1",
      "http://172.31.255.254/v1",
      "http://192.168.1.20/v1",
      "http://[::1]:8000/v1",
      "http://[fd12:3456::1]/v1",
      "http://[::ffff:127.0.0.1]/v1",
      "http://127.1:8080/v1",
      "http://2130706433/v1",
      "http://LOCALHOST./v1",
      "not an address",
    ])("on this Mac or its network keeps a cloud fast model out: %s", (endpoint) => {
      expect(run(endpoint)).toEqual(["main:openai-compatible"]);
    });
    it.each([
      "https://api.example.com/v1",
      "http://172.32.0.1/v1",
      "http://11.0.0.1/v1",
      "http://[2001:db8::1]/v1",
      "http://localhost.example.com/v1",
    ])("in the cloud is the cloud: %s", (endpoint) => {
      expect(run(endpoint)).toEqual(["fast:anthropic", "main:openai-compatible"]);
    });
    it("whose address can't be read counts as local for the main model", () => {
      expect(run(undefined)).toEqual(["main:openai-compatible"]);
    });
    it("as the fast model beside a local main counts as the cloud unless its address says not", () => {
      const roles = [role("main", LOCAL), custom("fast")];
      expect(
        names(sideModels({ kind: "api", roles }, { api, plan, endpointOf: () => undefined })),
      ).toEqual(["main:lmstudio"]);
      expect(
        names(
          sideModels(
            { kind: "api", roles },
            { api, plan, endpointOf: () => "http://192.168.1.20/v1" },
          ),
        ),
      ).toEqual(["fast:openai-compatible", "main:lmstudio"]);
    });
    void CUSTOM;
  });
});
