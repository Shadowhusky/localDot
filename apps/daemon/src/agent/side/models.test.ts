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

  it("goes from the fast model to the main one the user chose for this task, whoever runs them", () => {
    const both = sideModels(
      { kind: "api", roles: [role("main", LOCAL), role("fast", CLOUD)] },
      { api, plan },
    );
    expect(names(both)).toEqual(["fast:anthropic", "main:lmstudio"]);
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
});
