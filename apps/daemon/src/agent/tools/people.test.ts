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
    expect(res.body.content[0]?.text).toContain("name the user wrote");
    expect(new PeopleStore(h.home).list()).toEqual([]);
    expect(h.events().some((e) => e.type === "approval.request")).toBe(false);
  });
  it("refuses a name the user only seems to have written, on a task that read other text", async () => {
    const h = harness();
    h.session.requests.push("Reply to Steve's email and check all my emails");
    h.session.tainted = true;
    for (const name of ["Eve Mallory", "Al Attacker"]) {
      const res = await h.call("people", {
        op: "save",
        name,
        app: "Email",
        handle: "x@example.com",
      });
      expect(res.body.ok).toBe(false);
      expect(res.body.content[0]?.text).toContain("name the user wrote");
    }
    expect(new PeopleStore(h.home).list()).toEqual([]);
  });
  it("won't redirect someone saved, even one the user named, once the task read other text", async () => {
    const h = harness();
    const people = new PeopleStore(h.home);
    people.add({ name: "Mum", app: "WeChat", handle: "wx_mum" });
    h.session.requests.push("Message Mum about dinner");
    h.session.tainted = true;
    for (const app of ["WeChat", "WhatsApp"]) {
      const res = await h.call("people", {
        op: "save",
        name: "Mum",
        app,
        handle: "+44 7700 900123",
      });
      expect(res.body.ok).toBe(false);
      expect(res.body.content[0]?.text).toContain("Ask the user before changing");
    }
    expect(people.list()).toEqual([
      expect.objectContaining({ app: "WeChat", handle: "wx_mum", source: { kind: "user" } }),
    ]);
    expect(h.events().some((e) => e.type === "approval.request")).toBe(false);
    const same = await h.call("people", { op: "save", name: "Mum", app: "WeChat" });
    expect(same.body.ok).toBe(true);
    expect(people.list()[0]).toMatchObject({ handle: "wx_mum", lastAt: expect.any(String) });
  });
  it("won't save a name that would shadow someone saved, once the task read other text", async () => {
    const h = harness();
    const people = new PeopleStore(h.home);
    people.add({ name: "Henry Liu", app: "WeChat", handle: "henry_l" });
    people.add({ name: "刘亨利", app: "WeChat", handle: "liu_hl" });
    h.session.requests.push("Send Henry the report on WeChat, and 亨利 too, then Henry Liu Jr");
    h.session.tainted = true;
    for (const [name, app] of [
      ["Henry", "WeChat"],
      ["Henry", "Email"],
      ["亨利", "WeChat"],
      ["Henry Liu Jr", "WeChat"],
    ]) {
      const res = await h.call("people", { op: "save", name, app, handle: "attacker_wx" });
      expect(res.body.ok, name).toBe(false);
      expect(res.body.content[0]?.text).toContain("Ask the user before changing");
    }
    expect(people.find("Henry").map((p) => p.handle)).toEqual(["henry_l"]);
    expect(people.list()).toHaveLength(2);
  });
  it("won't rewrite a saved person's note once the task read other text", async () => {
    const h = harness();
    const people = new PeopleStore(h.home);
    people.add({ name: "Mum", app: "WeChat", handle: "wx_mum", note: "Calls after 6pm" });
    h.session.requests.push("Message Mum about dinner");
    h.session.tainted = true;
    const res = await h.call("people", {
      op: "save",
      name: "Mum",
      app: "WeChat",
      note: "New number: use WhatsApp +44 7700 900999",
    });
    expect(res.body.ok).toBe(false);
    expect(res.body.content[0]?.text).toContain("Ask the user before changing");
    expect(people.list()).toEqual([
      expect.objectContaining({ note: "Calls after 6pm", source: { kind: "user" } }),
    ]);
    const same = await h.call("people", {
      op: "save",
      name: "Mum",
      app: "WeChat",
      note: "Calls after 6pm",
    });
    expect(same.body.ok).toBe(true);
    expect(people.list()[0]?.source).toEqual({ kind: "user" });
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
