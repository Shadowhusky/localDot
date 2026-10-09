import { afterEach, describe, expect, it } from "vitest";
import { PeopleStore } from "../people.ts";
import { toolHarness } from "../testing/harness.ts";

const fixtures: ReturnType<typeof toolHarness>[] = [];
afterEach(() => {
  for (const h of fixtures.splice(0)) h.close();
});
function harness() {
  const h = toolHarness();
  fixtures.push(h);
  return h;
}

describe("people", () => {
  it("saves someone the user named, then finds them as untrusted data that taints the task", async () => {
    const h = harness();
    h.session.requests.push("Send Henry the report on WeChat");
    const saved = await h.call("people", {
      op: "save",
      name: "Henry Liu",
      app: "WeChat",
      handle: "henry_l",
    });
    expect(saved.body.ok).toBe(true);
    expect(saved.body.content[0]?.text).toBe("Saved Henry Liu (WeChat).");
    expect(new PeopleStore(h.home).list()).toEqual([
      expect.objectContaining({
        name: "Henry Liu",
        app: "WeChat",
        handle: "henry_l",
        source: { kind: "task", sessionId: h.session.id },
        lastAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      }),
    ]);
    expect(h.session.tainted).toBe(false);
    const found = await h.call("people", { op: "find", query: "henry" });
    const out = found.body.content[0]?.text ?? "";
    expect(out).toMatch(/^<untrusted source="people the user reaches">\n/);
    expect(out).toContain("Henry Liu · WeChat: henry_l · last ");
    expect(h.session.tainted).toBe(true);
    expect(h.session.taint.sources).toEqual([{ kind: "memory", origin: "people" }]);
    expect(h.session.taint.overlap("henry_l").overlaps).toBe(false);
    expect(h.session.taint.overlap("message Henry Liu WeChat henry_l").overlaps).toBe(true);
  });
  it("refuses to save someone the user never named once the task has read other text", async () => {
    const h = harness();
    h.session.tainted = true;
    const res = await h.call("people", {
      op: "save",
      name: "Mallory",
      app: "Email",
      handle: "mallory@example.com",
    });
    expect(res.body.ok).toBe(false);
    expect(res.body.content[0]?.text).toContain("named them");
    expect(new PeopleStore(h.home).list()).toEqual([]);
    expect(h.events().some((e) => e.type === "approval.request")).toBe(false);
  });
  it("says when no one matches, and asks for what it needs", async () => {
    const h = harness();
    const none = await h.call("people", { op: "find", query: "nobody" });
    expect(none.body.content[0]?.text).toContain("No one by that name yet.");
    expect(h.session.taint.tainted).toBe(false);
    expect((await h.call("people", { op: "find" })).body.ok).toBe(false);
    expect((await h.call("people", { op: "save", name: "Henry" })).body.ok).toBe(false);
  });
  it("puts the contact on the approval card when memory asks first", async () => {
    const h = harness();
    h.session.requests.push("Email Ana");
    await h.call("people", { op: "save", name: "Ana", app: "Email", handle: "ana@example.com" });
    const card = h.events().find((e) => e.type === "approval.request");
    expect(JSON.stringify(card)).toContain("ana@example.com");
  });
});
