import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AUTONOMY, ulid } from "@localdot/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSession } from "../session.ts";
import { SettingsStore } from "../settings.ts";

const homes: string[] = [];
it("retains each configured model, including custom accounting, across saves and restart", () => {
  const home = mkdtempSync(join(tmpdir(), "localdot-test-models-"));
  homes.push(home);
  const store = new SettingsStore(home);
  const first = {
    provider: "custom",
    model: "my-model",
    key: "custom",
    plan: true as const,
    contextTokens: 65536,
  };
  const second = { provider: "chatgpt", model: "gpt-6-astra" };
  store.put({ main: first });
  store.put({ main: second });
  const restored = new SettingsStore(home).get();
  expect(restored.main).toEqual(second);
  expect(restored.models).toContainEqual(first);
  store.put({ ...restored, main: first });
  expect(store.get().main).toEqual(first);
  expect(store.get().models).toEqual([second]);
});
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
it("settings edits persist for new sessions and cannot mutate the active frozen policy", () => {
  const home = mkdtempSync(join(tmpdir(), "localdot-test-m5-settings-"));
  homes.push(home);
  const store = new SettingsStore(home);
  expect(store.get()).toEqual({});
  const log = { append: vi.fn() };
  const first = new AgentSession(ulid(), ulid(), "old task", log, store.get().autonomy);
  store.put({ autonomy: { ...DEFAULT_AUTONOMY, send: "act" } });
  const second = new AgentSession(ulid(), ulid(), "new task", log, store.get().autonomy);
  expect(first.autonomy.send).toBe("ask");
  expect(second.autonomy.send).toBe("act");
  expect(Object.isFrozen(first.autonomy)).toBe(true);
  expect(() => {
    (first as unknown as { autonomy: unknown }).autonomy = DEFAULT_AUTONOMY;
  }).toThrow();
  expect(log.append).not.toHaveBeenCalled();
});
it("session detaches even an otherwise valid mutable in-process policy input", () => {
  const policy = { ...DEFAULT_AUTONOMY };
  const session = new AgentSession(ulid(), ulid(), "task", { append: vi.fn() }, policy);
  policy.send = "act";
  expect(session.autonomy.send).toBe("ask");
  expect(() => {
    (session.autonomy as { send: string }).send = "act";
  }).toThrow();
});
it("invalid or inherited settings cannot overwrite the protected saved file", () => {
  const home = mkdtempSync(join(tmpdir(), "localdot-test-m5-settings-"));
  homes.push(home);
  const store = new SettingsStore(home);
  store.put({ autonomy: DEFAULT_AUTONOMY });
  expect(() =>
    store.put({ autonomy: { ...DEFAULT_AUTONOMY, credentials: "act" } } as never),
  ).toThrow("invalid agent settings");
  expect(() => store.put({ autonomy: Object.create(DEFAULT_AUTONOMY) })).toThrow(
    "invalid agent settings",
  );
  expect(store.get().autonomy).toEqual(DEFAULT_AUTONOMY);
});
it("a saved eight-class agent.json keeps loading, upgrades and saves the full policy", () => {
  const home = mkdtempSync(join(tmpdir(), "localdot-test-m5-settings-"));
  homes.push(home);
  const legacy = {
    reading: "act",
    browsing: "act",
    purchase: "ask",
    send: "act",
    post: "ask",
    delete: "ask",
    download_execute: "ask",
    system_settings: "ask",
  };
  writeFileSync(join(home, "agent.json"), `${JSON.stringify({ autonomy: legacy }, null, 2)}\n`, {
    mode: 0o600,
  });
  const store = new SettingsStore(home);
  const upgraded = { ...legacy, computer: "act", memory: "ask" };
  expect(store.get().autonomy).toEqual(upgraded);
  store.put(store.get());
  expect(JSON.parse(readFileSync(join(home, "agent.json"), "utf8")).autonomy).toEqual(upgraded);
});
