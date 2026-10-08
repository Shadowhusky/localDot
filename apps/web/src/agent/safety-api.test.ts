// @vitest-environment jsdom
import type { AutonomyRule } from "@localdot/protocol";
import { expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { ControlFailure } from "./control-api.ts";
import { loadRules, removeAllowance, removeRule } from "./safety-api.ts";

const SESSION = "01J00000000000000000000002",
  RULE = "01J00000000000000000000009";
const setup = (body?: unknown) => {
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response(body === undefined ? null : JSON.stringify(body), { status: 200 }),
  );
  return { fetchImpl, api: createApi("fixture", { origin: "https://owned.invalid", fetchImpl }) };
};
const signal = new AbortController().signal;
const rule = (n: number): AutonomyRule => ({
  id: `01J0000000000000000000${String(n).padStart(4, "0")}`,
  behavior: "act",
  actionClass: "send",
  scope: "site",
  site: "https://mail.example.test",
  label: "On mail.example.test",
  createdAt: 1,
  createdFrom: "01J00000000000000000000003",
});

it("removes only a rule or allowance named by a real id and class", () => {
  const { fetchImpl, api } = setup();
  for (const id of ["reset", `${RULE}/../reset`, RULE.toLowerCase().replace("j", "!")])
    expect(() => removeRule(api, id, signal)).toThrow(ControlFailure);
  for (const actionClass of ["nonsense", "send/../reset", ""])
    expect(() => removeAllowance(api, SESSION, actionClass, signal)).toThrow(ControlFailure);
  expect(() => removeAllowance(api, "../rules", "send", signal)).toThrow(ControlFailure);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("reads at most 200 rules and nothing it does not expect", async () => {
  const most = Array.from({ length: 200 }, (_, n) => rule(n));
  expect((await loadRules(setup({ rules: most }).api, signal)).rules).toHaveLength(200);
  await expect(loadRules(setup({ rules: [...most, rule(200)] }).api, signal)).rejects.toThrow();
  await expect(loadRules(setup({ rules: [], extra: true }).api, signal)).rejects.toThrow();
  await expect(
    loadRules(setup({ rules: [{ ...rule(1), extra: true }] }).api, signal),
  ).rejects.toThrow();
});
