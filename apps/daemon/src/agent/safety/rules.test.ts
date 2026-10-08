import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AlwaysOption, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_RULES, RuleError, RulesStore } from "./rules.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "localdot-rules-"));
  homes.push(dir);
  return dir;
}
const MAIL = "https://mail.example.test";
const onMail: AlwaysOption = { scope: "site", label: "On mail.example.test", site: MAIL };
const inNotes: AlwaysOption = { scope: "app", label: "In Notes", app: "Notes" };
const always: AlwaysOption = { scope: "always", label: "Always" };

describe("saved Always allow rules", () => {
  it("saves a rule in a private rules.json and reads it back", () => {
    const dir = home();
    const store = new RulesStore(dir, () => 1700);
    const from = ulid();
    const rule = store.add("send", onMail, from);
    expect(rule).toMatchObject({
      behavior: "act",
      actionClass: "send",
      scope: "site",
      site: MAIL,
      label: "On mail.example.test",
      createdAt: 1700,
      createdFrom: from,
    });
    const file = join(dir, "rules.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, rules: [rule] });
    expect(new RulesStore(dir).list()).toEqual({ rules: [rule] });
  });

  it("matches a site rule on the exact origin only", () => {
    const store = new RulesStore(home());
    store.add("send", onMail, ulid());
    expect(store.matches("send", { site: MAIL })).toBe(true);
    for (const site of [
      "http://mail.example.test",
      "https://mail.example.test:8443",
      "https://www.mail.example.test",
      "https://example.test",
      "https://mail.example.test.evil.test",
      undefined,
    ])
      expect(store.matches("send", site === undefined ? {} : { site })).toBe(false);
    expect(store.matches("post", { site: MAIL })).toBe(false);
  });

  it("matches an app rule in that app only and an always rule everywhere for its class", () => {
    const store = new RulesStore(home());
    store.add("computer", inNotes, ulid());
    store.add("memory", always, ulid());
    expect(store.matches("computer", { app: "Notes" })).toBe(true);
    expect(store.matches("computer", { app: "Terminal" })).toBe(false);
    expect(store.matches("computer", {})).toBe(false);
    expect(store.matches("memory", {})).toBe(true);
    expect(store.matches("memory", { site: MAIL, app: "Notes" })).toBe(true);
    expect(store.matches("download_execute", {})).toBe(false);
  });

  it("refuses a scope its class does not offer", () => {
    const store = new RulesStore(home());
    expect(() => store.add("purchase", onMail, ulid())).toThrow();
    expect(() => store.add("upload", always, ulid())).toThrow();
    expect(() => store.add("unknown", always, ulid())).toThrow();
    expect(() => store.add("send", always, ulid())).toThrow();
    expect(() => store.add("credentials", always, ulid())).toThrow();
    expect(() => store.add("send", { scope: "task", label: "For this task" }, ulid())).toThrow();
    expect(store.list()).toEqual({ rules: [] });
  });

  it("keeps one rule per class and place", () => {
    const store = new RulesStore(home());
    const first = store.add("send", onMail, ulid());
    expect(store.add("send", onMail, ulid())).toEqual(first);
    expect(store.list().rules).toHaveLength(1);
  });

  it("stops matching a removed rule at once", () => {
    const store = new RulesStore(home());
    const rule = store.add("send", onMail, ulid());
    expect(store.remove(rule.id)).toEqual(rule);
    expect(store.matches("send", { site: MAIL })).toBe(false);
    expect(store.remove(rule.id)).toBeUndefined();
    expect(store.list()).toEqual({ rules: [] });
  });

  it("keeps at most 200 rules", () => {
    const dir = home();
    const store = new RulesStore(dir);
    for (let n = 0; n < MAX_RULES; n++)
      store.add(
        "send",
        { scope: "site", label: `On ${n}.example.test`, site: `https://${n}.example.test` },
        ulid(),
      );
    expect(store.list().rules).toHaveLength(MAX_RULES);
    expect(() => store.add("post", onMail, ulid())).toThrow(RuleError);
    expect(store.list().rules).toHaveLength(MAX_RULES);
    const saved = JSON.parse(readFileSync(join(dir, "rules.json"), "utf8"));
    saved.rules.push({ ...saved.rules[0], id: ulid(), site: MAIL });
    writeFileSync(join(dir, "rules.json"), JSON.stringify(saved), { mode: 0o600 });
    expect(store.list()).toMatchObject({ rules: [], error: expect.any(String) });
  });

  it.each([
    ["not JSON", "{"],
    ["a newer version", JSON.stringify({ version: 2, rules: [] })],
    ["an extra key", JSON.stringify({ version: 1, rules: [], owner: "x" })],
    [
      "a purchase rule",
      JSON.stringify({
        version: 1,
        rules: [
          {
            id: ulid(),
            behavior: "act",
            actionClass: "purchase",
            scope: "always",
            label: "Always",
            createdAt: 1,
            createdFrom: ulid(),
          },
        ],
      }),
    ],
    [
      "an upload site rule",
      JSON.stringify({
        version: 1,
        rules: [
          {
            id: ulid(),
            behavior: "act",
            actionClass: "upload",
            scope: "site",
            site: MAIL,
            label: "On mail.example.test",
            createdAt: 1,
            createdFrom: ulid(),
          },
        ],
      }),
    ],
    ["too large", JSON.stringify({ version: 1, rules: [], pad: "x".repeat(300 * 1024) })],
  ])("an unreadable rules.json (%s) relaxes nothing, blocks nothing and says so", (_, text) => {
    const dir = home();
    writeFileSync(join(dir, "rules.json"), text, { mode: 0o600 });
    const store = new RulesStore(dir);
    expect(store.list()).toEqual({ rules: [], error: expect.stringMatching(/could not be read/) });
    expect(store.matches("purchase", {})).toBe(false);
    expect(store.matches("upload", { site: MAIL })).toBe(false);
    expect(() => store.add("send", onMail, ulid())).toThrow(RuleError);
    expect(readFileSync(join(dir, "rules.json"), "utf8")).toBe(text);
  });

  it("treats a linked rules.json as unreadable", () => {
    const dir = home();
    const elsewhere = join(home(), "rules.json");
    writeFileSync(elsewhere, JSON.stringify({ version: 1, rules: [] }), { mode: 0o600 });
    symlinkSync(elsewhere, join(dir, "rules.json"));
    expect(new RulesStore(dir).list()).toMatchObject({ rules: [], error: expect.any(String) });
    expect(new RulesStore(dir).matches("send", { site: MAIL })).toBe(false);
  });

  it("reads nothing and creates nothing when the home is missing", () => {
    const dir = join(home(), "missing");
    const store = new RulesStore(dir);
    expect(store.list()).toEqual({ rules: [] });
    expect(store.matches("send", { site: MAIL })).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });
});
