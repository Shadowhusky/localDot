import {
  appendFileSync,
  mkdtempSync,
  readSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "./files.ts";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readSync: vi.fn(fs.readSync) };
});

const owned: string[] = [];
afterEach(() => {
  vi.mocked(readSync).mockClear();
  for (const home of owned.splice(0)) rmSync(home, { recursive: true, force: true });
});
function home() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "localdot-file-prefix-")));
  owned.push(path);
  return path;
}
function bytesRead() {
  return vi.mocked(readSync).mock.results.reduce((total, result) => {
    expect(result.type).toBe("return");
    return total + Number(result.value);
  }, 0);
}

describe("bounded file prefix reads", () => {
  it("reads a 16-byte prefix of a 5 MiB sparse log with exactly 16 bytes of I/O", () => {
    const h = home();
    writeFileSync(join(h, "large.log"), "abcdefghijklmnop");
    truncateSync(join(h, "large.log"), 5 * 1024 * 1024);
    expect(readFile(h, "large.log", 16)).toEqual({
      path: "~/large.log",
      content: "abcdefghijklmnop",
      bytes: 5 * 1024 * 1024,
      truncated: true,
      binary: false,
    });
    expect(bytesRead()).toBe(16);
  });

  it("reads only the continuation bytes needed at a UTF-8 cut and never returns a split character", () => {
    const h = home();
    for (const [text, cap, content, read] of [
      ["a中b", 2, "a", 4],
      ["a中b", 3, "a", 4],
      ["a🙂b", 2, "a", 5],
      ["a🙂b", 5, "a🙂", 5],
    ] as const) {
      vi.mocked(readSync).mockClear();
      writeFileSync(join(h, "utf8"), text);
      expect(readFile(h, "utf8", cap)).toMatchObject({ content, binary: false, truncated: true });
      expect(bytesRead()).toBe(read);
      expect(bytesRead()).toBeLessThanOrEqual(cap + 3);
    }
    for (const bytes of [Buffer.from([0x61, 0xe4, 0xb8]), Buffer.from([0x61, 0xe4, 0x62])]) {
      vi.mocked(readSync).mockClear();
      writeFileSync(join(h, "invalid"), bytes);
      expect(readFile(h, "invalid", 2)).toMatchObject({ content: "", binary: true });
      expect(bytesRead()).toBeLessThanOrEqual(5);
    }
  });

  it("reports growth after opening without reading beyond the requested prefix", async () => {
    const h = home();
    const path = join(h, "growing.log");
    writeFileSync(path, "abcdefghijklmnop");
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(readSync).mockImplementationOnce(((...args: Parameters<typeof readSync>) => {
      const result = fs.readSync(...args);
      appendFileSync(path, Buffer.alloc(1024 * 1024, 65));
      return result;
    }) as typeof readSync);
    expect(readFile(h, "growing.log", 16)).toMatchObject({
      content: "abcdefghijklmnop",
      bytes: 16 + 1024 * 1024,
      truncated: true,
      binary: false,
    });
    expect(bytesRead()).toBe(16);
  });
});
