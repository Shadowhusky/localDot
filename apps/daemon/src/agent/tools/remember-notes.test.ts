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
  it("refuses daily notes on a tainted task", async () => {
    const h = harness();
    h.session.tainted = true;
    const res = await h.call("remember", { file: "notes", op: "append", text: "From a web page" });
    expect(res.body.ok).toBe(false);
    expect(h.events().some((e) => e.type === "memory.change")).toBe(false);
  });
});
