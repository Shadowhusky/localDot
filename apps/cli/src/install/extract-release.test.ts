import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { withExtractedDependency, withExtractedRelease } from "./extract-release.ts";
import { paxLine, type TarEntry, tarBytes, tarChecksum } from "./testing/tar-fixture.ts";

const roots: string[] = [];
const signal = () => new AbortController().signal;
const hash = (bytes: Buffer, algorithm = "sha512") =>
  createHash(algorithm).update(bytes).digest("hex");
const entry: TarEntry = { name: "package/package.json", body: Buffer.from('{"name":"fixture"}') };

it("keeps native dylib limits separate from ordinary release members", async () => {
  const f = await fixture(
    tarBytes([{ name: "package/library.dylib", body: Buffer.alloc(16 * 1024 * 1024 + 1) }]),
  );
  await expect(withExtractedRelease(f.root, f, signal(), async () => {})).rejects.toThrow();
  await withExtractedDependency(f.root, f, signal(), async (extracted) => {
    expect(extracted.files["library.dylib"]?.bytes).toBe(16 * 1024 * 1024 + 1);
  });
  const large = await fixture(
    tarBytes([{ name: "package/too-large", size: 64 * 1024 * 1024 + 1 }]),
  );
  await expect(
    withExtractedDependency(large.root, large, signal(), async () => {}),
  ).rejects.toThrow();
});
async function fixture(raw: Buffer = tarBytes([entry]), compressed: Buffer = gzipSync(raw)) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-extract-")));
  roots.push(root);
  await chmod(root, 0o700);
  const archive = join(root, "input.tgz");
  await writeFile(archive, compressed, { mode: 0o400 });
  return { root, archive, sha512: hash(compressed) };
}
async function reject(raw: Buffer, compressed = gzipSync(raw)) {
  const f = await fixture(raw, compressed),
    work = vi.fn();
  await expect(withExtractedRelease(f.root, f, signal(), work)).rejects.toThrow("safely extracted");
  expect(work).not.toHaveBeenCalled();
  expect(await readdir(f.root)).toEqual(["input.tgz"]);
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("extracts exact regular bytes and safe executable modes then removes only its owned tree", async () => {
  const executable = Buffer.from("not executed");
  const f = await fixture(
    tarBytes([
      { name: "package", type: 53, mode: 0o755 },
      entry,
      { name: "package/bin/tool", mode: 0o755, body: executable },
    ]),
  );
  const result = await withExtractedRelease(f.root, f, signal(), async (extracted) => {
    expect(await readFile(join(extracted.root, "bin/tool"))).toEqual(executable);
    expect(extracted.files["bin/tool"]).toEqual({
      sha256: hash(executable, "sha256"),
      bytes: executable.length,
      mode: 0o700,
    });
    expect((await lstat(join(extracted.root, "bin/tool"))).mode & 0o7777).toBe(0o700);
    expect((await lstat(join(extracted.root, "package.json"))).mode & 0o7777).toBe(0o600);
    expect(Object.isFrozen(extracted.files)).toBe(true);
    return "ok";
  });
  expect(result).toBe("ok");
  expect(await readdir(f.root)).toEqual(["input.tgz"]);
});
it.each([
  "../escape",
  "package/../escape",
  "/absolute",
  "package//empty",
  "package/./dot",
  "package/back\\slash",
  "elsewhere/file",
  "package/.hidden",
  "package/é",
])("rejects unsafe path %s", async (name) => reject(tarBytes([{ ...entry, name }])));
it.each([49, 50, 51, 52, 54, 55, 83, 103, 75])(
  "rejects link, device, sparse and unsupported type %s",
  async (type) => reject(tarBytes([{ ...entry, type }])),
);
it.each([0o4755, 0o2755, 0o1755, 0o666])("refuses unsafe archive mode %s", async (mode) =>
  reject(tarBytes([{ ...entry, mode }])),
);
it.each([
  [entry, entry],
  [
    { name: "package/A/file", body: Buffer.from("a") },
    { name: "package/a/other", body: Buffer.from("b") },
  ],
  [
    { name: "package/A", body: Buffer.from("a") },
    { name: "package/a", body: Buffer.from("b") },
  ],
  [
    { name: "package/dir/file", body: Buffer.from("a") },
    { name: "package/dir", body: Buffer.from("b") },
  ],
  [
    { name: "package/file", body: Buffer.from("a") },
    { name: "package/file/child", body: Buffer.from("b") },
  ],
] as TarEntry[][])(
  "refuses duplicate, case-colliding and conflicting members %#",
  async (...entries) => reject(tarBytes(entries)),
);
it("accepts a real ustar prefix, GNU longname and bounded PAX path", async () => {
  const long = `package/${"a".repeat(80)}/${"b".repeat(80)}`;
  const raw = tarBytes([
    { name: "short", prefix: "package/directory", body: Buffer.from("prefix") },
    { name: "././@LongLink", type: 76, body: Buffer.from(`${long}\0`) },
    { name: "placeholder", body: Buffer.from("long") },
    {
      name: "PaxHeader",
      type: 120,
      body: Buffer.concat([paxLine("path", "package/from-pax"), paxLine("mtime", "1.5")]),
    },
    { name: "placeholder", body: Buffer.from("pax") },
  ]);
  const f = await fixture(raw);
  await withExtractedRelease(f.root, f, signal(), async (extracted) =>
    expect(Object.keys(extracted.files)).toEqual(["directory/short", long.slice(8), "from-pax"]),
  );
});

it("refuses an aliased package root directory", async () => {
  await reject(tarBytes([{ name: "package//", type: 53 }, entry]));
});

it("bounds the number of regular members", async () => {
  const entries = Array.from({ length: 4099 }, (_, index) => ({
    name: `package/file-${index}`,
  }));
  await reject(tarBytes(entries));
}, 15000);

it("cancels an in-progress extraction before exposing any tree", async () => {
  const f = await fixture(
    tarBytes([{ name: "package/large", body: Buffer.alloc(8 * 1024 * 1024) }]),
  );
  const controller = new AbortController(),
    work = vi.fn(),
    reason = new Error("stop");
  const operation = withExtractedRelease(f.root, f, controller.signal, work);
  // Observe real decompressed output before cancelling, rather than merely aborting a pending
  // parent-directory check. The stream must drain before owned scratch can be removed.
  await vi.waitFor(
    async () => {
      const directory = (await readdir(f.root)).find((name) => name.startsWith(".extract-"));
      expect(directory).toBeDefined();
      expect(
        (await lstat(join(f.root, directory ?? "missing", "archive.tar"))).size,
      ).toBeGreaterThan(0);
    },
    { interval: 1, timeout: 2000 },
  );
  controller.abort(reason);
  await expect(operation).rejects.toBe(reason);
  expect(work).not.toHaveBeenCalled();
  expect(await readdir(f.root)).toEqual(["input.tgz"]);
});

it("bounds implicit directory expansion before creating package members", async () => {
  const entries = Array.from({ length: 600 }, (_, index) => ({
    name: `package/p${index}/${Array.from({ length: 14 }, (_, i) => `d${i}`).join("/")}/file`,
  }));
  await reject(tarBytes(entries));
});
it.each([
  "checksum",
  "padding",
  "end",
  "truncated",
  "directory-data",
  "unused-directory",
  "huge-size",
  "base256",
  "non-ustar",
  "link-field",
  "dangling-extension",
  "duplicate-pax",
  "unknown-pax",
  "bad-pax-length",
  "pax-traversal",
])("rejects malformed tar %s", async (kind) => {
  let raw = tarBytes([entry]);
  if (kind === "checksum") raw[0] = (raw[0] ?? 0) ^ 1;
  if (kind === "padding") raw[512 + (entry.body?.length ?? 0)] = 1;
  if (kind === "end") raw = raw.subarray(0, raw.length - 512);
  if (kind === "truncated") raw = raw.subarray(0, 700);
  if (kind === "directory-data") raw = tarBytes([{ ...entry, type: 53 }]);
  if (kind === "unused-directory") raw = tarBytes([entry, { name: "package/unused", type: 53 }]);
  if (kind === "huge-size") raw = tarBytes([{ ...entry, size: 16 * 1024 * 1024 + 1 }]);
  if (kind === "base256") {
    raw[124] = 128;
    tarChecksum(raw.subarray(0, 512));
  }
  if (kind === "non-ustar") {
    raw.fill(0, 257, 263);
    tarChecksum(raw.subarray(0, 512));
  }
  if (kind === "link-field") {
    raw.write("target", 157);
    tarChecksum(raw.subarray(0, 512));
  }
  if (kind === "dangling-extension")
    raw = tarBytes([{ name: "pax", type: 120, body: paxLine("path", "package/x") }]);
  if (kind === "duplicate-pax")
    raw = tarBytes([
      {
        name: "pax",
        type: 120,
        body: Buffer.concat([paxLine("path", "package/x"), paxLine("path", "package/y")]),
      },
      entry,
    ]);
  if (kind === "unknown-pax")
    raw = tarBytes([{ name: "pax", type: 120, body: paxLine("GNU.sparse.map", "0,1") }, entry]);
  if (kind === "bad-pax-length")
    raw = tarBytes([{ name: "pax", type: 120, body: Buffer.from("99 path=package/x\n") }, entry]);
  if (kind === "pax-traversal")
    raw = tarBytes([{ name: "pax", type: 120, body: paxLine("path", "package/../x") }, entry]);
  await reject(raw);
});
it.each(["crc", "isize", "flags", "truncated", "concatenated", "trailing", "deflate-tail"])(
  "refuses invalid or ambiguous gzip %s",
  async (kind) => {
    const raw = tarBytes([entry]);
    let gzip = gzipSync(raw);
    if (kind === "crc") gzip[gzip.length - 8] = (gzip[gzip.length - 8] ?? 0) ^ 1;
    if (kind === "isize") gzip[gzip.length - 4] = (gzip[gzip.length - 4] ?? 0) ^ 1;
    if (kind === "flags") gzip[3] = 8;
    if (kind === "truncated") gzip = gzip.subarray(0, gzip.length - 4);
    if (kind === "concatenated") gzip = Buffer.concat([gzip, gzip]);
    if (kind === "trailing") gzip = Buffer.concat([gzip, Buffer.from("garbage")]);
    if (kind === "deflate-tail")
      gzip = Buffer.concat([gzip.subarray(0, -8), Buffer.from([0]), gzip.subarray(-8)]);
    await reject(raw, gzip);
  },
);
it("rejects a source whose bytes no longer match the authenticated compressed hash", async () => {
  const f = await fixture(),
    work = vi.fn();
  await expect(
    withExtractedRelease(f.root, { ...f, sha512: "0".repeat(128) }, signal(), work),
  ).rejects.toThrow();
  expect(work).not.toHaveBeenCalled();
  expect(await readdir(f.root)).toEqual(["input.tgz"]);
});
it("refuses linked or writable input and nonprivate parents", async () => {
  const f = await fixture(),
    work = vi.fn();
  await chmod(f.archive, 0o600);
  await expect(withExtractedRelease(f.root, f, signal(), work)).rejects.toThrow();
  await chmod(f.archive, 0o400);
  const link = join(f.root, "alias");
  await symlink(f.archive, link);
  await expect(
    withExtractedRelease(f.root, { ...f, archive: link }, signal(), work),
  ).rejects.toThrow();
  await chmod(f.root, 0o755);
  await expect(withExtractedRelease(f.root, f, signal(), work)).rejects.toThrow();
  expect(work).not.toHaveBeenCalled();
});
it("cleans on callback failure and preserves caller cancellation", async () => {
  const f = await fixture(),
    controller = new AbortController(),
    reason = new Error("stop");
  await expect(
    withExtractedRelease(f.root, f, signal(), async () => {
      throw new Error("callback");
    }),
  ).rejects.toThrow();
  await expect(
    withExtractedRelease(f.root, f, controller.signal, async () => {
      controller.abort(reason);
    }),
  ).rejects.toBe(reason);
  expect(await readdir(f.root)).toEqual(["input.tgz"]);
});
it("reads an actual offline npm pack including a long path without running lifecycle scripts", async () => {
  const f = await fixture(),
    source = join(f.root, "source"),
    long = `${"a".repeat(80)}/${"b".repeat(80)}.js`;
  await mkdir(join(source, "a".repeat(80)), { recursive: true });
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ name: "archive-fixture", version: "1.0.0", scripts: { prepack: "exit 97" } }),
  );
  await writeFile(join(source, long), "export default 1;\n");
  await writeFile(join(f.root, "user.npmrc"), "");
  await writeFile(join(f.root, "global.npmrc"), "");
  const { stdout } = await promisify(execFile)(
    "npm",
    [
      "pack",
      "--json",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--fund=false",
      "--update-notifier=false",
      `--cache=${f.root}/cache`,
      `--userconfig=${f.root}/user.npmrc`,
      `--globalconfig=${f.root}/global.npmrc`,
      `--pack-destination=${f.root}`,
    ],
    { cwd: source, env: { PATH: process.env.PATH, HOME: f.root, TMPDIR: f.root }, timeout: 30000 },
  );
  const archive = join(f.root, JSON.parse(stdout)[0].filename);
  await chmod(archive, 0o400);
  await withExtractedRelease(
    f.root,
    { archive, sha512: hash(await readFile(archive)) },
    signal(),
    async (extracted) => {
      expect(await readFile(join(extracted.root, long), "utf8")).toBe("export default 1;\n");
      expect(Object.keys(extracted.files)).toHaveLength(2);
    },
  );
}, 35000);
