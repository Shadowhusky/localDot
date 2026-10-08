import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { patchedSandboxFiles, verifySandboxArchive } from "./sandbox-integrity.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const PATCH = Buffer.from(
  "diff --git a/dist/cli.js b/dist/cli.js\n--- a/dist/cli.js\n+++ b/dist/cli.js\n" +
    "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n" +
    "diff --git a/dist/restricted.js b/dist/restricted.js\n--- /dev/null\n+++ b/dist/restricted.js\n" +
    "@@ -0,0 +1 @@\n+export const restricted = true;\n",
);
async function fixture(identity = "0.0.78") {
  const root = await mkdtemp(join(tmpdir(), "localdot-sandbox-archive-test-"));
  roots.push(root);
  const original = {
    "package.json": `${JSON.stringify({ name: "@anthropic-ai/sandbox-runtime", version: identity })}\n`,
    LICENSE: "fixture license\n",
    "dist/cli.js": "export const value = 1;\nexport const unchanged = true;\n",
    "vendor/java-proxy-agent/srt-proxy-agent.jar": "fixture jar bytes\n",
  };
  const archive = join(root, "input.tgz");
  const writer = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-c",
      `
import gzip,io,json,sys,tarfile
files=json.load(sys.stdin)
buffer=io.BytesIO()
with tarfile.open(fileobj=buffer,mode='w',format=tarfile.USTAR_FORMAT) as out:
 for name,text in files.items():
  data=text.encode();info=tarfile.TarInfo('package/'+name);info.size=len(data);info.mode=0o644
  out.addfile(info,io.BytesIO(data))
with open(sys.argv[1],'xb') as out: out.write(gzip.compress(buffer.getvalue(),mtime=0))
`,
      archive,
    ],
    { input: JSON.stringify(original), encoding: "utf8", timeout: 10_000 },
  );
  if (writer.status !== 0) throw new Error(writer.stderr);
  const source = join(root, "source"),
    files = new Map(Object.entries(original).map(([path, text]) => [path, Buffer.from(text)]));
  for (const [path, bytes] of patchedSandboxFiles(files, PATCH)) files.set(path, bytes);
  for (const [path, bytes] of files) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), bytes);
  }
  const expectedIntegrity = `sha512-${createHash("sha512")
    .update(await readFile(archive))
    .digest("base64")}`;
  const options = {
    archive,
    expectedIntegrity,
    source,
    patch: PATCH,
    readSource: (root, path) => readFile(join(root, path)),
  };
  return {
    ...options,
    files,
    verify: (extra = {}) => verifySandboxArchive({ ...options, ...extra }),
  };
}

it("verifies archive SRI and all runtime/asset bytes after exactly applying the source patch", async () => {
  const f = await fixture();
  expect(await f.verify()).toEqual({
    integrity: f.expectedIntegrity,
    checkedFiles: 5,
    patchedFiles: 2,
  });
});
it("refuses a wrong archive digest and a differently named release", async () => {
  const f = await fixture();
  await expect(
    f.verify({ expectedIntegrity: `sha512-${Buffer.alloc(64).toString("base64")}` }),
  ).rejects.toThrow("integrity mismatch");
  const wrong = await fixture("0.0.79");
  await expect(wrong.verify()).rejects.toThrow("archive identity");
});
it.each(["dist/cli.js", "LICENSE", "vendor/java-proxy-agent/srt-proxy-agent.jar"])(
  "rejects a modification outside patch hunks in %s",
  async (path) => {
    const f = await fixture();
    await writeFile(
      join(f.source, path),
      Buffer.concat([f.files.get(path), Buffer.from("unauthorized change\n")]),
    );
    await expect(f.verify()).rejects.toThrow("differs from pinned archive and patch");
  },
);
it("rejects additional runtime JavaScript that was neither in the archive nor added by the patch", async () => {
  const f = await fixture();
  await writeFile(join(f.source, "dist/extra.js"), "export {};\n");
  await expect(f.verify()).rejects.toThrow("Unexpected sandbox runtime source");
});
it("fails on missing input instead of fetching or substituting another archive", async () => {
  const f = await fixture();
  await rm(f.archive);
  await expect(f.verify()).rejects.toThrow();
});
it("does not fuzzily apply changed source or silently accept a pre-existing added file", () => {
  const input = new Map([["dist/cli.js", Buffer.from("export const value = 9;\n")]]);
  expect(() => patchedSandboxFiles(input, PATCH)).toThrow("pristine source");
  input.set("dist/cli.js", Buffer.from("export const value = 1;\n"));
  input.set("dist/restricted.js", Buffer.from("export {};\n"));
  expect(() => patchedSandboxFiles(input, PATCH)).toThrow("existence mismatch");
});
it("keeps untouched lines and original offsets across multiple growing and shrinking hunks", () => {
  const input = new Map([["dist/cli.js", Buffer.from("a\nb\nc\nd\ne\n")]]);
  const patch = Buffer.from(
    "diff --git a/dist/cli.js b/dist/cli.js\n--- a/dist/cli.js\n+++ b/dist/cli.js\n" +
      "@@ -1,2 +1,3 @@\n a\n-b\n+B\n+extra\n" +
      "@@ -4,2 +5 @@\n-d\n e\n",
  );
  expect(patchedSandboxFiles(input, patch).get("dist/cli.js").toString("utf8")).toBe(
    "a\nB\nextra\nc\ne\n",
  );
});
it.each([
  (text) => text.replace("+1 @@", "+2 @@"),
  (text) => text.replace("+1 @@", "+1,2 @@"),
  (text) => text.replaceAll("dist/restricted.js", "dist/../private.js"),
  (text) => `${text}\\ No newline at end of file\n`,
  (text) => text + text,
])("rejects inconsistent, escaping and duplicate patch input", (transform) => {
  const input = new Map([["dist/cli.js", Buffer.from("export const value = 1;\n")]]);
  expect(() =>
    patchedSandboxFiles(input, Buffer.from(transform(PATCH.toString("utf8")))),
  ).toThrow();
});
