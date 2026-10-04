import { mkdtempSync, rmSync } from "node:fs";
import { DEFAULT_AUTONOMY, ulid } from "@localdot/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSession } from "../session.ts";
import { SettingsStore } from "../settings.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
it("settings edits persist for new sessions and cannot mutate the active frozen policy", () => {
  const home = mkdtempSync("/private/tmp/localdot-test-m5-settings-");
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
  const home = mkdtempSync("/private/tmp/localdot-test-m5-settings-");
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
