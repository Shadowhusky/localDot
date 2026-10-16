import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  editFile,
  FileToolError,
  fetchFile,
  listDir,
  putFile,
  putUserFile,
  readFile,
  writeFile,
} from "./files.ts";

const owned: string[] = [];
afterEach(() => {
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});
function home() {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "local dot's files-")));
  owned.push(h);
  mkdirSync(join(h, "Documents"));
  return h;
}

describe("the files tool", () => {
  it("leaves the next file descriptor intact after verifying an already published upload", async () => {
    const h = home(),
      path = "Documents/upload.zip",
      content = Buffer.from("verified dataset"),
      expected = {
        bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      };
    writeFileSync(join(h, path), content);
    for (let i = 0; i < 32; i++) {
      const receipt = await putUserFile(
        h,
        path,
        new ReadableStream({ start: (controller) => controller.close() }),
        expected,
        new AbortController().signal,
      );
      expect(receipt).toEqual({ ...expected, path: `~/${path}` });
      const next = openSync(join(h, path), "r");
      try {
        // Allow the previous stream's asynchronous close to run after descriptor reuse.
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        expect(fstatSync(next).size).toBe(content.length);
      } finally {
        closeSync(next);
      }
    }
  });

  it("writes a new file and reports a create with its patch", () => {
    const h = home();
    const r = writeFile(h, "Documents/notes.md", "one\ntwo\n");
    expect(r).toMatchObject({ path: "~/Documents/notes.md", op: "create", bytes: 8 });
    expect(r.patch).toBe(
      "--- a/Documents/notes.md\n+++ b/Documents/notes.md\n@@ -0,0 +1,2 @@\n+one\n+two\n",
    );
    expect(readFileSync(join(h, "Documents/notes.md"), "utf8")).toBe("one\ntwo\n");
  });

  it("edits text that occurs exactly once, and refuses ambiguous or missing text", () => {
    const h = home();
    writeFile(h, "a.txt", "x = 1\ny = 1\n");
    expect(editFile(h, "a.txt", "x = 1", "x = 2")).toMatchObject({ op: "modify", path: "~/a.txt" });
    expect(readFileSync(join(h, "a.txt"), "utf8")).toBe("x = 2\ny = 1\n");
    expect(() => editFile(h, "a.txt", "= ", "=")).toThrow(/more than once/);
    expect(() => editFile(h, "a.txt", "z = 9", "")).toThrow(/does not occur/);
    expect(() => editFile(h, "nope.txt", "a", "b")).toThrow(FileToolError);
  });

  it("keeps a file's mode when it rewrites it", () => {
    const h = home();
    writeFileSync(join(h, "run.sh"), "echo 1\n", { mode: 0o755 });
    writeFile(h, "run.sh", "echo 2\n");
    expect(statSync(join(h, "run.sh")).mode & 0o777).toBe(0o755);
  });

  it("reads text, cuts it at maxBytes, and does not return binary content", () => {
    const h = home();
    writeFileSync(join(h, "big.txt"), "abcdef");
    expect(readFile(h, "big.txt", 3)).toMatchObject({
      content: "abc",
      bytes: 6,
      truncated: true,
      binary: false,
    });
    writeFileSync(join(h, "img.bin"), Buffer.from([0x89, 0x50, 0, 1]));
    expect(readFile(h, "img.bin", 100)).toMatchObject({ content: "", binary: true });
    expect(() => writeFile(h, "img.bin", "x")).toThrow(/binary/);
  });

  it("lists a folder with types and sizes", () => {
    const h = home();
    writeFileSync(join(h, "Documents", "b.txt"), "12");
    symlinkSync(join(h, "Documents", "b.txt"), join(h, "Documents", "a-link"));
    expect(listDir(h, "Documents")).toEqual({
      path: "~/Documents",
      entries: [
        { name: "a-link", type: "link", bytes: 0 },
        { name: "b.txt", type: "file", bytes: 2 },
      ],
      truncated: false,
    });
  });

  it("refuses to write through a symlink that leaves the home", () => {
    const h = home();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "outside-")));
    owned.push(outside);
    symlinkSync(outside, join(h, "out"));
    expect(() => writeFile(h, "out/x.txt", "x")).toThrow(/outside the home/);
    expect(() => writeFile(h, "/tmp/x.txt", "x")).toThrow(/outside the home/);
  });

  it("puts and fetches raw bytes, with a size cap on fetch", async () => {
    const h = home();
    expect(
      await putFile(h, "Downloads/report.pdf", bytesStream(Buffer.from("%PDF-1")), 0o600),
    ).toEqual({ path: "~/Downloads/report.pdf", bytes: 6 });
    expect(await new Response(fetchFile(h, "~/Downloads/report.pdf", 100)).text()).toBe("%PDF-1");
    expect(() => fetchFile(h, "Downloads/report.pdf", 3)).toThrow(/larger/);
  });
});

function bytesStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("file boundaries and streaming", () => {
  it("preserves mode despite a restrictive umask and leaves no temporary sibling", () => {
    const h = home();
    writeFileSync(join(h, "run"), "before");
    chmodSync(join(h, "run"), 0o755);
    const old = process.umask(0o077);
    try {
      writeFile(h, "run", "after");
    } finally {
      process.umask(old);
    }
    expect(statSync(join(h, "run")).mode & 0o777).toBe(0o755);
    expect(readdirSync(h).filter((name) => name.startsWith(".localdot-"))).toEqual([]);
  });
  it("keeps UTF-8 whole and detects binary bytes only within the sampled prefix", () => {
    const h = home();
    writeFileSync(join(h, "text"), "a中b");
    expect(readFile(h, "text", 3)).toMatchObject({ content: "a", truncated: true, binary: false });
    writeFileSync(join(h, "invalid"), Buffer.from([255]));
    expect(readFile(h, "invalid", 10)).toMatchObject({ content: "", binary: true });
    writeFileSync(join(h, "late-zero"), Buffer.concat([Buffer.alloc(9000, 65), Buffer.from([0])]));
    expect(readFile(h, "late-zero", 5)).toMatchObject({
      content: "AAAAA",
      binary: false,
      truncated: true,
    });
    expect(readFile(h, "late-zero", 9001)).toMatchObject({ content: "", binary: true });
    expect(() => writeFile(h, "late-zero", "rewrite")).toThrow(/binary/);
  });
  it("bounds whole-file write/edit validation and gives large files a compact diff", () => {
    const h = home();
    writeFileSync(join(h, "large"), "");
    truncateSync(join(h, "large"), 4 * 1024 * 1024 + 1);
    expect(() => writeFile(h, "large", "replace")).toThrow(/4 MiB/);
    expect(() => editFile(h, "large", "before", "after")).toThrow(/4 MiB/);
    expect(writeFile(h, "big-text", "x".repeat(512 * 1024 + 1)).patch).toContain(
      "too large to show",
    );
  });
  it("refuses empty, absent, and overlapping ambiguous edits", () => {
    const h = home();
    writeFile(h, "a", "aaa");
    expect(() => editFile(h, "a", "", "b")).toThrow(/empty/);
    expect(() => editFile(h, "a", "aa", "b")).toThrow(/more than once/);
    expect(readFile(h, "a", 10).content).toBe("aaa");
  });
  it("caps directory output and never follows child symlinks when listing", () => {
    const h = home();
    for (let i = 0; i < 501; i++) writeFileSync(join(h, "Documents", `f${i}`), "");
    const result = listDir(h, "Documents");
    expect(result.entries).toHaveLength(500);
    expect(result.truncated).toBe(true);
    symlinkSync(join(h, "missing"), join(h, "dangling"));
    expect(listDir(h, "~").entries.find((e) => e.name === "dangling")).toMatchObject({
      type: "link",
      bytes: 0,
    });
  });
  it("rejects traversal and escaping ancestors for every file operation", async () => {
    const h = home();
    const out = home();
    symlinkSync(out, join(h, "escape"));
    for (const path of ["../outside", "escape/new/file", "escape/../Documents/x"]) {
      for (const call of [
        () => readFile(h, path, 10),
        () => writeFile(h, path, "x"),
        () => editFile(h, path, "a", "b"),
        () => listDir(h, path),
        () => fetchFile(h, path),
      ])
        expect(call).toThrow(FileToolError);
      await expect(putFile(h, path, bytesStream(Buffer.from("x")))).rejects.toThrow(FileToolError);
    }
    expect(readdirSync(out)).toEqual(["Documents"]);
  });
  it("caps fetch while reading when the file grows after opening", async () => {
    const h = home();
    writeFileSync(join(h, "grow"), "abc");
    const stream = fetchFile(h, "grow", 4);
    appendFileSync(join(h, "grow"), "def");
    await expect(new Response(stream).arrayBuffer()).rejects.toMatchObject({ status: 413 });
  });
  it("cancels fetch on abort and permits exact-size raw transfers", async () => {
    const h = home();
    writeFileSync(join(h, "file"), "abcd");
    expect(await new Response(fetchFile(h, "file", 4)).text()).toBe("abcd");
    const abort = new AbortController();
    const stream = fetchFile(h, "file", 4, abort.signal);
    abort.abort(new Error("stopped"));
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow("stopped");
  });
  it("rejects a chunked over-limit upload without replacing the destination or leaving a temp file", async () => {
    const h = home();
    writeFileSync(join(h, "dest"), "keep");
    await expect(
      putFile(h, "dest", bytesStream(Buffer.from("abc"), Buffer.from("def")), undefined, 4),
    ).rejects.toMatchObject({ status: 413 });
    expect(readFileSync(join(h, "dest"), "utf8")).toBe("keep");
    expect(readdirSync(h).filter((name) => name.startsWith(".localdot-"))).toEqual([]);
  });
  it("aborts a pending upload, cancels its source, and removes a partial new file", async () => {
    const h = home();
    const abort = new AbortController();
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(Buffer.from("partial"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const promise = putFile(h, "new", source, undefined, 100, abort.signal);
    await Promise.resolve();
    abort.abort(new Error("stopped"));
    await expect(promise).rejects.toThrow("stopped");
    expect(cancelled).toBe(true);
    expect(existsSync(join(h, "new"))).toBe(false);
    expect(readdirSync(h)).toEqual(["Documents"]);
  });
  it("keeps the existing file intact on source failure", async () => {
    const h = home();
    writeFileSync(join(h, "dest"), "keep");
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error("source failed"));
      },
    });
    await expect(putFile(h, "dest", source)).rejects.toThrow("source failed");
    expect(readFileSync(join(h, "dest"), "utf8")).toBe("keep");
    expect(readdirSync(h).sort()).toEqual(["Documents", "dest"]);
  });

  it("refuses a destination replaced while an upload is pending and removes its temporary file", async () => {
    const h = home();
    writeFileSync(join(h, "dest"), "original");
    let upload!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        upload = c;
        c.enqueue(Buffer.from("upload"));
      },
    });
    const pending = putFile(h, "dest", source);
    await Promise.resolve();
    renameSync(join(h, "dest"), join(h, "old"));
    writeFileSync(join(h, "dest"), "new owner");
    upload.close();
    await expect(pending).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(join(h, "dest"), "utf8")).toBe("new owner");
    expect(readdirSync(h).sort()).toEqual(["Documents", "dest", "old"]);
  });

  it("refuses non-regular destinations and supports internal links without modifying the link", async () => {
    const h = home();
    for (const call of [
      () => readFile(h, "Documents", 10),
      () => fetchFile(h, "Documents"),
      () => writeFile(h, "Documents", "x"),
    ])
      expect(call).toThrow(/regular file/);
    await expect(putFile(h, "Documents", bytesStream(Buffer.from("x")))).rejects.toThrow(
      /regular file/,
    );
    writeFileSync(join(h, "real"), "hello");
    symlinkSync(join(h, "real"), join(h, "alias"));
    expect(readFile(h, "alias", 20).content).toBe("hello");
    writeFile(h, "alias", "updated");
    expect(readFileSync(join(h, "real"), "utf8")).toBe("updated");
    expect(listDir(h, "~").entries.find((e) => e.name === "alias")?.type).toBe("link");
  });
});
