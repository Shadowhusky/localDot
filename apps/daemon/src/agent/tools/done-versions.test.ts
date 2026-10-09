import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputStore, outputPath } from "../output-store.ts";
import { PROXY_TOKEN, toolHarness } from "../testing/harness.ts";

const harnesses: ReturnType<typeof toolHarness>[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.close();
});
function setup() {
  const h = toolHarness();
  harnesses.push(h);
  const store = new OutputStore(h.home);
  vi.spyOn(h.tools, "saveOutput").mockImplementation((id, name, source, scope) =>
    store.save(id, name, source, scope),
  );
  return h;
}
describe("done hands over versioned files", () => {
  it("numbers a file returned twice in one task as v1 and v2 and keeps both", async () => {
    const h = setup();
    h.desktop.files.set("Documents/totals.csv", "Month,Net\nDec,12000\n");
    await h.call("done", { summary: "First pass.", files: ["Documents/totals.csv"] });
    h.desktop.files.set("Documents/totals.csv", "Month,Net\nDec,12311\n");
    await h.call("done", { summary: "Revised.", files: ["Documents/totals.csv"] });
    const results = h.events().filter((e) => e.type === "task.result");
    expect(results.map((e) => e.type === "task.result" && e.data.files[0]?.version)).toEqual([
      1, 2,
    ]);
    expect(
      readFileSync(join(h.home, outputPath(h.session.id, "totals.csv", 1) as string), "utf8"),
    ).toContain("12000");
    expect(
      readFileSync(join(h.home, outputPath(h.session.id, "totals.csv", 2) as string), "utf8"),
    ).toContain("12311");
  });
  it("records what dot checked just before the result, redacted and short", async () => {
    const h = setup();
    await h.call("done", { summary: "Done.", checked: `opens, 4 sheets ${PROXY_TOKEN}` });
    const events = h.events();
    const verify = events.findIndex((e) => e.type === "step.verify");
    const result = events.findIndex((e) => e.type === "task.result");
    expect(verify).toBeGreaterThan(-1);
    expect(result).toBe(verify + 1);
    const data = events[verify]?.type === "step.verify" ? events[verify].data : undefined;
    expect(data?.status).toBe("success");
    expect(data?.evidence).toMatch(/^opens, 4 sheets/);
    expect(JSON.stringify(events)).not.toContain(PROXY_TOKEN);
  });
  it("adds no check when dot says nothing about one", async () => {
    const h = setup();
    await h.call("done", { summary: "Done." });
    expect(h.events().some((e) => e.type === "step.verify")).toBe(false);
  });
});
