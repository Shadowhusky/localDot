import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createGzip, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CodexDownloadTransport,
  CodexInstallError,
  createCodexInstaller,
  VerifiedCodexInstaller,
} from "./install.ts";
import { prepareOwnedCodexRoots } from "./roots.ts";
import {
  CODEX_VERSION,
  type CodexReleaseManifest,
  codexBuild,
  codexRelease,
  MAX_EXPANDED_BYTES,
  releaseInstallKey,
  validateReleaseManifest,
} from "./version.ts";

type Entry = {
  name: string;
  body?: Buffer;
  type?: string;
  link?: string;
  declaredSize?: number;
  mutate?: (header: Buffer) => void;
};
const hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const archiveHash = (bytes: Buffer) => createHash("sha512").update(bytes).digest("base64");
const names = ["codex", "codex-code-mode-host"] as const;
const member = (name: string) => `package/vendor/aarch64-apple-darwin/bin/${name}`;
function ustar(entries: Entry[], end = true): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512),
      body = entry.body ?? Buffer.alloc(0);
    header.write(entry.name, 0, 100);
    const number = (from: number, length: number, value: number) =>
      header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, from, length);
    number(100, 8, 0o755);
    number(108, 8, 1000);
    number(116, 8, 1000);
    number(124, 12, entry.declaredSize ?? body.length);
    number(136, 12, 1);
    header.write(entry.type ?? "0", 156, 1);
    if (entry.link) header.write(entry.link, 157, 100);
    header.write("ustar", 257);
    header.write("00", 263);
    entry.mutate?.(header);
    header.fill(32, 148, 156);
    const sum = header.reduce((value, byte) => value + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  if (end) blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
const bodies = [
  Buffer.from("owned offline codex fixture\n"),
  Buffer.from("owned offline code-mode fixture\n"),
];
const regular = (): Entry[] =>
  names.map((name, index) => ({ name: member(name), body: bodies[index] }));
function manifest(bytes: Buffer): CodexReleaseManifest {
  return validateReleaseManifest({
    version: CODEX_VERSION,
    platform: "darwin-arm64",
    archive: {
      url: `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_VERSION}-darwin-arm64.tgz`,
      sha512: archiveHash(bytes),
      compressedBytes: bytes.length,
    },
    binaries: names.map((name, index) => ({
      member: member(name),
      installedName: name,
      sha256: hex(bodies[index] as Buffer),
      bytes: bodies[index]?.length,
    })),
  });
}
const owned: string[] = [];
function fixture(bytes = gzipSync(ustar(regular()))) {
  const top = mkdtempSync("/tmp/localdot-codex-install-");
  owned.push(top);
  mkdirSync(join(top, "user"), { mode: 0o700 });
  const roots = prepareOwnedCodexRoots(join(top, "app"), join(top, "user")),
    release = manifest(bytes);
  let calls = 0;
  const transport: CodexDownloadTransport = async (url) => {
    calls++;
    expect(url).toBe(release.archive.url);
    return { status: 200, contentLength: bytes.length, body: Readable.from([bytes]) };
  };
  const installer = new VerifiedCodexInstaller(roots, release, transport);
  return { top, roots, release, installer, transport, calls: () => calls, bytes };
}
afterEach(() => {
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;

describe("verified on-demand Codex installation", () => {
  it("status and local inspection never fetch, spawn or install; explicit installation is single-flight", async () => {
    const f = fixture();
    for (let i = 0; i < 20; i++) expect(f.installer.status()).toEqual({ state: "not_installed" });
    expect(await f.installer.verifiedInstallation(signal())).toBeUndefined();
    expect(f.calls()).toBe(0);
    expect(readdirSync(f.roots.binRoot)).toEqual([]);
    const owner = signal();
    const first = f.installer.ensureInstalled(owner),
      second = f.installer.ensureInstalled(signal());
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(f.calls()).toBe(1);
    expect(f.installer.status()).toEqual({ state: "ready", version: CODEX_VERSION });
    expect(a.binDir).toBe(join(f.roots.binRoot, releaseInstallKey(f.release)));
    expect(readdirSync(a.binDir).sort()).toEqual([...names].sort());
    expect(lstatSync(a.binDir).mode & 0o777).toBe(0o700);
    for (const [index, name] of names.entries()) {
      expect(lstatSync(join(a.binDir, name)).mode & 0o777).toBe(0o555);
      expect(readFileSync(join(a.binDir, name))).toEqual(bodies[index]);
    }
    const before = lstatSync(a.codexBin).mtimeMs;
    expect(await f.installer.ensureInstalled(signal())).toEqual(a);
    expect(lstatSync(a.codexBin).mtimeMs).toBe(before);
    expect(f.calls()).toBe(1);
    const ready = f.installer.status();
    ready.state = "verifying";
    expect(f.installer.status().state).toBe("ready");
  });
  it("uses only committed official platform pins and refuses unsupported platforms without fetching", async () => {
    const f = fixture(),
      installer = createCodexInstaller({ roots: f.roots, platform: "win32", arch: "x64" });
    expect(codexBuild("darwin", "arm64")?.codex).toBe(
      "4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc",
    );
    expect(codexRelease("linux", "x64")?.archive.compressedBytes).toBe(129654638);
    await expect(installer.ensureInstalled(signal())).rejects.toMatchObject({
      code: "unsupported_platform",
    });
    expect(await installer.verifiedInstallation(signal())).toBeUndefined();
    expect(readdirSync(f.roots.binRoot)).toEqual([]);
  });
  it.each([
    "redirect-url",
    "missing-hash",
    "wrong-member",
    "unknown-name",
    "oversize",
    "duplicate-name",
  ])("fails closed on manifest %s", (kind) => {
    const f = fixture(),
      invalid = structuredClone(f.release) as CodexReleaseManifest;
    if (kind === "redirect-url") invalid.archive.url = "https://example.com/codex.tgz";
    if (kind === "missing-hash") invalid.archive.sha512 = "";
    if (kind === "wrong-member") invalid.binaries[0].member = "../codex";
    if (kind === "unknown-name") invalid.binaries[0].installedName = "other" as "codex";
    if (kind === "oversize") invalid.archive.compressedBytes = 256 * 1024 * 1024 + 1;
    if (kind === "duplicate-name") invalid.binaries[1] = { ...invalid.binaries[0] };
    expect(() => new VerifiedCodexInstaller(f.roots, invalid, f.transport)).toThrow(
      CodexInstallError,
    );
    expect(f.calls()).toBe(0);
    expect(readdirSync(f.roots.binRoot)).toEqual([]);
  });
  it.each(["archive-hash", "member-hash", "short-body", "overrun", "length-header"])(
    "publishes nothing after %s integrity failure",
    async (kind) => {
      const f = fixture(),
        release = structuredClone(f.release);
      let reply = f.bytes,
        length: number | undefined = reply.length;
      if (kind === "archive-hash")
        release.archive.sha512 = archiveHash(Buffer.from("different archive"));
      if (kind === "member-hash") release.binaries[0].sha256 = hex(Buffer.from("different binary"));
      if (kind === "short-body") {
        reply = reply.subarray(0, reply.length - 1);
        length = undefined;
      }
      if (kind === "overrun") {
        reply = Buffer.concat([reply, Buffer.from("x")]);
        length = undefined;
      }
      if (kind === "length-header") length = reply.length + 1;
      const installer = new VerifiedCodexInstaller(f.roots, release, async () => ({
        status: 200,
        ...(length !== undefined ? { contentLength: length } : {}),
        body: Readable.from([reply]),
      }));
      await expect(installer.ensureInstalled(signal())).rejects.toMatchObject({
        code: "integrity_failed",
      });
      expect(installer.status()).toEqual({ state: "failed", code: "integrity_failed" });
      expect(readdirSync(f.roots.binRoot)).toEqual([]);
    },
  );
  it.each([301, 302, 307, 308, 404, 500])(
    "refuses HTTP %s without publishing or following a redirect",
    async (status) => {
      const f = fixture();
      let calls = 0;
      const installer = new VerifiedCodexInstaller(f.roots, f.release, async () => {
        calls++;
        return { status, body: Readable.from([]) };
      });
      await expect(installer.ensureInstalled(signal())).rejects.toMatchObject({
        code: "download_failed",
      });
      expect(calls).toBe(1);
      expect(readdirSync(f.roots.binRoot)).toEqual([]);
    },
  );
  it.each([
    "traversal",
    "absolute",
    "backslash",
    "nul-tail",
    "symlink",
    "hardlink",
    "device",
    "sparse",
    "pax",
    "duplicate",
    "binary-size",
    "non-octal-size",
    "bad-magic",
    "tar-truncated",
    "gzip-truncated",
    "after-end",
    "too-many",
  ])("rejects unsafe archive %s, including unselected members", async (kind) => {
    let entries = regular(),
      end = true;
    const unsafe: Entry = { name: "package/unselected", body: Buffer.from("ignored") };
    if (kind === "traversal") unsafe.name = "package/../../outside";
    if (kind === "absolute") unsafe.name = "/tmp/outside";
    if (kind === "backslash") unsafe.name = "package/..\\outside";
    if (kind === "nul-tail")
      unsafe.mutate = (header) => {
        header[80] = 65;
      };
    if (kind === "symlink") {
      unsafe.type = "2";
      unsafe.link = "/tmp/outside";
    }
    if (kind === "hardlink") {
      unsafe.type = "1";
      unsafe.link = member("codex");
    }
    if (kind === "device") unsafe.type = "3";
    if (kind === "sparse") unsafe.type = "S";
    if (kind === "pax") unsafe.type = "x";
    if (kind === "duplicate") unsafe.name = member("codex");
    if (kind === "binary-size")
      entries[0] = { ...(entries[0] as Entry), declaredSize: (bodies[0]?.length ?? 0) + 1 };
    if (kind === "non-octal-size")
      unsafe.mutate = (header) => {
        header[124] = 128;
      };
    if (kind === "bad-magic")
      unsafe.mutate = (header) => {
        header[257] = 65;
      };
    if (kind === "tar-truncated") end = false;
    if (kind === "too-many")
      entries = [
        ...entries,
        ...Array.from({ length: 4096 }, (_, index) => ({ name: `package/entry-${index}` })),
      ];
    else if (!["binary-size", "tar-truncated", "gzip-truncated", "after-end"].includes(kind))
      entries.push(unsafe);
    let tar = ustar(entries, end);
    if (kind === "after-end") tar = Buffer.concat([tar, ustar([{ name: "package/after" }])]);
    let bytes = gzipSync(tar);
    if (kind === "gzip-truncated") bytes = bytes.subarray(0, bytes.length - 5);
    const f = fixture(bytes);
    await expect(f.installer.ensureInstalled(signal())).rejects.toMatchObject({
      code: "unsafe_archive",
    });
    expect(readdirSync(f.roots.binRoot)).toEqual([]);
  });
  it("rejects a header checksum mismatch", async () => {
    const tar = ustar(regular());
    tar[265] = 65; // Change unused metadata, preserving both selected paths and body sizes.
    const f = fixture(gzipSync(tar));
    await expect(f.installer.ensureInstalled(signal())).rejects.toMatchObject({
      code: "unsafe_archive",
    });
    expect(readdirSync(f.roots.binRoot)).toEqual([]);
  });
  it("discards package metadata and scripts without executing or publishing them", async () => {
    const f = fixture(
      gzipSync(
        ustar([
          ...regular(),
          {
            name: "package/package.json",
            body: Buffer.from('{"scripts":{"postinstall":"must never run"}}'),
          },
          { name: "package/README.md", body: Buffer.from("unselected metadata") },
        ]),
      ),
    );
    const result = await f.installer.ensureInstalled(signal());
    expect(readdirSync(result.binDir).sort()).toEqual([...names].sort());
  });
  it("accepts npm's omitted UID/GID and space-terminated octal fields without trusting ownership", async () => {
    const entries = regular().map((entry) => ({
      ...entry,
      mutate: (header: Buffer) => {
        header.fill(0, 108, 124);
        header.write("000755 \0", 100, 8);
      },
    }));
    const f = fixture(gzipSync(ustar(entries)));
    const installed = await f.installer.ensureInstalled(signal());
    expect(lstatSync(installed.codexBin).uid).toBe(process.getuid?.());
    expect(lstatSync(installed.codexBin).mode & 0o777).toBe(0o555);
  });
  it.each(["owner", "explicit"])(
    "cancels the %s attempt and removes its exact staging without publishing",
    async (kind) => {
      const f = fixture(),
        owner = new AbortController();
      let entered!: () => void, release!: () => void;
      const begun = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        wait = new Promise<void>((resolve) => {
          release = resolve;
        });
      const installer = new VerifiedCodexInstaller(f.roots, f.release, async () => ({
        status: 200,
        body: Readable.from(
          (async function* () {
            yield f.bytes.subarray(0, 10);
            entered();
            await wait;
            yield f.bytes.subarray(10);
          })(),
        ),
      }));
      const pending = installer.ensureInstalled(owner.signal);
      const rejected = expect(pending).rejects.toMatchObject({ code: "cancelled" });
      await begun;
      if (kind === "owner") owner.abort();
      else installer.cancel();
      release();
      await rejected;
      expect(readdirSync(f.roots.binRoot)).toEqual([]);
      expect(installer.status()).toEqual({ state: "failed", code: "cancelled" });
    },
  );
  it("a concurrent caller aborts only its wait; shared install and status polls stay alive", async () => {
    const f = fixture();
    let entered!: () => void, release!: () => void;
    const begun = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      wait = new Promise<void>((resolve) => {
        release = resolve;
      });
    const installer = new VerifiedCodexInstaller(f.roots, f.release, async () => {
      entered();
      await wait;
      return { status: 200, body: Readable.from([f.bytes]) };
    });
    const first = installer.ensureInstalled(signal()),
      follower = new AbortController();
    const second = installer.ensureInstalled(follower.signal);
    const rejected = expect(second).rejects.toMatchObject({ code: "cancelled" });
    await begun;
    follower.abort();
    await rejected;
    for (let i = 0; i < 10; i++) installer.status();
    release();
    expect((await first).version).toBe(CODEX_VERSION);
    expect(installer.status().state).toBe("ready");
  });
  it("explicit cancel is idempotent and cancellation before start creates nothing", async () => {
    const f = fixture(),
      owner = new AbortController();
    owner.abort();
    f.installer.cancel();
    f.installer.cancel();
    await expect(f.installer.ensureInstalled(owner.signal)).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(f.calls()).toBe(0);
    expect(readdirSync(f.roots.binRoot)).toEqual([]);
  });
  it("keeps the prior verified install when a replacement digest fails", async () => {
    const f = fixture(),
      old = await f.installer.ensureInstalled(signal());
    const bad = structuredClone(f.release);
    bad.archive.sha512 = archiveHash(Buffer.from("new pin"));
    const replacement = new VerifiedCodexInstaller(f.roots, bad, f.transport);
    await expect(replacement.ensureInstalled(signal())).rejects.toMatchObject({
      code: "integrity_failed",
    });
    expect(readFileSync(old.codexBin)).toEqual(bodies[0]);
    expect(await f.installer.verifiedInstallation(signal())).toEqual(old);
    expect(readdirSync(f.roots.binRoot)).toEqual([releaseInstallKey(f.release)]);
  });
  it("rehashes installed binaries before launch and never silently repairs a corrupt immutable directory", async () => {
    const f = fixture(),
      installed = await f.installer.ensureInstalled(signal());
    chmodSync(installed.codexBin, 0o600);
    writeFileSync(installed.codexBin, "corrupt");
    chmodSync(installed.codexBin, 0o555);
    await expect(f.installer.verifiedInstallation(signal())).rejects.toMatchObject({
      code: "integrity_failed",
    });
    await expect(f.installer.ensureInstalled(signal())).rejects.toMatchObject({
      code: "integrity_failed",
    });
    expect(f.calls()).toBe(1);
    expect(readFileSync(installed.codexBin, "utf8")).toBe("corrupt");
  });
  it("storage failure publishes no executable and retains an unverifiable staging for recovery", async () => {
    const f = fixture();
    let staging = "";
    const installer = new VerifiedCodexInstaller(f.roots, f.release, async () => {
      staging = join(f.roots.binRoot, readdirSync(f.roots.binRoot)[0] as string);
      chmodSync(staging, 0o500);
      return { status: 200, body: Readable.from([f.bytes]) };
    });
    await expect(installer.ensureInstalled(signal())).rejects.toMatchObject({
      code: "storage_failed",
    });
    expect(existsSync(join(f.roots.binRoot, releaseInstallKey(f.release)))).toBe(false);
    expect(existsSync(join(staging, "codex"))).toBe(false);
    chmodSync(staging, 0o700);
  });
  it("rejects streamed decompression overrun within bounded memory", async () => {
    const block = Buffer.alloc(1024 * 1024),
      gzip = createGzip();
    const input = Readable.from(
      (async function* () {
        yield ustar(regular());
        for (let i = 0; i < MAX_EXPANDED_BYTES / block.length; i++) yield block;
      })(),
    );
    const chunks: Buffer[] = [];
    input.pipe(gzip);
    for await (const chunk of gzip) chunks.push(chunk as Buffer);
    const f = fixture(Buffer.concat(chunks));
    await expect(f.installer.ensureInstalled(signal())).rejects.toMatchObject({
      code: "unsafe_archive",
    });
    expect(readdirSync(f.roots.binRoot)).toEqual([]);
  }, 20000);
});
