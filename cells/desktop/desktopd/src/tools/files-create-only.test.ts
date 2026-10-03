import {
  type linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { putFile } from "./files.ts";

const race = vi.hoisted(() => ({ beforeLink: null as null | ((target: string) => void) }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    linkSync: (source: Parameters<typeof linkSync>[0], target: Parameters<typeof linkSync>[1]) => {
      race.beforeLink?.(String(target));
      actual.linkSync(source, target);
    },
    renameSync: (
      source: Parameters<typeof renameSync>[0],
      target: Parameters<typeof renameSync>[1],
    ) => {
      race.beforeLink?.(String(target));
      actual.renameSync(source, target);
    },
  };
});
const homes: string[] = [];
afterEach(() => {
  race.beforeLink = null;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const home = () => {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "localdot-create-only-")));
  homes.push(h);
  mkdirSync(join(h, "Downloads"));
  return h;
};
const stream = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(Buffer.from(text));
      c.close();
    },
  });
describe("atomic create-only user attachments", () => {
  it("creates a new file and refuses a duplicate without replacing bytes or leaving a partial", async () => {
    const h = home();
    expect(
      await putFile(h, "Downloads/report.txt", stream("original"), undefined, 100, undefined, true),
    ).toEqual({ path: "~/Downloads/report.txt", bytes: 8 });
    await expect(
      putFile(h, "Downloads/report.txt", stream("replacement"), undefined, 100, undefined, true),
    ).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(join(h, "Downloads/report.txt"), "utf8")).toBe("original");
    expect(readdirSync(join(h, "Downloads"))).toEqual(["report.txt"]);
  });
  it("refuses an atomic publication race after the final destination check", async () => {
    const h = home();
    race.beforeLink = (target) => writeFileSync(target, "raced-file", { flag: "wx" });
    await expect(
      putFile(h, "Downloads/report.txt", stream("uploaded-file"), undefined, 100, undefined, true),
    ).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(join(h, "Downloads/report.txt"), "utf8")).toBe("raced-file");
    expect(readdirSync(join(h, "Downloads"))).toEqual(["report.txt"]);
  });
  it("aborts a pending create-only upload without publishing or retaining partial bytes", async () => {
    const h = home(),
      abort = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(Buffer.from("partial"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const pending = putFile(h, "Downloads/report.txt", body, undefined, 100, abort.signal, true);
    const rejected = expect(pending).rejects.toThrow();
    await Promise.resolve();
    abort.abort();
    await rejected;
    expect(cancelled).toBe(true);
    expect(readdirSync(join(h, "Downloads"))).toEqual([]);
  });
  it("preserves explicitly replacing file-tool behavior outside the user upload route", async () => {
    const h = home();
    writeFileSync(join(h, "Downloads/report.txt"), "old");
    await putFile(h, "Downloads/report.txt", stream("new"), undefined, 100);
    expect(readFileSync(join(h, "Downloads/report.txt"), "utf8")).toBe("new");
  });
});
