import { afterEach, describe, expect, it } from "vitest";
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

describe("remember into daily notes", () => {
  it("saves to today's notes and records an undoable memory change", async () => {
    const h = harness();
    const res = await h.call("remember", {
      file: "notes",
      op: "append",
      text: "Insurer prefers email",
    });
    expect(res.body.ok).toBe(true);
    expect(res.body.content[0]?.text).toBe("Saved to today's notes.");
    const change = h.events().find((e) => e.type === "memory.change");
    expect(change?.type === "memory.change" && change.data.file).toMatch(
      /^notes\/\d{4}-\d{2}-\d{2}\.md$/,
    );
    expect(change?.type === "memory.change" && change.data.changeId).toBeTruthy();
  });
  it("refuses replace on daily notes", async () => {
    const h = harness();
    const res = await h.call("remember", {
      file: "notes",
      op: "replace",
      text: "x",
      old_text: "y",
    });
    expect(res.body.ok).toBe(false);
    expect(res.body.content[0]?.text).toContain("append-only");
  });
  // The user's answer to the question a tainted save raises, once it is up.
  async function answer(h: ReturnType<typeof harness>, choice: string) {
    for (let i = 0; i < 500 && !h.session.pendingAsk; i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const askId = h.session.pendingAsk;
    if (!askId) throw new Error("no question was asked");
    expect(h.session.answerFields(askId, { answer: choice }, (text) => text)).toBe(true);
  }
  const asked = (h: ReturnType<typeof harness>) =>
    h.events().flatMap((e) => (e.type === "ask.request" ? [e.data.question] : []));

  it("asks the user before a task that read outside words saves, and saves only on their yes", async () => {
    const h = harness();
    h.session.tainted = true;
    const saving = h.call("remember", { file: "notes", op: "append", text: "From a web page" });
    await answer(h, "Don't save");
    expect((await saving).body.ok).toBe(false);
    expect(asked(h)[0]).toContain("From a web page");
    expect(h.events().some((e) => e.type === "memory.change")).toBe(false);
    h.session.tainted = true;
    const again = h.call("remember", { file: "USER.md", op: "append", text: "- Likes tea" });
    await answer(h, "Save it");
    expect((await again).body.ok).toBe(true);
    expect(asked(h)[1]).toContain("what I remember about you");
    expect(h.events().filter((e) => e.type === "memory.change")).toHaveLength(1);
  });

  it("saves the user's own words from this task without asking, whatever it read since", async () => {
    const h = harness();
    h.session.requests.push("Remember: no empty line between the PR link and the title");
    h.session.tainted = true;
    const res = await h.call("remember", {
      file: "USER.md",
      op: "append",
      text: "- Prefers no empty line between the PR link and the title",
    });
    expect(res.body.ok).toBe(true);
    expect(asked(h)).toEqual([]);
    expect(h.session.tainted).toBe(true);
  });
});
