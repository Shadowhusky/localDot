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
describe("done offers the previews its turn left running", () => {
  it("carries them on the result, with a page's words redacted", async () => {
    const h = setup();
    const offers = vi.fn(async () => [
      { port: 5173, url: "http://localhost:5173/", title: "Shop", project: "shop", name: "node" },
    ]);
    h.tools.previewOffers = offers;
    await h.call("done", { summary: "See localhost:5173." });
    expect(offers).toHaveBeenCalledWith(h.session.id, "See localhost:5173.");
    const result = h.events().find((e) => e.type === "task.result");
    expect(result?.type === "task.result" && result.data.previews).toEqual([
      { port: 5173, url: "http://localhost:5173/", title: "Shop", project: "shop", name: "node" },
    ]);
  });

  it("finishes the turn when they can't be read, and adds nothing when there are none", async () => {
    const h = setup();
    h.tools.previewOffers = async () => {
      throw new Error("the computer stopped");
    };
    await h.call("done", { summary: "Done." });
    h.tools.previewOffers = async () => [];
    await h.call("done", { summary: "Done again." });
    const results = h.events().filter((e) => e.type === "task.result");
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.type === "task.result" && !e.data.previews)).toBe(true);
  });
});

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
  it("keeps a file's name in any script, and only what a name can't hold becomes _", async () => {
    const h = setup();
    h.desktop.files.set("Documents/季度报告 v2.docx", "report");
    h.desktop.files.set("Documents/notes:draft?.txt", "notes");
    await h.call("done", {
      summary: "Done.",
      files: ["Documents/季度报告 v2.docx", "Documents/notes:draft?.txt"],
    });
    const result = h.events().find((e) => e.type === "task.result");
    const names = result?.type === "task.result" ? result.data.files.map((f) => f.name) : [];
    expect(names).toEqual(["季度报告 v2.docx", "notes_draft_.txt"]);
    expect(
      readFileSync(join(h.home, outputPath(h.session.id, "季度报告 v2.docx", 1) as string), "utf8"),
    ).toBe("report");
  });
  it("collects a video for Files and keeps the task open if collection fails", async () => {
    const h = setup();
    const path = "/config/Desktop/promo/film.mp4";
    const fetch = vi.spyOn(h.tools, "desktop").mockReturnValueOnce(undefined);
    const input = { summary: "Video delivered.", files: [path] };
    const failed = await h.call("done", input);
    expect(failed.body.ok).toBe(false);
    expect(failed.body.final).not.toBe(true);
    expect(h.events().filter((e) => e.type === "task.result")).toHaveLength(0);
    fetch.mockRestore();
    h.desktop.files.set(path, "video fixture bytes");
    const result = await h.call("done", input);
    expect(result.body).toMatchObject({ ok: true, final: true });
    const handed = h.events().find((e) => e.type === "task.result");
    expect(handed?.data).toMatchObject({
      files: [{ name: "film.mp4", path, bytes: 19, version: 1 }],
    });
    expect(
      readFileSync(join(h.home, outputPath(h.session.id, "film.mp4", 1) as string), "utf8"),
    ).toBe("video fixture bytes");
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
